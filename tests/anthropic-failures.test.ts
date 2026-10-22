import { describe, expect, it, vi } from 'vitest';
import { anthropicOutput, AnthropicOutputError } from '../src/worker/anthropic-adapter';
import { runAgentLoop, MAX_OUTPUT_CONTINUATIONS, OUTPUT_LIMIT_CONTINUATION, OUTPUT_TOKEN_LIMITS, type ExecutionEnv, type SandboxRunner } from '../src/worker/execution';
import { ModelResponseError, normalizeModelMessage } from '../src/worker/model-adapter';

const model = { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5', source: 'gateway' as const, protocol: 'anthropic' as const };
const done = { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Edited the habits view' }] };
const sandbox: SandboxRunner = { prepare: vi.fn(), destroy: vi.fn(), command: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })) };

type Reply = { status?: number; body: unknown; raw?: string; logId?: string };

function gatewayEnv(replies: Reply[]) {
  const queries: Record<string, unknown>[] = [];
  const run = vi.fn(async (request: { query: Record<string, unknown> }) => {
    queries.push(request.query);
    const reply = replies.shift() ?? { body: done };
    const headers = new Headers({ 'content-type': 'application/json', ...(reply.logId ? { 'cf-aig-log-id': reply.logId } : {}) });
    return new Response(reply.raw ?? JSON.stringify(reply.body), { status: reply.status ?? 200, headers });
  });
  const env: ExecutionEnv = { AI_GATEWAY_ID: 'gitflare', AI: { run: vi.fn(), gateway: () => ({ run }) } as unknown as ExecutionEnv['AI'] };
  return { env, run, queries };
}

const loop = (env: ExecutionEnv) => runAgentLoop(env, sandbox, 'Build the habits page', async () => true, async () => {}, model);

describe('Anthropic output classification', () => {
  it.each([
    ['max_tokens', 'max_tokens'],
    ['pause_turn', 'pause_turn'],
    ['refusal', 'refusal'],
    ['model_context_window_exceeded', 'context_window'],
    ['stop_sequence', 'unknown_stop_reason'],
  ])('names stop_reason %s', (stop_reason, issue) => {
    const failure = (() => { try { anthropicOutput({ ...done, stop_reason }); } catch (error) { return error; } })();
    expect(failure).toBeInstanceOf(AnthropicOutputError);
    expect(failure).toMatchObject({ issue, stopReason: stop_reason });
  });

  it('separates overload, empty content and incomplete blocks without echoing content', () => {
    expect(() => anthropicOutput({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })).toThrow(expect.objectContaining({ issue: 'overloaded' }));
    expect(() => anthropicOutput({ ...done, content: [{ type: 'thinking', thinking: 'secret plan', signature: 'sig' }] })).toThrow(expect.objectContaining({ issue: 'empty_content' }));
    expect(() => anthropicOutput({ ...done, stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'c1', name: 'shell' }] })).toThrow(expect.objectContaining({ issue: 'incomplete_block' }));
    try { normalizeModelMessage({ ...done, stop_reason: 'refusal', content: [{ type: 'text', text: 'PROMPT TEXT' }] }, 'anthropic'); }
    catch (error) {
      expect(error).toBeInstanceOf(ModelResponseError);
      expect((error as Error).message).toContain('refusal');
      expect((error as Error).message).not.toContain('PROMPT TEXT');
    }
  });
});

describe('max_tokens stops from other protocols', () => {
  it('names an incomplete Responses output and a Chat length stop as max_tokens', () => {
    const responses = (() => { try { normalizeModelMessage({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }, 'responses'); } catch (error) { return error; } })();
    expect(responses).toMatchObject({ detail: { issue: 'max_tokens' } });
    const chat = (() => { try { normalizeModelMessage({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }, 'chat'); } catch (error) { return error; } })();
    expect(chat).toMatchObject({ detail: { issue: 'max_tokens' } });
    expect(() => normalizeModelMessage({ status: 'failed', output: [] }, 'responses')).toThrow(expect.objectContaining({ detail: {} }));
  });
});

describe('Anthropic transport recovery inside the agent budget', () => {
  it('retries a max_tokens turn once with a larger output budget', async () => {
    const { env, queries } = gatewayEnv([{ body: { ...done, stop_reason: 'max_tokens', content: [] } }]);
    expect(await loop(env)).toBe('Edited the habits view');
    expect(queries.map((query) => query.max_tokens)).toEqual([OUTPUT_TOKEN_LIMITS.anthropic.initial, OUTPUT_TOKEN_LIMITS.anthropic.extended]);
    expect(OUTPUT_TOKEN_LIMITS.anthropic.initial).toBeGreaterThan(4096);
  });

  it('asks the model to continue in smaller steps when the larger budget also stops at max_tokens', async () => {
    const truncated = { body: { ...done, stop_reason: 'max_tokens', content: [] } };
    const { env, queries } = gatewayEnv([truncated, truncated]);
    expect(await loop(env)).toBe('Edited the habits view');
    expect(queries.map((query) => query.max_tokens)).toEqual([OUTPUT_TOKEN_LIMITS.anthropic.initial, OUTPUT_TOKEN_LIMITS.anthropic.extended, OUTPUT_TOKEN_LIMITS.anthropic.extended]);
    expect(JSON.stringify((queries[2]!.messages as unknown[]).at(-1))).toContain('output token limit before it finished');
    expect(OUTPUT_LIMIT_CONTINUATION).toContain('smaller steps');
  });

  it('reports a repeated max_tokens stop with HTTP status and Gateway log id after the bounded continuations', async () => {
    const truncated = { body: { ...done, stop_reason: 'max_tokens', content: [] }, logId: '01JTESTLOG' };
    const { env, run } = gatewayEnv(Array.from({ length: 20 }, () => truncated));
    const error = await loop(env).catch((failure) => failure);
    expect(run).toHaveBeenCalledTimes(2 + MAX_OUTPUT_CONTINUATIONS);
    expect(error.message).toMatch(/max_tokens: the output token limit was reached/);
    expect(error.message).toContain('[HTTP 200, AI Gateway log 01JTESTLOG]');
    expect(error.message).not.toContain('Build the habits page');
  });

  it.each(['refusal', 'pause_turn'])('does not retry %s', async (stop_reason) => {
    const { env, run } = gatewayEnv([{ body: { ...done, stop_reason } }]);
    await expect(loop(env)).rejects.toThrow(stop_reason);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('retries an overloaded body once', async () => {
    const { env, run } = gatewayEnv([{ body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }]);
    expect(await loop(env)).toBe('Edited the habits view');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('retries an empty end_turn only once', async () => {
    const empty = { body: { ...done, content: [] } };
    const { env, run } = gatewayEnv([empty, empty]);
    await expect(loop(env)).rejects.toThrow('empty_content');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('retries a truncated response body and then names it', async () => {
    const cut = { body: null, raw: '{"type":"message","content":[{"type":"te', logId: 'cutlog' };
    const { env, run } = gatewayEnv([cut, cut]);
    const error = await loop(env).catch((failure) => failure);
    expect(run).toHaveBeenCalledTimes(2);
    expect(error.message).toContain('truncated or unparsable');
    expect(error.message).toContain('AI Gateway log cutlog');
  });

  it('retries a 529 overload with its status and log id, and never retries a 401', async () => {
    const overloaded = gatewayEnv([{ status: 529, body: { error: { message: 'Overloaded' } }, logId: 'log529' }]);
    expect(await loop(overloaded.env)).toBe('Edited the habits view');
    expect(overloaded.run).toHaveBeenCalledTimes(2);
    const denied = gatewayEnv([{ status: 401, body: { error: { message: 'invalid x-api-key' } }, logId: 'log401' }]);
    const error = await loop(denied.env).catch((failure) => failure);
    expect(denied.run).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ status: 401 });
    expect(error.message).toContain('AI Gateway log log401');
  });
});
