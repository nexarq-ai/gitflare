import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mission } from '../src/shared/types';
import type { ArtifactsBinding } from '../src/worker/artifacts';
import { AGENT_RUN_MS, MAX_TEST_TIMEOUT_MS, missionStepTimeoutMs, RUNNER_PREPARE_MS, TEST_BUDGET_MS } from '../src/worker/budgets';
import { checkSettingsSnapshot, learnedTimeoutSeconds, normalizeCheckSettings, percentile90, retryCheckSettings, retryPlan, withLearnedLimits } from '../src/worker/check-settings';
import { checkFailureSummary, checkFromCommand, commandOutput } from '../src/worker/execution';
import { escalatedLimits, parseRepositoryPolicy } from '../src/worker/repository-policy';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} },
  WorkerEntrypoint: class {},
}));

const sha = 'c'.repeat(40);
const packageJson = JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '^3.0.0' } });
const pnpmFiles = ['package.json', 'pnpm-lock.yaml', 'src/a.ts', 'src/a.test.ts'];

describe('check limits from repository policy', () => {
  it('gives package test scripts standard-2 and 600 s while the fixture keeps standard-1 and 120 s', () => {
    expect(parseRepositoryPolicy(null, 'node --test', pnpmFiles, packageJson, 'lockfileVersion: 9.0')).toMatchObject({ testCommand: 'pnpm test', runner: 'standard-2', runnerSource: 'default', testTimeoutMs: 600_000, testTimeoutSource: 'default' });
    expect(parseRepositoryPolicy(null, 'node --test --test-reporter=tap tests/*.test.mjs', ['tests/a.test.mjs', 'src/a.mjs'], null)).toMatchObject({ runner: 'standard-1', testTimeoutMs: 120_000 });
    expect(parseRepositoryPolicy(JSON.stringify({ test: 'npm run test' }), 'x')).toMatchObject({ runner: 'standard-2', testTimeoutMs: 600_000 });
    expect(parseRepositoryPolicy(JSON.stringify({ test: 'npx vitest run' }), 'x')).toMatchObject({ runner: 'standard-1', testTimeoutMs: 120_000 });
  });

  it('accepts runner and timeouts up to 900 s in gitflare.json', () => {
    expect(parseRepositoryPolicy(JSON.stringify({ test: 'pnpm test', runner: 'standard-4', timeoutSeconds: 900 }), 'x')).toMatchObject({ runner: 'standard-4', runnerSource: 'gitflare.json', testTimeoutMs: 900_000, testTimeoutSource: 'gitflare.json' });
    for (const invalid of ['{"timeoutSeconds":901}', '{"runner":"standard-5"}', '{"runner":"basic"}', '{"timeoutSeconds":9}']) expect(() => parseRepositoryPolicy(invalid, 'x')).toThrow('gitflare.json');
  });

  it('applies gitflare.json, then repository settings, then defaults', () => {
    const settings = { testTimeoutSeconds: 600, runner: 'standard-3' as const };
    expect(parseRepositoryPolicy(null, 'node --test', pnpmFiles, packageJson, null, settings)).toMatchObject({ testTimeoutMs: 600_000, testTimeoutSource: 'repository', runner: 'standard-3', runnerSource: 'repository' });
    expect(parseRepositoryPolicy(JSON.stringify({ test: 'pnpm test', timeoutSeconds: 200 }), 'x', [], null, null, settings)).toMatchObject({ testTimeoutMs: 200_000, testTimeoutSource: 'gitflare.json', runner: 'standard-3', runnerSource: 'repository' });
    expect(parseRepositoryPolicy(JSON.stringify({ test: 'pnpm test', runner: 'standard-1' }), 'x', [], null, null, settings)).toMatchObject({ testTimeoutMs: 600_000, testTimeoutSource: 'repository', runner: 'standard-1', runnerSource: 'gitflare.json' });
    expect(parseRepositoryPolicy(null, 'node --test', undefined, undefined, undefined, { runner: 'standard-2' })).toMatchObject({ testTimeoutMs: 120_000, testTimeoutSource: 'default', runner: 'standard-2', runnerSource: 'repository' });
  });
});

describe('automatic escalation and learned limits', () => {
  const auto = { enabled: true, maxTimeoutSeconds: 900, maxRunner: 'standard-3' as const };
  it('doubles the time and moves up one runner within the ceiling', () => {
    expect(escalatedLimits({ seconds: 300, runner: 'standard-2', timeoutSource: 'default', runnerSource: 'default' }, auto)).toEqual({ seconds: 600, runner: 'standard-3' });
    expect(escalatedLimits({ seconds: 600, runner: 'standard-3', timeoutSource: 'learned', runnerSource: 'repository' }, auto)).toEqual({ seconds: 900, runner: 'standard-3' });
    expect(escalatedLimits({ seconds: 900, runner: 'standard-3', timeoutSource: 'repository', runnerSource: 'repository' }, auto)).toBeNull();
    expect(escalatedLimits({ seconds: 300, runner: 'standard-2', timeoutSource: 'default', runnerSource: 'default' }, { ...auto, maxTimeoutSeconds: 400, maxRunner: 'standard-2' })).toEqual({ seconds: 400, runner: 'standard-2' });
    expect(escalatedLimits({ seconds: 300, runner: 'standard-2', timeoutSource: 'gitflare.json', runnerSource: 'default' }, auto)).toEqual({ seconds: 300, runner: 'standard-3' });
    expect(escalatedLimits({ seconds: 300, runner: 'standard-2', timeoutSource: 'gitflare.json', runnerSource: 'gitflare.json' }, auto)).toBeNull();
    expect(escalatedLimits({ seconds: 300, runner: 'standard-2', timeoutSource: 'default', runnerSource: 'default' }, { ...auto, enabled: false })).toBeNull();
    expect(escalatedLimits({ seconds: 950, runner: 'standard-4', timeoutSource: 'default', runnerSource: 'default' }, { ...auto, maxTimeoutSeconds: 600, maxRunner: 'standard-2' })).toBeNull();
  });

  it('starts at twice the p90 of recent passing checks, rounded up to a minute, within the ceiling', () => {
    expect(percentile90([1, 2])).toBeUndefined();
    expect(percentile90([100, 300, 200, 50, 400, 250, 120, 80, 90, 600])).toBe(400);
    expect(learnedTimeoutSeconds([200_000, 250_000, 310_000])).toBe(660);
    expect(parseRepositoryPolicy(null, 'node --test', pnpmFiles, packageJson, null, { learnedTimeoutSeconds: 660 })).toMatchObject({ testTimeoutMs: 660_000, testTimeoutSource: 'learned' });
    expect(parseRepositoryPolicy(null, 'node --test', pnpmFiles, packageJson, null, { learnedTimeoutSeconds: 120 })).toMatchObject({ testTimeoutMs: 600_000, testTimeoutSource: 'default' });
    expect(parseRepositoryPolicy(null, 'node --test', pnpmFiles, packageJson, null, { learnedTimeoutSeconds: 900, autoIncrease: { ...auto, maxTimeoutSeconds: 720 } })).toMatchObject({ testTimeoutMs: 720_000, testTimeoutSource: 'learned' });
    expect(parseRepositoryPolicy(null, 'node --test', pnpmFiles, packageJson, null, { learnedTimeoutSeconds: 900, autoIncrease: { ...auto, enabled: false } })).toMatchObject({ testTimeoutMs: 600_000 });
    expect(parseRepositoryPolicy(null, 'node --test', pnpmFiles, packageJson, null, { learnedTimeoutSeconds: 900, testTimeoutSeconds: 300 })).toMatchObject({ testTimeoutMs: 300_000, testTimeoutSource: 'repository' });
  });

  it('only raises remembered limits', () => {
    expect(withLearnedLimits({ testTimeoutSeconds: 600, runner: 'standard-2' }, { testTimeoutSeconds: 900, runner: 'standard-3' })).toEqual({ testTimeoutSeconds: 900, runner: 'standard-3' });
    expect(withLearnedLimits({ testTimeoutSeconds: 900, runner: 'standard-3' }, { testTimeoutSeconds: 600, runner: 'standard-2' })).toBeNull();
    expect(withLearnedLimits(undefined, { runner: 'standard-3' })).toEqual({ runner: 'standard-3' });
  });
});

describe('repository check settings', () => {
  it('validates the time limit and runner size', () => {
    expect(normalizeCheckSettings({ testTimeoutSeconds: 600, runner: 'standard-3' })).toEqual({ testTimeoutSeconds: 600, runner: 'standard-3' });
    expect(normalizeCheckSettings({ testTimeoutSeconds: null, runner: null })).toEqual({});
    for (const invalid of [{ testTimeoutSeconds: 59 }, { testTimeoutSeconds: 901 }, { testTimeoutSeconds: 61.5 }, { testTimeoutSeconds: '600' }, { runner: 'standard-9' }, { network: true }]) expect(() => normalizeCheckSettings(invalid)).toThrow();
    expect(checkSettingsSnapshot('repo', { runner: 'standard-2' })).toEqual({ repositoryId: 'repo', runner: 'standard-2', autoIncrease: { enabled: true, maxTimeoutSeconds: 900, maxRunner: 'standard-3' }, history: { samples: 0 }, limits: { minTimeoutSeconds: 60, maxTimeoutSeconds: 900, runners: ['standard-1', 'standard-2', 'standard-3', 'standard-4'] } });
  });

  const timedOut = (timeout: NonNullable<Mission['checks'][number]['timeout']>, status: Mission['status'] = 'failed') => ({ status, checks: [{ id: 'run', name: 'tests', status: 'failed' as const, timeout }] });

  it('derives the retry adjustment from the timed-out check', () => {
    const defaults = timedOut({ seconds: 300, runner: 'standard-2', timeoutSource: 'default', runnerSource: 'default' });
    expect(retryCheckSettings(defaults, undefined, 'timeout')).toEqual({ testTimeoutSeconds: 600 });
    expect(retryCheckSettings(defaults, { runner: 'standard-2', updatedBy: 'u' }, 'runner')).toEqual({ runner: 'standard-3' });
    expect(retryCheckSettings(defaults, { testTimeoutSeconds: 300 }, 'runner')).toEqual({ testTimeoutSeconds: 300, runner: 'standard-3' });
    expect(retryCheckSettings(timedOut({ seconds: 600, runner: 'standard-4', timeoutSource: 'repository', runnerSource: 'repository' }), undefined, 'timeout')).toEqual({ testTimeoutSeconds: 900 });
  });

  it('refuses retries that settings cannot change', () => {
    const code = (fn: () => unknown) => { try { fn(); } catch (error) { return (error as { code: string }).code; } return 'none'; };
    const defaults = timedOut({ seconds: 300, runner: 'standard-2', timeoutSource: 'default', runnerSource: 'default' });
    expect(code(() => retryCheckSettings(defaults, undefined, 'more'))).toBe('INVALID_RETRY_ADJUSTMENT');
    expect(code(() => retryCheckSettings({ ...defaults, status: 'running' }, undefined, 'timeout'))).toBe('MISSION_ACTIVE');
    expect(code(() => retryCheckSettings({ status: 'failed', checks: [{ id: 'x', name: 'x', status: 'failed' }] }, undefined, 'timeout'))).toBe('CHECK_NOT_TIMED_OUT');
    expect(code(() => retryCheckSettings(timedOut({ seconds: 200, runner: 'standard-2', timeoutSource: 'gitflare.json', runnerSource: 'default' }), undefined, 'timeout'))).toBe('POLICY_FILE_SETS_LIMIT');
    expect(code(() => retryCheckSettings(timedOut({ seconds: 200, runner: 'standard-2', timeoutSource: 'default', runnerSource: 'gitflare.json' }), undefined, 'runner'))).toBe('POLICY_FILE_SETS_LIMIT');
    expect(code(() => retryCheckSettings(timedOut({ seconds: 900, runner: 'standard-2', timeoutSource: 'repository', runnerSource: 'default' }), undefined, 'timeout'))).toBe('LIMIT_AT_MAXIMUM');
    expect(code(() => retryCheckSettings(timedOut({ seconds: 300, runner: 'standard-4', timeoutSource: 'default', runnerSource: 'repository' }), undefined, 'runner'))).toBe('LIMIT_AT_MAXIMUM');
  });
});

describe('timed-out checks', () => {
  const limits = { testTimeoutMs: 300_000, testTimeoutSource: 'default' as const, runner: 'standard-2' as const, runnerSource: 'default' as const };

  it('fails with an explicit message, keeps both streams and records the limits', () => {
    const result = { exitCode: 124, stdout: ' RUN  v3.2.4 /workspace/repo\n ✓ src/a.test.ts (3 tests)\n', stderr: ' ELIFECYCLE  Test failed. See above for more details.\n', timedOut: true };
    const check = checkFromCommand('run', 'Repository test suite', sha, result, 300_100, undefined, 'exit-code', limits);
    expect(check.status).toBe('failed');
    expect(check.timeout).toEqual({ seconds: 300, runner: 'standard-2', timeoutSource: 'default', runnerSource: 'default' });
    expect(check.output).toMatch(/^Timed out after 300 s on standard-2 \(default limit\)\. Raise the check time limit/);
    expect(check.output).toContain('--- stdout ---\n RUN  v3.2.4 /workspace/repo\n ✓ src/a.test.ts (3 tests)\n--- stderr ---\n ELIFECYCLE');
    expect(checkFailureSummary(check.output!)).toContain('Timed out after 300 s');
    const configured = checkFromCommand('run', 'tests', sha, result, 1, undefined, 'exit-code', { ...limits, testTimeoutMs: 450_000, testTimeoutSource: 'gitflare.json' });
    expect(configured.output).toContain('Timed out after 450 s on standard-2 (limit from gitflare.json timeoutSeconds)');
  });

  it('never passes a timed-out run even with exit code 0 and reports a timed-out baseline', () => {
    expect(checkFromCommand('run', 'tests', sha, { exitCode: 0, stdout: 'ok', stderr: '', timedOut: true }, 1, undefined, 'exit-code', limits).status).toBe('failed');
    const complete = '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# duration_ms 1';
    const check = checkFromCommand('run', 'tests', sha, { exitCode: 0, stdout: complete, stderr: '' }, 1, { exitCode: 124, stdout: '', stderr: '', timedOut: true }, 'tap', limits);
    expect(check).toMatchObject({ status: 'failed', timeout: { seconds: 300 } });
    expect(check.output).toContain('Base commit test run: Timed out after 300 s');
  });

  it('keeps the tail of long output from both streams within the limit', () => {
    const output = commandOutput({ stdout: `${'x'.repeat(20_000)}STDOUT-END`, stderr: `${'y'.repeat(9_000)}STDERR-END` }, 12_000);
    expect(output.length).toBeLessThanOrEqual(12_000);
    expect(output).toContain('STDOUT-END');
    expect(output).toContain('STDERR-END');
    expect(output).toMatch(/earlier characters omitted/);
    expect(commandOutput({ stdout: 'only', stderr: '' })).toBe('only');
  });
});

describe('Workflow budgets for longer checks', () => {
  it('fits a 900 s baseline and candidate run in every agent wave', () => {
    expect(MAX_TEST_TIMEOUT_MS).toBe(900_000);
    expect(TEST_BUDGET_MS).toBeGreaterThan(MAX_TEST_TIMEOUT_MS);
    expect(AGENT_RUN_MS).toBeGreaterThan(2 * (RUNNER_PREPARE_MS + 2 * MAX_TEST_TIMEOUT_MS));
    expect(missionStepTimeoutMs({ runs: [{}] as Mission['runs'] })).toBeGreaterThan(AGENT_RUN_MS);
  });
});

describe('runner sandbox', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const storage = { setAlarm: vi.fn(async () => {}), deleteAlarm: vi.fn(async () => {}) };
  function container(exitCode = 0, stdout = '', delayMs = 0) {
    const value = {
      images: { tools: 'prepared-image' }, running: false,
      start: vi.fn(() => { value.running = true; }),
      monitor: vi.fn(() => new Promise<void>(() => {})),
      destroy: vi.fn(async () => { value.running = false; }),
      setInactivityTimeout: vi.fn(async () => {}),
      interceptAllOutboundHttp: vi.fn(async () => {}),
      interceptOutboundHttps: vi.fn(async () => {}),
      exec: vi.fn(async (_argv: string[]) => {
        if (delayMs) vi.spyOn(Date, 'now').mockReturnValue(Date.now() + delayMs);
        return { exitCode: Promise.resolve(exitCode), stdout: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(stdout)); controller.close(); } }), stderr: null };
      }),
    };
    return value;
  }
  async function sandbox(value: ReturnType<typeof container>) {
    const { AgentSandbox } = await import('../runner/sandbox');
    return new AgentSandbox({ container: value, storage, exports: { GitOutbound: vi.fn(() => ({})) }, blockConcurrencyWhile: (callback: () => Promise<void>) => callback() } as unknown as DurableObjectState, { ARTIFACTS: {} as ArtifactsBinding });
  }

  it('starts the chosen instance type and keeps standard-1 by default', async () => {
    const chosen = container();
    await (await sandbox(chosen)).prepare([], { runner: 'standard-3' });
    expect(chosen.start).toHaveBeenCalledWith(expect.objectContaining({ instance: 'standard-3' }));
    const plain = container();
    await (await sandbox(plain)).prepare([]);
    expect(plain.start).toHaveBeenCalledWith(expect.objectContaining({ instance: 'standard-1' }));
    await expect((await sandbox(container())).prepare([], { runner: 'huge' as 'standard-1' })).rejects.toThrow('Unsupported runner size');
  });

  it('allows checks up to 900 s and flags a run stopped at its deadline', async () => {
    const value = container(124, 'partial', 300_000);
    value.running = true;
    const result = await (await sandbox(value)).check('pnpm test', 300_000);
    expect(value.exec.mock.calls[0]![0].slice(0, 3)).toEqual(['timeout', '--kill-after=2s', '300s']);
    expect(result).toEqual({ exitCode: 124, stdout: 'partial', stderr: '', timedOut: true });
    const long = container(0);
    long.running = true;
    await (await sandbox(long)).check('pnpm test', 1_200_000);
    expect(long.exec.mock.calls[0]![0][2]).toBe('900s');
  });

  it('does not treat a fast exit code 124 as a timeout', async () => {
    const value = container(124, 'exit 124');
    value.running = true;
    expect(await (await sandbox(value)).check('exit 124', 300_000)).toEqual({ exitCode: 124, stdout: 'exit 124', stderr: '' });
  });

  it('keeps the start and the end of oversized output', async () => {
    const { readCappedOutput } = await import('../runner/sandbox');
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (let index = 0; index < 100; index++) controller.enqueue(new TextEncoder().encode(`${String(index).padStart(3, '0')}${'.'.repeat(97)}`)); controller.close(); } });
    const text = await readCappedOutput(stream, 1000);
    expect(text.startsWith('000')).toBe(true);
    expect(text).toContain('[output truncated] 9000 bytes omitted');
    expect(text.endsWith(`099${'.'.repeat(97)}`)).toBe(true);
    const small = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('short')); controller.close(); } });
    expect(await readCappedOutput(small, 1000)).toBe('short');
    const strict = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2000)); controller.close(); } });
    await expect(readCappedOutput(strict, 1000, true)).rejects.toThrow('exceeded 1000 bytes');
  });
});

describe('Owner override of gitflare.json limits (GIT-111)', () => {
  const override = { actorId: 'owner', at: '2026-10-15T00:00:00.000Z' };
  const timedOut = (timeout: NonNullable<Mission['checks'][number]['timeout']>, status: Mission['status'] = 'failed') => ({ status, checks: [{ id: 'run', name: 'tests', status: 'failed' as const, timeout }] });

  it('lets an Owner retry past a gitflare.json limit for this proposal only', () => {
    const fixed = timedOut({ seconds: 300, runner: 'standard-3', timeoutSource: 'gitflare.json', runnerSource: 'auto' });
    expect(retryPlan(fixed, { runner: 'standard-2' }, 'timeout', true)).toEqual({ kind: 'override', override: { testTimeoutSeconds: 600 } });
    expect(retryPlan(timedOut({ seconds: 600, runner: 'standard-2', timeoutSource: 'owner', runnerSource: 'gitflare.json' }), undefined, 'timeout', true)).toEqual({ kind: 'override', override: { testTimeoutSeconds: 900 } });
    expect(retryPlan(timedOut({ seconds: 300, runner: 'standard-2', timeoutSource: 'default', runnerSource: 'gitflare.json' }), undefined, 'runner', true)).toEqual({ kind: 'override', override: { runner: 'standard-3' } });
  });

  it('keeps refusing non-Owners and uses repository settings when the value is not fixed', () => {
    const code = (fn: () => unknown) => { try { fn(); } catch (error) { return (error as { code: string }).code; } return 'none'; };
    expect(code(() => retryPlan(timedOut({ seconds: 300, runner: 'standard-2', timeoutSource: 'gitflare.json', runnerSource: 'default' }), undefined, 'timeout', false))).toBe('POLICY_FILE_SETS_LIMIT');
    expect(retryPlan(timedOut({ seconds: 300, runner: 'standard-2', timeoutSource: 'default', runnerSource: 'default' }), undefined, 'timeout', true)).toEqual({ kind: 'settings', settings: { testTimeoutSeconds: 600 } });
    expect(code(() => retryPlan(timedOut({ seconds: 900, runner: 'standard-2', timeoutSource: 'gitflare.json', runnerSource: 'default' }), undefined, 'timeout', true))).toBe('LIMIT_AT_MAXIMUM');
  });

  it('applies the override ahead of gitflare.json and keeps it fixed during automatic escalation', () => {
    const policy = parseRepositoryPolicy(JSON.stringify({ test: 'pnpm test', timeoutSeconds: 300, runner: 'standard-2' }), 'x', undefined, undefined, undefined, { override: { ...override, testTimeoutSeconds: 900 } });
    expect(policy).toMatchObject({ testTimeoutMs: 900_000, testTimeoutSource: 'owner', runner: 'standard-2', runnerSource: 'gitflare.json' });
    expect(escalatedLimits({ seconds: 900, runner: 'standard-2', timeoutSource: 'owner', runnerSource: 'auto' }, { enabled: true, maxTimeoutSeconds: 900, maxRunner: 'standard-4' })).toEqual({ seconds: 900, runner: 'standard-3' });
    expect(parseRepositoryPolicy(JSON.stringify({ test: 'pnpm test', timeoutSeconds: 300 }), 'x')).toMatchObject({ testTimeoutMs: 300_000, testTimeoutSource: 'gitflare.json' });
  });
});
