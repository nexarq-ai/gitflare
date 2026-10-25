import type { ModelConnection, ModelUsage } from '../../shared/types';
import { defaultModelConnections, resolveModelConnection, DEFAULT_MODEL } from '../model-config';
import { inferenceMessage, ModelHttpError, ModelLocationError, ModelResponseError, ModelTimeoutError, type InputItem, type ModelMessage } from '../model-adapter';
import { AGENT_BUDGET_MS } from '../budgets';
import { DEFAULT_EDITABLE, type RepositoryPolicy } from '../repository-policy';
import { agentRules, agentSystemPrompt } from '../agent-rules';
import { outputLimit } from '../check-evidence';
import type { SandboxRunner, ExecutionEnv } from './environment';
import { VIEW_TOOL, type ToolImage, type ToolOutput } from '../visual/agent-view';

export function selectedModel(env: ExecutionEnv, models = defaultModelConnections()): string {
  return resolveModelConnection(models, env.MODEL ?? DEFAULT_MODEL).id;
}

const shellTool = { type: 'function', name: 'shell', description: 'Run one bash command in the isolated repository (working directory /workspace/repo, 45 s limit, output truncated). Use it to read and write files, inspect git status and diff, and run tests. No network access.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false }, strict: true };

const teamTool = { type: 'function', name: 'team_status', description: 'See what the other agents on this mission are assigned, which files each has touched so far, and which of those overlap with yours. Optionally share a one-line note describing what you are about to change and why.', parameters: { type: 'object', properties: { note: { type: ['string', 'null'] } }, required: ['note'], additionalProperties: false }, strict: true };

const noArguments = { type: 'object', properties: {}, required: [], additionalProperties: false };

const installTool = { type: 'function', name: 'install_dependencies', description: 'Install the dependencies declared in the working-tree package.json with the repository package manager through Gitflare\'s registry-only proxy, with lifecycle scripts disabled. Returns success, or the first installer error lines (for example the npm ERESOLVE block) so you can fix package.json. Lockfile changes are discarded; Gitflare regenerates the lockfile after you finish.', parameters: noArguments, strict: true };

const testsTool = { type: 'function', name: 'run_tests', description: 'Run the check Gitflare will run on your candidate, in your working tree, and return the exit code, a failure summary and the end of the output. Call install_dependencies first if you changed dependencies.', parameters: noArguments, strict: true };

const viewTool = { type: 'function', name: VIEW_TOOL, description: 'Start the repository preview from your working tree (or restart it after a build) and capture screenshots of routes at desktop (1280px) and mobile (390px) widths in light and dark themes. Returns the images plus, for each one, the page outline, console errors and layout overflow. Call it after changing anything a user sees, and again before you finish. routes: absolute paths (default: the configured routes); restart: true after you change build output or the server.', parameters: { type: 'object', properties: { routes: { type: ['array', 'null'], items: { type: 'string' } }, viewports: { type: ['array', 'null'], items: { type: 'string', enum: ['desktop', 'mobile'] } }, themes: { type: ['array', 'null'], items: { type: 'string', enum: ['light', 'dark'] } }, restart: { type: ['boolean', 'null'] } }, required: ['routes', 'viewports', 'themes', 'restart'], additionalProperties: false }, strict: true };

export interface TeamBoard { status(note?: string): Promise<string> }

export interface AgentWorkspace { install(remainingMs: number): Promise<string>; test(remainingMs: number): Promise<string>; view?(raw: string, remainingMs: number): Promise<ToolOutput> }

export interface AgentLoopOptions { independent?: boolean; starter?: boolean; untested?: boolean; editable?: string[]; policy?: RepositoryPolicy; workspace?: AgentWorkspace; team?: TeamBoard; afterCommand?: () => Promise<void>; maxTurns?: number; budgetMs?: number; modelAnswerMs?: number; modelRetries?: number; onModelCall?: (usage: ModelUsage | undefined) => void; onModelRetry?: (message: string) => Promise<void> }

export function agentLoopPrompt(options: AgentLoopOptions = {}): string {
  const policy = options.policy ?? { editable: options.editable ?? DEFAULT_EDITABLE, starter: !!options.starter, untested: !!options.untested, install: null, testCommand: '' };
  return agentSystemPrompt(agentRules(policy, { independent: options.independent, team: !!options.team, tools: !!options.workspace, view: !!options.workspace?.view }));
}

export function modelAcceptsImages(model: Pick<ModelConnection, 'id' | 'protocol'>): boolean {
  return model.protocol === 'anthropic' || model.protocol === 'responses';
}

export function imageItem(callId: string, images: ToolImage[]): InputItem {
  const text = `Screenshots from ${VIEW_TOOL} call ${callId} (${images.length} image${images.length === 1 ? '' : 's'}). ${images.map((image, index) => `Image ${index + 1}: ${image.label}`).join('; ')}`;
  return { role: 'user', content: [{ type: 'input_text', text }, ...images.map((image) => ({ type: 'input_image', image_url: `data:${image.mimeType};base64,${image.data}`, detail: 'auto' }))] };
}

const IMAGE_NOTE = /^Screenshots from view_ui call (\S+) /;

export function pruneImages(messages: InputItem[]): void {
  const bearing = messages.filter((item) => item.role === 'user' && Array.isArray(item.content) && item.content.some((part) => (part as { type?: string }).type === 'input_image'));
  for (const item of bearing.slice(0, -1)) {
    const first = (item.content as { text?: string }[])[0]?.text ?? '';
    const callId = IMAGE_NOTE.exec(first)?.[1] ?? 'earlier';
    item.content = `Screenshots from ${VIEW_TOOL} call ${callId} were removed to save context; call ${VIEW_TOOL} again to see the current state.`;
  }
}

const DEFAULT_MAX_TURNS = 16;

const MIN_MAX_TURNS = 1;

export const MAX_MAX_TURNS = 32;

export async function runAgentLoop(env: ExecutionEnv, sandbox: SandboxRunner, prompt: string, isActive: () => Promise<boolean>, onTool: (text: string) => Promise<void> = async () => {}, model: ModelConnection = resolveModelConnection(defaultModelConnections(), selectedModel(env)), options: AgentLoopOptions = {}): Promise<string> {
  const budgetMs = options.budgetMs ?? AGENT_BUDGET_MS;
  const deadline: AgentClock = { at: Date.now() + budgetMs, ms: budgetMs };
  const maxTurns = Math.min(MAX_MAX_TURNS, Math.max(MIN_MAX_TURNS, Math.trunc(options.maxTurns ?? DEFAULT_MAX_TURNS)));
  const messages: InputItem[] = [
    { role: 'system', content: agentLoopPrompt(options) },
    { role: 'user', content: prompt },
  ];
  const tools = [shellTool, ...(options.team ? [teamTool] : []), ...(options.workspace ? [installTool, testsTool] : []), ...(options.workspace?.view ? [viewTool] : [])];
  const vision = modelAcceptsImages(model);
  let lastToolSucceeded = false;
  let continuations = 0;
  let continuing = false;
  for (let turn = 0; turn < maxTurns; turn++) {
    if (!await isActive()) throw new Error('Mission cancelled');
    pruneImages(messages);
    let message: ModelMessage;
    try { message = await modelMessageWithRetry(env, model, messages, deadline, isActive, tools, { step: turn + 1, onModelCall: options.onModelCall, onRetry: options.onModelRetry, startExtended: continuing, retries: options.modelRetries ?? DEFAULT_MODEL_RETRIES, answerMs: options.modelAnswerMs }); }
    catch (error) {
      if (error instanceof ModelResponseError && error.detail.issue === 'max_tokens' && continuations < MAX_OUTPUT_CONTINUATIONS) {
        continuations++;
        continuing = true;
        console.warn(JSON.stringify({ event: 'model_output_continuation', model: model.id, continuation: continuations }));
        messages.push({ role: 'user', content: OUTPUT_LIMIT_CONTINUATION });
        turn--;
        continue;
      }
      if (!(error instanceof ModelResponseError) || !error.nativeEmptyToolResponse || model.protocol !== 'workers-ai' || !lastToolSucceeded || turn >= maxTurns - 1) throw error;
      if (!await isActive()) throw new Error('Mission cancelled');
      remainingAgentBudget(deadline);
      await env.assertModelAllowed?.(model);
      if (!await isActive()) throw new Error('Mission cancelled');
      turn++;
      const summary = await inferenceMessage(env, model, [...messages, { role: 'user', content: 'Tools are unavailable for this final response. Give a concise factual summary of the edits and tool evidence above. State incomplete work and failed checks. Do not claim completion or successful checks without tool evidence.' }], [], remainingAgentBudget(deadline), 4096, async (usage) => { options.onModelCall?.(usage); }, options.modelAnswerMs);
      if (!await isActive()) throw new Error('Mission cancelled');
      remainingAgentBudget(deadline);
      if (summary.calls.length || !summary.text.trim()) throw new ModelResponseError('invalid_final_summary', 'Model returned no usable tool-free final summary');
      return summary.text.slice(0, 4000);
    }
    continuing = false;
    if (!await isActive()) throw new Error('Mission cancelled');
    remainingAgentBudget(deadline);
    messages.push(...message.output.map(item => {
      if (model.protocol === 'workers-ai' && item.type === 'function_call') {
        try { JSON.parse(String(item.arguments)); }
        catch { return { ...item, arguments: '{}' }; }
      }
      return item;
    }));
    if (!message.calls.length) return message.text.slice(0, 4000);
    if (message.calls.length > 4) throw new Error('Model exceeded the per-turn tool limit');
    for (const call of message.calls) {
      if (!await isActive()) throw new Error('Mission cancelled');
      remainingAgentBudget(deadline);
      if (call.name === 'team_status' && options.team) {
        messages.push({ type: 'function_call_output', call_id: call.call_id, output: (await options.team.status(teamNote(call.arguments))).slice(0, outputLimit) });
        continue;
      }
      if ((call.name === 'install_dependencies' || call.name === 'run_tests') && options.workspace) {
        await onTool(call.name === 'install_dependencies' ? 'install dependencies' : 'run tests');
        if (!await isActive()) throw new Error('Mission cancelled');
        const output = call.name === 'install_dependencies' ? await options.workspace.install(deadline.at - Date.now()) : await options.workspace.test(deadline.at - Date.now());
        remainingAgentBudget(deadline);
        lastToolSucceeded = true;
        messages.push({ type: 'function_call_output', call_id: call.call_id, output: output.slice(0, outputLimit) });
        await options.afterCommand?.();
        continue;
      }
      if (call.name === VIEW_TOOL && options.workspace?.view) {
        await onTool('view the UI');
        if (!await isActive()) throw new Error('Mission cancelled');
        const viewed = await options.workspace.view(call.arguments, deadline.at - Date.now());
        remainingAgentBudget(deadline);
        lastToolSucceeded = viewed.images.length > 0;
        messages.push({ type: 'function_call_output', call_id: call.call_id, output: viewed.text.slice(0, outputLimit * 2) });
        if (viewed.images.length && vision) messages.push(imageItem(call.call_id, viewed.images));
        continue;
      }
      if (call.name !== 'shell') throw new Error('Unsupported model tool');
      const command = shellCommand(call.arguments);
      if (command === null) {
        messages.push({ type: 'function_call_output', call_id: call.call_id, output: 'Invalid shell tool input. Provide JSON with a single "command" string of at most 8000 characters.' });
        continue;
      }
      await onTool(command);
      if (!await isActive()) throw new Error('Mission cancelled');
      const result = await sandbox.command(['/bin/bash', '-lc', command], '/workspace/repo', Math.min(45_000, remainingAgentBudget(deadline)));
      remainingAgentBudget(deadline);
      lastToolSucceeded = result.exitCode === 0;
      messages.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result).slice(0, outputLimit) });
      await options.afterCommand?.();
    }
  }
  throw new Error(`Agent reached the ${maxTurns}-turn budget before completing`);
}

function teamNote(raw: string): string | undefined {
  try {
    const { note } = JSON.parse(raw) as { note?: unknown };
    return typeof note === 'string' && note.trim() ? note.trim().replace(/\s+/g, ' ').slice(0, 300) : undefined;
  } catch { return undefined; }
}

function shellCommand(raw: string): string | null {
  try {
    const fields = JSON.parse(raw) as { command?: unknown };
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).some(key => key !== 'command')) return null;
    const { command } = fields;
    return typeof command === 'string' && command.length <= 8000 ? command : null;
  } catch { return null; }
}

const MODEL_ATTEMPTS = 3;

export const OUTPUT_TOKEN_LIMITS: Record<ModelConnection['protocol'], { initial: number; extended: number }> = {
  anthropic: { initial: 8192, extended: 16_384 },
  responses: { initial: 8192, extended: 16_384 },
  chat: { initial: 4096, extended: 8192 },
  'workers-ai': { initial: 4096, extended: 8192 },
};

export const MAX_OUTPUT_CONTINUATIONS = 4;

export const OUTPUT_LIMIT_CONTINUATION = 'Your previous response reached the output token limit before it finished, so none of it was applied and no tool ran. Continue from where you were in smaller steps: write a large file with several shell commands of at most about 200 lines each (create it, then append with cat >>), and keep each response short.';

const MODEL_RETRY_BACKOFF_MS = 1000;

interface ModelRetryOptions { step: number; retries: number; answerMs?: number; onModelCall?: (usage: ModelUsage | undefined) => void; onRetry?: (message: string) => Promise<void>; startExtended?: boolean }

interface AgentClock { at: number; ms: number }

const DEFAULT_MODEL_RETRIES = MODEL_ATTEMPTS - 1;

export const MIN_MODEL_RETRY_MS = 30_000;

function providerStatus(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  const gatewayStatus = /status (\d{3})\b/.exec(error instanceof Error ? error.message : '')?.[1];
  return typeof status === 'number' ? status : gatewayStatus ? Number(gatewayStatus) : 0;
}

function retryNotice(model: ModelConnection, error: unknown, attempt: number, retries: number): string {
  const position = `retrying (${attempt}/${retries})`;
  if (error instanceof ModelTimeoutError) return `Model call timed out after ${Math.round(error.timeoutMs / 1000)}s; ${position}`;
  const status = providerStatus(error);
  if (status === 529 || (error instanceof ModelResponseError && error.detail.issue === 'overloaded')) return `${model.label} is overloaded; ${position}`;
  if (status >= 500) return `${model.label} returned HTTP ${status}; ${position}`;
  return `Model call failed; ${position}`;
}

async function modelMessageWithRetry(env: ExecutionEnv, model: ModelConnection, messages: InputItem[], deadline: AgentClock, isActive: () => Promise<boolean>, tools: InputItem[], options: ModelRetryOptions): Promise<ModelMessage> {
  const limits = OUTPUT_TOKEN_LIMITS[model.protocol] ?? OUTPUT_TOKEN_LIMITS.chat;
  let maxTokens = options.startExtended ? limits.extended : limits.initial;
  let responseRetried = false;
  for (let attempt = 1; ; attempt++) {
    if (!await isActive()) throw new Error('Mission cancelled');
    await env.assertModelAllowed?.(model);
    let recorded = false;
    try { return await inferenceMessage(env, model, messages, tools, remainingAgentBudget(deadline), maxTokens, async (usage) => { recorded = true; options.onModelCall?.(usage); }, options.answerMs); }
    catch (error) {
      if (!recorded) options.onModelCall?.(undefined);
      if (error instanceof ModelTimeoutError) {
        if (attempt > options.retries || deadline.at - Date.now() < MIN_MODEL_RETRY_MS) throw error.atStep(options.step);
      } else if (error instanceof ModelResponseError) {
        const truncated = error.detail.issue === 'max_tokens' && maxTokens < limits.extended;
        if (responseRetried || attempt >= MODEL_ATTEMPTS || !(error.transient || truncated)) throw error;
        responseRetried = true;
        if (truncated) maxTokens = limits.extended;
        console.warn(JSON.stringify({ event: 'model_response_retry', model: model.id, ...error.detail, maxTokens }));
      } else if ([400, 401, 403, 404, 413].includes(providerStatus(error)) || attempt > options.retries) throw error;
      if (!(error instanceof ModelResponseError) || error.detail.issue === 'overloaded') {
        const notice = retryNotice(model, error, attempt, Math.max(options.retries, attempt));
        console.warn(JSON.stringify({ event: 'model_call_retry', model: model.id, step: options.step, attempt, notice }));
        await options.onRetry?.(notice);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(MODEL_RETRY_BACKOFF_MS * 2 ** (attempt - 1), remainingAgentBudget(deadline))));
    }
  }
}

export function modelUnavailable(error: unknown): boolean {
  if (error instanceof ModelTimeoutError) return true;
  if (error instanceof ModelLocationError) return false;
  if (error instanceof ModelHttpError) return error.status === 529 || error.status >= 500;
  if (error instanceof ModelResponseError) return error.detail.issue === 'overloaded';
  const status = providerStatus(error);
  return status === 529 || status >= 500;
}

function remainingAgentBudget(deadline: AgentClock): number {
  const remaining = deadline.at - Date.now();
  if (remaining <= 0) throw new Error(`Agent exceeded its ${deadline.ms === 600_000 ? 'ten' : Math.round(deadline.ms / 60_000)}-minute budget`);
  return remaining;
}
