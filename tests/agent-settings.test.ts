import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentLimits, Mission, Repository } from '../src/shared/types';
import type { AppEnv } from '../src/worker/env';
import type { ArtifactsBinding, ArtifactRepo } from '../src/worker/artifacts';
import type { CommandResult } from '../runner/sandbox';
import { GitflareCoordinator } from '../src/worker/coordinator';
import { missionInput } from '../src/worker/domain';
import { AGENT_RUN_MS, agentRunMs, missionStepTimeoutMs } from '../src/worker/budgets';
import { DEFAULT_AGENT_LIMITS, agentSettingsSnapshot, effectiveAgentLimits, normalizeAgentSettings, normalizeEditScope, normalizeRetryOverrides, outsideEditScope } from '../src/worker/agent-settings';
import { executeMission, modelUnavailable, runAgentLoop, type ExecutionEnv, type ExecutionResult, type SandboxRunner } from '../src/worker/execution';
import { ModelHttpError, ModelResponseError, ModelTimeoutError } from '../src/worker/model-adapter';
import { defaultModelConnections } from '../src/worker/model-config';

vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: DurableObjectState, protected env: AppEnv) {} }, WorkerEntrypoint: class {}, WorkflowEntrypoint: class {} }));

const sha = 'a'.repeat(40);
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

function workspace(tasks?: Parameters<GitflareCoordinator['createMission']>[1]['tasks'], agentOverrides?: Parameters<GitflareCoordinator['createMission']>[1]['agentOverrides']) {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  let alarm: number | null = null;
  const ctx = { storage: {
    getAlarm: async () => alarm, setAlarm: async (when: number) => { alarm = when; },
    sql: { exec(query: string, ...args: SQLInputValue[]) { const statement = db.prepare(query); const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []); return { toArray: () => rows }; } },
    transactionSync<T>(fn: () => T): T { db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } },
  } } as unknown as DurableObjectState;
  const coordinator = new GitflareCoordinator(ctx, {} as AppEnv);
  const now = new Date().toISOString();
  const repository: Repository = { id: 'repo', name: 'pose-viewer', description: '', defaultBranch: 'main', headSha: sha, provider: 'artifacts', createdAt: now, updatedAt: now };
  coordinator.saveRepository(repository);
  const created = coordinator.createMission('create', { repositoryId: repository.id, title: 'Render poses', prompt: 'Render the pose skeleton in 3D.', tasks: tasks ?? [
    { name: 'Renderer', role: 'Implementation', task: 'Write the 3D renderer.', editScope: ['public/render3d.mjs', 'public/pose*.mjs'], overrides: { runSeconds: 1200, maxSteps: 24 } },
    { name: 'Docs', role: 'Documentation', task: 'Document the renderer.' },
  ], ...(agentOverrides ? { agentOverrides } : {}) });
  return { coordinator, created };
}

describe('agent settings validation', () => {
  it('accepts values within bounds and rejects the rest', () => {
    expect(normalizeAgentSettings({ modelAnswerSeconds: 240, modelRetries: 0, maxSteps: 12, runSeconds: 900, autoRetry: false })).toEqual({ modelAnswerSeconds: 240, modelRetries: 0, maxSteps: 12, runSeconds: 900, autoRetry: false });
    expect(normalizeAgentSettings({ modelAnswerSeconds: null })).toEqual({});
    for (const body of [{ modelAnswerSeconds: 30 }, { modelAnswerSeconds: 601 }, { modelRetries: 4 }, { maxSteps: 0 }, { maxSteps: 33 }, { runSeconds: 60 }, { runSeconds: 1801 }, { maxSteps: 2.5 }, { autoRetry: 'yes' }, { model: 'x' }]) {
      expect(() => normalizeAgentSettings(body), JSON.stringify(body)).toThrow(/INVALID_AGENT_SETTINGS/);
    }
  });

  it('reports defaults and effective values with bounds', () => {
    const snapshot = agentSettingsSnapshot('repo', { runSeconds: 1200 });
    expect(snapshot.defaults).toEqual(DEFAULT_AGENT_LIMITS);
    expect(snapshot.effective).toEqual({ ...DEFAULT_AGENT_LIMITS, runSeconds: 1200 });
    expect(snapshot.bounds.maxSteps).toEqual({ min: 1, max: 32 });
    expect(effectiveAgentLimits({ maxSteps: 10, modelRetries: 1 }, { maxSteps: 20, modelAnswerSeconds: 400 })).toEqual({ modelAnswerSeconds: 400, modelRetries: 1, maxSteps: 20, runSeconds: 600, autoRetry: true });
  });

  it('validates edit scopes and matches files, directories and globs', () => {
    expect(normalizeEditScope(['./public/render3d.mjs', 'public/pose*.mjs', 'docs/', 'public/pose*.mjs'])).toEqual(['public/render3d.mjs', 'public/pose*.mjs', 'docs/']);
    expect(normalizeEditScope([])).toBeUndefined();
    for (const bad of [['../secret'], ['/etc/passwd'], ['a//b'], [42], Array.from({ length: 21 }, (_, index) => `f${index}`)]) expect(() => normalizeEditScope(bad)).toThrow(/INVALID_EDIT_SCOPE/);
    const scope = ['public/render3d.mjs', 'public/pose*.mjs', 'docs/'];
    expect(outsideEditScope(['public/render3d.mjs', 'public/pose-skeleton.mjs', 'docs/renderer.md', 'public/index.html', 'public/nested/pose.mjs'], scope)).toEqual(['public/index.html', 'public/nested/pose.mjs']);
    expect(outsideEditScope(['anything.js'], undefined)).toEqual([]);
  });

  it('parses per-agent and mission-wide overrides on the create body', () => {
    const input = missionInput({ title: 'Render', prompt: 'Render the poses in 3D.', repositoryId: 'repo', tasks: [{ name: 'Renderer', role: 'Impl', task: 'Write the renderer.', editScope: ['public/render3d.mjs'], overrides: { runSeconds: 900, maxSteps: 20 } }], agentOverrides: { editScope: ['public/'], runSeconds: 1200 } });
    expect(input.tasks![0]).toMatchObject({ editScope: ['public/render3d.mjs'], overrides: { runSeconds: 900, maxSteps: 20 } });
    expect(input.agentOverrides).toEqual({ runSeconds: 1200, editScope: ['public/'] });
    expect(() => missionInput({ title: 'Render', prompt: 'Render the poses in 3D.', repositoryId: 'repo', tasks: [{ name: 'R', role: 'I', task: 'Write the renderer.', overrides: { runSeconds: 10 } }] })).toThrow(/INVALID_AGENT_OVERRIDES/);
  });

  it('accepts retry overrides only for listed agents', () => {
    expect(normalizeRetryOverrides({ a: { runSeconds: 1200, model: 'anthropic/claude-opus-5-5' } }, ['a'])).toEqual({ a: { runSeconds: 1200, model: 'anthropic/claude-opus-5-5' } });
    expect(() => normalizeRetryOverrides({ b: { runSeconds: 1200 } }, ['a'])).toThrow(/INVALID_RETRY_OVERRIDES/);
    expect(() => normalizeRetryOverrides({ a: { modelRetries: 1 } }, ['a'])).toThrow(/INVALID_RETRY_OVERRIDES/);
  });
});

describe('agent limit pinning', () => {
  it('pins repository settings and per-agent overrides when an attempt starts', async () => {
    const { coordinator, created } = workspace();
    coordinator.setAgentSettings('settings-1', { modelRetries: 1, runSeconds: 900, modelAnswerSeconds: 300 }, 'owner');
    const started = await coordinator.startMission('start-1', created.id);
    const [renderer, docs] = started.runs;
    expect(renderer).toMatchObject({ editScope: ['public/render3d.mjs', 'public/pose*.mjs'], overrides: { runSeconds: 1200, maxSteps: 24 }, limits: { modelAnswerSeconds: 300, modelRetries: 1, maxSteps: 24, runSeconds: 1200, autoRetry: true } });
    expect(docs!.limits).toEqual({ modelAnswerSeconds: 300, modelRetries: 1, maxSteps: 32, runSeconds: 900, autoRetry: true });
    coordinator.setAgentSettings('settings-2', { runSeconds: 300 }, 'owner');
    expect(coordinator.getMission(created.id)!.runs[1]!.limits!.runSeconds).toBe(900);
  });

  it('applies mission-wide overrides to agents without their own', async () => {
    const { coordinator, created } = workspace([{ name: 'A', role: 'Impl', task: 'Write part A.' }, { name: 'B', role: 'Impl', task: 'Write part B.', editScope: ['b/'] }], { editScope: ['shared/'], maxSteps: 8 });
    const started = await coordinator.startMission('start-1', created.id);
    expect(started.runs.map((run) => [run.editScope, run.limits!.maxSteps])).toEqual([[['shared/'], 8], [['b/'], 8]]);
  });

  it('extends the workflow step for longer agent runs and automatic retries', () => {
    const limits = (runSeconds: number, autoRetry: boolean): AgentLimits => ({ ...DEFAULT_AGENT_LIMITS, runSeconds, autoRetry });
    const shape = (agentLimits?: AgentLimits) => ({ runs: [{ ...(agentLimits ? { limits: agentLimits } : {}) }] as Mission['runs'] });
    expect(missionStepTimeoutMs(shape(limits(600, false)))).toBe(missionStepTimeoutMs(shape()));
    expect(missionStepTimeoutMs(shape(limits(1800, true))) - missionStepTimeoutMs(shape())).toBe(agentRunMs(3_600_000) - AGENT_RUN_MS);
  });

  it('retries one agent with more time or another enabled model', async () => {
    const { coordinator, created } = workspace();
    const started = await coordinator.startMission('start-1', created.id);
    const failed = coordinator.recordExecution(created.id, started.epoch, { runs: started.runs.map((run) => ({ ...run, status: 'failed' as const, error: 'Claude Sonnet 5.5 did not answer within 180s (step 3).' })), checks: [], changes: [], candidateSha: null, error: 'Agents failed.' }, true);
    const [renderer, docs] = failed.runs;
    const models = defaultModelConnections();
    const retried = await coordinator.retryAgents('retry-1', created.id, 'retry', [renderer!.id], undefined, models, undefined, { [renderer!.id]: { runSeconds: 1800, model: 'anthropic/claude-opus-5-5' } });
    const rerun = retried.runs.find((run) => run.id === renderer!.id)!;
    expect(rerun).toMatchObject({ status: 'queued', model: 'anthropic/claude-opus-5-5', modelConfig: { id: 'anthropic/claude-opus-5-5' }, overrides: { runSeconds: 1800, maxSteps: 24 }, limits: { runSeconds: 1800, maxSteps: 24 }, editScope: ['public/render3d.mjs', 'public/pose*.mjs'] });
    expect(retried.events.at(-1)!.message).toContain('Retry settings: Renderer: model anthropic/claude-opus-5-5, 30 min run limit');
    expect(retried.runs.find((run) => run.id === docs!.id)!.model).toBe(docs!.model);
  });

  it('refuses another model that the workspace has not enabled', async () => {
    const { coordinator, created } = workspace();
    const started = await coordinator.startMission('start-1', created.id);
    const failed = coordinator.recordExecution(created.id, started.epoch, { runs: started.runs.map((run) => ({ ...run, status: 'failed' as const, error: 'timed out' })), checks: [], changes: [], candidateSha: null, error: 'Agents failed.' }, true);
    await expect(coordinator.retryAgents('retry-1', created.id, 'retry', [failed.runs[0]!.id], undefined, defaultModelConnections(), undefined, { [failed.runs[0]!.id]: { model: 'openai/gpt-4.1-mini' } })).rejects.toThrow(/MODEL_NOT_CONFIGURED/);
  });

  it('refuses single-agent retry while the attempt is still running', async () => {
    const { coordinator, created } = workspace();
    const started = await coordinator.startMission('start-1', created.id);
    await expect(coordinator.retryAgents('retry-1', created.id, 'retry', [started.runs[0]!.id], undefined, defaultModelConnections(), undefined, { [started.runs[0]!.id]: { runSeconds: 1200 } })).rejects.toThrow(/MISSION_NOT_FAILED/);
  });
});

describe('agent loop limits', () => {
  const luna = { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna', source: 'gateway' as const, protocol: 'responses' as const };
  const sandbox: SandboxRunner = { prepare: vi.fn(), destroy: vi.fn(), command: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })) };
  const shell = { status: 'completed', output: [{ type: 'function_call', call_id: 'c', name: 'shell', arguments: '{"command":"ls"}' }] };
  const env = (run: ReturnType<typeof vi.fn>): ExecutionEnv => ({ AI_GATEWAY_ID: 'gitflare', AI: { run } as unknown as ExecutionEnv['AI'] });

  it('stops at the pinned step limit', async () => {
    const run = vi.fn(async () => shell);
    await expect(runAgentLoop(env(run), sandbox, 'task', async () => true, async () => {}, luna, { maxTurns: 3 })).rejects.toThrow('3-turn budget');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('uses the pinned run time and model answer time', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const run = vi.fn(async () => { now = 1_200_001; return shell; });
    await expect(runAgentLoop(env(run), sandbox, 'task', async () => true, async () => {}, luna, { budgetMs: 1_200_000, modelAnswerMs: 400_000 })).rejects.toThrow('20-minute budget');
    expect(timeout).toHaveBeenCalledWith(400_000);
  });

  it('does not retry a model answer when retries are off', async () => {
    const run = vi.fn(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
    await expect(runAgentLoop(env(run), sandbox, 'task', async () => true, async () => {}, luna, { modelRetries: 0 })).rejects.toThrow('(step 1). Retry the agent');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('classifies only model timeouts and overloads as retryable agent failures', () => {
    expect(modelUnavailable(new ModelTimeoutError('Claude Fable 5.1', 300_000, 2))).toBe(true);
    expect(modelUnavailable(new ModelHttpError('overloaded', 529))).toBe(true);
    expect(modelUnavailable(new ModelHttpError('bad gateway', 502))).toBe(true);
    expect(modelUnavailable(new ModelResponseError('provider_error', 'Overloaded', false, { issue: 'overloaded' }))).toBe(true);
    expect(modelUnavailable(new ModelHttpError('forbidden', 403))).toBe(false);
    expect(modelUnavailable(new Error('Agent changed protected files'))).toBe(false);
    expect(modelUnavailable(new Error('Agent exceeded its ten-minute budget'))).toBe(false);
  });
});

describe('agent execution limits', () => {
  const tap = 'ok 1 - render\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# duration_ms 1';
  const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
  const done = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Wrote the renderer.' }] }] };

  function fixture(run: Partial<Mission['runs'][number]>, ai: ReturnType<typeof vi.fn>, staged = 'public/render3d.mjs\npublic/index.html') {
    const getByName = () => ({
      prepare: vi.fn(), destroy: vi.fn(),
      check: vi.fn(async () => ok(tap)),
      install: vi.fn(async () => ok()),
      command: vi.fn(async (argv: string[]) => {
        if (argv[1] === 'rev-parse' && argv[2] === 'FETCH_HEAD') return ok('1'.repeat(40));
        if (argv[1] === 'show') return { exitCode: 128, stdout: '', stderr: 'missing' };
        if (argv[1] === 'rev-parse') return ok('1'.repeat(40));
        if (argv[1] === 'diff' && argv.includes('--name-status')) return ok(staged.split('\n').map((path) => `M\t${path}`).join('\n'));
        if (argv[1] === 'diff') return ok(argv.includes('--cached') || argv.includes('--name-only') ? staged : '+change');
        if (argv[0] === '/bin/bash' && argv[2]!.startsWith('node --test')) return ok(tap);
        return ok();
      }),
    }) as unknown as SandboxRunner;
    const artifacts = { get: async () => ({
      log: async () => [{ hash: sha, treeHash: 'tree', message: '' }],
      readTree: async () => [],
      fork: async (name: string) => ({ name, remote: `https://artifacts.example/${name}.git`, defaultBranch: 'main', token: 'private' }),
      revokeToken: async () => true,
      [Symbol.dispose]: () => {},
    } as unknown as ArtifactRepo) } as unknown as ArtifactsBinding;
    const mission: Mission = {
      repositoryId: 'repository', status: 'running', candidateSha: null, checks: [], events: [], changes: [], createdAt: '', updatedAt: '',
      id: 'mission', epoch: 1, title: 'Render poses', prompt: 'Render poses in 3D.', baseSha: sha, mode: 'combine',
      runs: [{ id: 'run-1', name: 'Renderer', role: 'Engineer', task: 'Write the renderer', status: 'queued', changedFiles: [], ...run }],
    };
    const env: ExecutionEnv = { MODEL: 'openai/gpt-6-luna', AI_GATEWAY_ID: 'test', ARTIFACTS: artifacts, SANDBOX: { getByName }, AI: { run: ai } as unknown as ExecutionEnv['AI'] };
    const reports: ExecutionResult[] = [];
    return { reports, run: () => executeMission({ repository: { name: 'canonical', headSha: sha } as Repository, mission, testCommand: 'node --test --test-reporter=tap tests/*.test.mjs' }, env, async (progress) => { reports.push(progress); }, async () => true) };
  }

  it('fails an agent that changed files outside its edit scope and lists them', async () => {
    const ai = vi.fn(async () => done);
    const result = await fixture({ editScope: ['public/render3d.mjs', 'public/pose*.mjs'] }, ai).run();
    expect(result.runs[0]).toMatchObject({ status: 'failed', error: 'Renderer changed 1 file outside the files it may edit (public/render3d.mjs, public/pose*.mjs): public/index.html. Widen "Files this agent may edit" or retry with guidance.' });
    expect(JSON.stringify(ai.mock.calls[0])).toContain('filesYouMayEdit');
  });

  it('passes an agent whose changes stay inside its edit scope', async () => {
    const result = await fixture({ editScope: ['public/'] }, vi.fn(async () => done)).run();
    expect(result.runs[0]!.status).toBe('completed');
  });

  it('retries a timed-out agent once automatically on the same model, keeping its working tree', async () => {
    const ai = vi.fn().mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError')).mockResolvedValue(done);
    const limits: AgentLimits = { ...DEFAULT_AGENT_LIMITS, modelRetries: 0 };
    const f = fixture({ limits }, ai, 'public/render3d.mjs');
    const result = await f.run();
    expect(result.runs[0]).toMatchObject({ status: 'completed', autoRetried: true });
    expect(ai).toHaveBeenCalledTimes(2);
    expect(new Set(ai.mock.calls.map(([model]) => model))).toEqual(new Set(['openai/gpt-6-luna']));
    expect(JSON.stringify(ai.mock.calls[1])).toContain('did not answer in time');
    expect(result.events?.some((event) => event.id.endsWith('-auto-retry') && event.message.includes('Retrying this agent once automatically on GPT-6 Luna'))).toBe(true);
  });

  it('does not retry an agent automatically when the setting is off', async () => {
    const ai = vi.fn(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
    const result = await fixture({ limits: { ...DEFAULT_AGENT_LIMITS, modelRetries: 0, autoRetry: false } }, ai).run();
    expect(result.runs[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('did not answer within') });
    expect(ai).toHaveBeenCalledTimes(1);
  });
});
