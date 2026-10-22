import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mission, Repository } from '../src/shared/types';
import type { ArtifactsBinding, ArtifactRepo } from '../src/worker/artifacts';
import type { CommandResult } from '../runner/sandbox';
import { timedOutCheck } from '../src/worker/check-settings';
import { CLONE_ATTEMPTS, CLONE_TIMEOUT_MS, cloneTimeoutMs, executeMission, installDependencies, type ExecutionEnv, type ExecutionResult, type SandboxRunner } from '../src/worker/execution';
import { INSTALL_ATTEMPTS, isTransientInstallFailure, type InstallPlan } from '../src/worker/package-manager';

const sha = 'a'.repeat(40);
const tap = 'ok 1 - capacity\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# duration_ms 1';
const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const npm: InstallPlan = { installer: 'npm', lockfile: 'package-lock.json', pinned: null, fallbackRange: null };
const undiciCrash = 'node:internal/deps/undici/undici:5772\nAssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:\n\n  assert(!this.paused)\n\n    at TLSSocket.onHttpSocketEnd (node:internal/deps/undici/undici:5772:7)';

afterEach(() => { vi.restoreAllMocks(); });

interface Runner { command: ReturnType<typeof vi.fn>; install: ReturnType<typeof vi.fn>; check: ReturnType<typeof vi.fn>; prepare: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }

function fixture({ agents = 1, policy, clone, install, check, prepare, command, extraEnv }: { agents?: number; policy?: string; clone?: (name: string, attempt: number) => CommandResult | undefined; install?: (name: string, attempt: number) => CommandResult | undefined; check?: (name: string) => CommandResult | undefined; prepare?: (name: string) => void; command?: (name: string, argv: string[]) => CommandResult | undefined; extraEnv?: Record<string, unknown> } = {}) {
  const runners = new Map<string, Runner>();
  const getByName = (name: string) => {
    if (!runners.has(name)) {
      const commitSha = (name.match(/run-(\d)/)?.[1] ?? '9').repeat(40);
      let fetched = commitSha;
      let clones = 0;
      let installs = 0;
      runners.set(name, {
        prepare: vi.fn(async () => prepare?.(name)),
        destroy: vi.fn(),
        check: vi.fn(async () => check?.(name) ?? ok(tap)),
        install: vi.fn(async () => install?.(name, ++installs) ?? ok()),
        command: vi.fn(async (argv: string[]) => {
          const overridden = command?.(name, argv);
          if (overridden) return overridden;
          if (argv[1] === 'clone') return clone?.(name, ++clones) ?? ok();
          if (argv[1] === 'fetch') fetched = (argv[3]!.match(/run-(\d)/)?.[1] ?? '9').repeat(40);
          if (argv[1] === 'rev-parse' && argv[2] === 'FETCH_HEAD') return ok(fetched);
          if (argv[1] === 'show') return policy && argv[2]!.endsWith(':gitflare.json') ? ok(policy) : { exitCode: 128, stdout: '', stderr: 'missing' };
          if (argv[1] === 'rev-parse') return ok(commitSha);
          if (argv[1] === 'diff' && argv.includes('--name-status')) return ok('M\tsrc/shared.mjs');
          if (argv[1] === 'diff') return ok(argv.includes('--cached') || argv.includes('--name-only') ? 'src/shared.mjs' : '+change');
          if (argv[0] === '/bin/bash' && argv[2]!.startsWith('node --test')) return ok(tap);
          return ok();
        }),
      });
    }
    return runners.get(name)! as unknown as SandboxRunner;
  };
  const artifacts = { get: async () => ({
    log: async () => [{ hash: sha, treeHash: 'tree', message: '' }],
    readTree: async () => [],
    fork: async (name: string) => ({ name, remote: `https://artifacts.example/${name}.git`, defaultBranch: 'main', token: 'private' }),
    revokeToken: async () => true,
    [Symbol.dispose]: () => {},
  } as unknown as ArtifactRepo) } as unknown as ArtifactsBinding;
  const mission: Mission = {
    repositoryId: 'repository', status: 'running', candidateSha: null, checks: [], events: [], changes: [], createdAt: '', updatedAt: '',
    id: 'mission', epoch: 1, title: 'Tune capacity', prompt: 'Tune capacity safely.', baseSha: sha, mode: 'combine',
    runs: Array.from({ length: agents }, (_, index) => ({ id: `run-${index + 1}`, name: `Agent ${index + 1}`, role: 'Engineer', task: `Part ${index + 1}`, status: 'queued' as const, changedFiles: [] })),
  };
  const env: ExecutionEnv = { MODEL: 'openai/gpt-6-luna', AI_GATEWAY_ID: 'test', ARTIFACTS: artifacts, SANDBOX: { getByName }, AI: { run: vi.fn(async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Edited src/shared.mjs.' }] }] })) }, ...extraEnv };
  const reports: ExecutionResult[] = [];
  const run = (isActive: () => Promise<boolean> = async () => true) => executeMission({ repository: { name: 'canonical', headSha: sha } as Repository, mission, testCommand: 'node --test --test-reporter=tap tests/*.test.mjs' }, env, async (progress) => { reports.push(progress); }, isActive);
  const calls = (name: string, match: (argv: string[]) => boolean) => runners.get(name)?.command.mock.calls.filter(([argv]) => match(argv as string[])) ?? [];
  return { runners, run, reports, calls };
}

const agentRunner = 'gf-mission-1-run-1';
const isClone = (argv: string[]) => argv[0] === 'git' && argv[1] === 'clone';
const timedOutClone: CommandResult = { exitCode: 124, stdout: '', stderr: "Cloning into '/workspace/repo'...\n", timedOut: true };

describe('bounded clone recovery', () => {
  it('retries a timed-out clone once in a clean directory and reports the real error as progress', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture({ clone: (name, attempt) => name === agentRunner && attempt === 1 ? timedOutClone : undefined });
    const result = await f.run();
    expect(result.error).toBeUndefined();
    expect(result.runs[0]).toMatchObject({ status: 'completed' });
    const clones = f.calls(agentRunner, isClone);
    expect(clones).toHaveLength(2);
    expect(clones.map(([, cwd, timeout]) => [cwd, timeout])).toEqual([['/workspace', CLONE_TIMEOUT_MS], ['/workspace', cloneTimeoutMs(2)]]);
    expect(cloneTimeoutMs(2)).toBeGreaterThan(CLONE_TIMEOUT_MS);
    const order = f.runners.get(agentRunner)!.command.mock.calls.map(([argv]) => (argv as string[]).slice(0, 2).join(' '));
    expect(order.slice(0, 3)).toEqual(['git clone', '/bin/sh -c', 'git clone']);
    expect(f.runners.get(agentRunner)!.command.mock.calls[1]![0]).toEqual(['/bin/sh', '-c', expect.stringContaining('mv -- /workspace/repo'), 'gitflare-clone-cleanup', '1']);
    expect(f.reports.some((report) => report.runs[0]!.summary?.startsWith(`Git clone timed out after 120 s (exit 124) on attempt 1 of ${CLONE_ATTEMPTS}: Cloning into`))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"git_clone_failed"'));
  });

  it('fails with the actual clone outcome after the bounded attempts and never pushes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture({ clone: (name) => name === agentRunner ? timedOutClone : undefined });
    const result = await f.run();
    expect(result.runs[0]).toMatchObject({ status: 'failed', error: expect.stringContaining(`Git clone timed out after ${cloneTimeoutMs(CLONE_ATTEMPTS) / 1000} s (exit 124) on attempt ${CLONE_ATTEMPTS} of ${CLONE_ATTEMPTS}`) });
    expect(result.candidateSha).toBeNull();
    expect(f.calls(agentRunner, isClone)).toHaveLength(CLONE_ATTEMPTS);
    for (const runner of f.runners.values()) expect(runner.command.mock.calls.some(([argv]) => (argv as string[])[1] === 'push')).toBe(false);
  });

  it('does not retry a clone that failed for a non-transient reason', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture({ clone: (name) => name === agentRunner ? { exitCode: 128, stdout: '', stderr: "Cloning into '/workspace/repo'...\nfatal: repository 'https://artifacts.example/x.git/' not found\n" } : undefined });
    const result = await f.run();
    expect(result.runs[0]).toMatchObject({ status: 'failed', error: expect.stringContaining(`Git clone failed (exit 128) on attempt 1 of ${CLONE_ATTEMPTS}`) });
    expect(result.runs[0]!.error).toContain('not found');
    expect(f.calls(agentRunner, isClone)).toHaveLength(1);
  });
});

describe('Git protocol errors and verification runners', () => {
  it('budgets Workflow steps for every clone attempt with its growing deadline', async () => {
    const { CANDIDATE_FETCH_MS, GIT_ALLOWANCE_MS } = await import('../src/worker/budgets');
    const worst = Array.from({ length: CLONE_ATTEMPTS }, (_, index) => cloneTimeoutMs(index + 1)).reduce((total, value) => total + value, 0);
    expect(CLONE_ATTEMPTS).toBe(3);
    expect(GIT_ALLOWANCE_MS).toBeGreaterThan(worst);
    expect(CANDIDATE_FETCH_MS).toBeGreaterThan(worst);
  });

  it('retries a clone that failed with "expected flush after ref listing"', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture({ clone: (name, attempt) => name === agentRunner && attempt === 1 ? { exitCode: 128, stdout: '', stderr: "Cloning into '/workspace/repo'...\nfatal: expected flush after ref listing\n" } : undefined });
    const result = await f.run();
    expect(result.runs[0]).toMatchObject({ status: 'completed' });
    expect(f.calls(agentRunner, isClone)).toHaveLength(2);
  });

  it('moves a verification clone that was killed during cleanup to a fresh verification runner', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const verifier = `${agentRunner}-verify`;
    const f = fixture({
      clone: (name, attempt) => name === verifier && attempt === 1 ? timedOutClone : undefined,
      command: (name, argv) => name === verifier && argv[3] === 'gitflare-clone-cleanup' ? { exitCode: 137, stdout: '', stderr: '' } : undefined,
    });
    const result = await f.run();
    expect(result.runs[0]).toMatchObject({ status: 'completed' });
    expect(f.runners.get(`${verifier}-fresh`)!.prepare).toHaveBeenCalledTimes(1);
    expect(f.runners.get(verifier)!.destroy).toHaveBeenCalled();
    expect(f.runners.get(`${verifier}-fresh`)!.destroy).toHaveBeenCalled();
  });
});

describe('runner killed during clone cleanup', () => {
  it('reports the SIGKILL during rm and retries the clone on a fresh runner', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture({
      clone: (name, attempt) => name === agentRunner && attempt === 1 ? timedOutClone : undefined,
      command: (name, argv) => name === agentRunner && argv[3] === 'gitflare-clone-cleanup' ? { exitCode: 137, stdout: '', stderr: '' } : undefined,
    });
    const result = await f.run();
    expect(result.runs[0]).toMatchObject({ status: 'completed' });
    const fresh = f.runners.get(`${agentRunner}-fresh`)!;
    expect(fresh.prepare).toHaveBeenCalledTimes(1);
    expect(f.calls(`${agentRunner}-fresh`, isClone)).toHaveLength(1);
    expect(f.runners.get(agentRunner)!.destroy).toHaveBeenCalled();
    expect(fresh.destroy).toHaveBeenCalled();
    expect(f.reports.some((report) => /^Runner was killed while moving the failed clone aside \(exit 137\) after git clone timed out.*Retrying the clone on a fresh runner$/s.test(report.runs[0]!.summary ?? ''))).toBe(true);
    expect(fresh.command.mock.calls.some(([argv]) => (argv as string[])[1] === 'push')).toBe(true);
  });

  it('fails with the clone outcome when the fresh runner cannot clone either', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture({
      clone: (name) => name.startsWith(agentRunner) ? timedOutClone : undefined,
      command: (name, argv) => name === agentRunner && argv[3] === 'gitflare-clone-cleanup' ? { exitCode: 137, stdout: '', stderr: '' } : undefined,
    });
    const result = await f.run();
    expect(result.runs[0]).toMatchObject({ status: 'failed', error: expect.stringContaining(`Git clone timed out after ${cloneTimeoutMs(CLONE_ATTEMPTS) / 1000} s (exit 124) on attempt ${CLONE_ATTEMPTS} of ${CLONE_ATTEMPTS}`) });
    expect(f.calls(`${agentRunner}-fresh`, isClone)).toHaveLength(CLONE_ATTEMPTS);
  });
});

describe('model location refusal across agents', () => {
  it('records one mission-level event and does not start queued agents', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const refusal = { kind: 'error', error: { name: 'InferenceUpstreamError', message: 'AI Gateway returned 403: Request not allowed', status: 403 }, colo: 'HKG' };
    const call = vi.fn(async () => refusal);
    const relay = { idFromName: (name: string) => name, get: vi.fn((_id: string, _options: { locationHint: string }) => ({ call })) };
    const f = fixture({ agents: 4, extraEnv: { MODEL_RELAY: relay } });
    const result = await f.run();
    expect(result.runs.every((run) => run.status === 'failed')).toBe(true);
    const events = (result.events ?? []).filter((event) => event.id.endsWith('-model-location'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'warning', message: expect.stringContaining('relay regions enam and wnam') });
    expect(events[0]!.message).toContain('HKG');
    expect(result.runs.filter((run) => run.error?.startsWith('Not started')).length).toBeGreaterThanOrEqual(1);
    expect(result.runs.every((run) => /Cloudflare locations \(see the mission event\)$/.test(run.error ?? ''))).toBe(true);
    expect(relay.get.mock.calls.map(([, options]) => options.locationHint)).toEqual(expect.arrayContaining(['enam', 'wnam']));
  });
});

describe('dependency install retry evidence', () => {
  const failure = (stderr: string): CommandResult => ({ exitCode: 1, stdout: '', stderr });

  type Case = [string, CommandResult[], () => Promise<void>, () => Promise<boolean>, string | null, number];
  const allowed = async (): Promise<void> => {};
  const active = async (): Promise<boolean> => true;
  const cases: Case[] = [
    ['transient network reset', [failure('npm error code ECONNRESET'), ok()], allowed, active, null, 2],
    ['corepack undici socket assertion', [failure(undiciCrash), ok()], allowed, active, null, 2],
    ['authority revoked before the retry', [failure('npm error code ECONNRESET')], vi.fn<() => Promise<void>>().mockResolvedValueOnce().mockRejectedValue(new Error('FORBIDDEN')), active, 'FORBIDDEN', 1],
    ['permanent resolution failure', [failure('npm error code ERESOLVE')], allowed, active, 'failed (1)', 1],
    ['mission cancelled before the retry', [failure('npm error code ETIMEDOUT')], allowed, vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(true).mockResolvedValue(false), 'Mission cancelled', 1],
  ];

  it.each(cases)('%s', async (_name, results, assertAuthority, isActive, rejection, attempts) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const install = vi.fn<() => Promise<CommandResult>>();
    for (const result of results) install.mockResolvedValueOnce(result);
    const runner = { prepare: vi.fn(), destroy: vi.fn(), command: vi.fn(), install } as unknown as SandboxRunner;
    const pending = installDependencies(runner, npm, assertAuthority, isActive);
    if (rejection) await expect(pending).rejects.toThrow(rejection);
    else await expect(pending).resolves.toBeUndefined();
    expect(install).toHaveBeenCalledTimes(attempts);
    expect(attempts).toBeLessThanOrEqual(INSTALL_ATTEMPTS);
    if (attempts === 2) expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"dependency_install_retry"'));
  });

  it('classifies the corepack undici crash as transient but not ordinary install errors', () => {
    expect(isTransientInstallFailure(undiciCrash)).toBe(true);
    expect(isTransientInstallFailure('npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree')).toBe(false);
  });
});

describe('combined verification cancellation', () => {
  const integrationVerifier = 'gf-mission-1-integration-verify';

  it('consults isActive before retrying a combined-candidate install', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let cancelled = false;
    const f = fixture({ agents: 2, policy: '{"install":"npm"}', install: (name, attempt) => {
      if (name !== integrationVerifier || attempt > 1) return undefined;
      cancelled = true;
      return { exitCode: 1, stdout: '', stderr: 'npm error code ECONNRESET' };
    } });
    const result = await f.run(async () => !cancelled);
    expect(result.runs.map((run) => run.status)).toEqual(['completed', 'completed']);
    expect(f.runners.get(integrationVerifier)!.install).toHaveBeenCalledTimes(1);
    expect(result.error).toBe('Mission cancelled');
  });

  it('retries a transient combined-candidate install while the mission stays active', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture({ agents: 2, policy: '{"install":"npm"}', install: (name, attempt) => name === integrationVerifier && attempt === 1 ? { exitCode: 1, stdout: '', stderr: 'npm error code ECONNRESET' } : undefined });
    const result = await f.run();
    expect(f.runners.get(integrationVerifier)!.install).toHaveBeenCalledTimes(2);
    expect(result.error).toBeUndefined();
    expect(result.checks.find((check) => check.id === 'integration')).toMatchObject({ status: 'passed' });
  });
});

describe('verification runner install', () => {
  it('retries the corepack undici crash on the fresh verification runner', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const verifier = 'gf-mission-1-run-1-verify';
    const f = fixture({ policy: '{"install":"pnpm"}', install: (name, attempt) => name === verifier && attempt === 1 ? { exitCode: 1, stdout: '', stderr: undiciCrash } : undefined });
    const result = await f.run();
    expect(f.runners.get(verifier)!.install).toHaveBeenCalledTimes(2);
    expect(result.runs[0]).toMatchObject({ status: 'completed' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"dependency_install_retry"'));
  });
});

describe('check timeout escalation', () => {
  const verifier = 'gf-mission-1-run-1-verify';
  const escalated = 'gf-mission-1-run-1-escalated-verify';
  const timedOut: CommandResult = { exitCode: 124, stdout: 'ok 1 - capacity', stderr: '', timedOut: true };

  it('keeps the timed-out check with its limits when the escalated retry cannot run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fixture({
      policy: '{"timeoutSeconds":300}',
      check: (name) => name === verifier ? timedOut : undefined,
      prepare: (name) => { if (name === escalated) throw new Error('Runner preparation failed during container startup: instance type unavailable'); },
    });
    const result = await f.run();
    const check = result.checks.find((entry) => entry.runId === 'run-1');
    expect(check).toMatchObject({ status: 'failed', timeout: { seconds: 300, runner: 'standard-1', timeoutSource: 'gitflare.json', runnerSource: 'default' } });
    expect(check!.output).toContain('Automatic retry with 300 s on standard-2 could not run: Runner preparation failed during container startup');
    expect(timedOutCheck(result)).toBe(check);
    expect(result.runs[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('Candidate checks failed') });
    expect(result.runs[0]!.error).not.toContain('retrying with');
    expect(f.reports.some((report) => report.runs[0]!.summary === 'Timed out after 300 s on standard-1; retrying with 300 s on standard-2')).toBe(true);
    expect(f.runners.get(escalated)!.prepare).toHaveBeenCalledWith(expect.anything(), { runner: 'standard-2' });
  });

  it('runs the escalated attempt with a raised deadline when no explicit timeout was set', async () => {
    const f = fixture({ check: (name) => name === verifier ? timedOut : undefined });
    const result = await f.run();
    expect(f.runners.get(verifier)!.check.mock.calls.map(([, timeoutMs]) => timeoutMs)).toEqual([120_000, 120_000]);
    expect(f.runners.get(escalated)!.check.mock.calls.map(([, timeoutMs]) => timeoutMs)).toEqual([240_000, 240_000]);
    expect(f.runners.get(escalated)!.prepare).toHaveBeenCalledWith(expect.anything(), { runner: 'standard-2' });
    expect(result.runs[0]).toMatchObject({ status: 'completed' });
    expect(result.checks.find((entry) => entry.runId === 'run-1')).toMatchObject({ status: 'passed', escalatedFrom: { seconds: 120, runner: 'standard-1' } });
    expect(result.learnedLimits).toEqual({ testTimeoutSeconds: 240, runner: 'standard-2' });
  });
});
