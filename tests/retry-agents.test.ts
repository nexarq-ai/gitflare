import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mission, Repository } from '../src/shared/types';
import type { AppEnv } from '../src/worker/env';
import { GitflareCoordinator } from '../src/worker/coordinator';
import { agentRunIds } from '../src/worker/domain';
import { DEFAULT_AGENT_LIMITS } from '../src/worker/agent-settings';

vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: DurableObjectState, protected env: AppEnv) {} }, WorkerEntrypoint: class {}, WorkflowEntrypoint: class {} }));

const baseSha = 'a'.repeat(40);
const movedSha = 'd'.repeat(40);
const habitsSha = '1'.repeat(40);
const dashboardSha = '2'.repeat(40);
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function workspace() {
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
  const repository: Repository = { id: 'repo', name: 'tidy-dashboard', description: '', defaultBranch: 'main', headSha: baseSha, provider: 'artifacts', createdAt: now, updatedAt: now };
  coordinator.saveRepository(repository);
  const created = coordinator.createMission('create', { repositoryId: repository.id, title: 'Tidy dashboard', prompt: 'Split the dashboard into focused pages.', tasks: [
    { name: 'Dashboard', role: 'Implementation', task: 'Build the dashboard page.' },
    { name: 'Habits', role: 'Implementation', task: 'Build the habits page.' },
    { name: 'Settings', role: 'Implementation', task: 'Build the settings page.' },
  ] });
  return { coordinator, repository, created };
}

async function failedAttempt(coordinator: GitflareCoordinator, mission: Mission, failedNames = ['Habits']): Promise<Mission> {
  const started = await coordinator.startMission(`start-${mission.id}`, mission.id);
  const shas = [dashboardSha, habitsSha, '3'.repeat(40)];
  const runs = started.runs.map((run, index) => failedNames.includes(run.name)
    ? { ...run, status: 'failed' as const, error: 'Model returned incomplete Anthropic output (max_tokens)' }
    : { ...run, status: 'completed' as const, commitSha: shas[index], forkName: `gf-${mission.id}-1-${run.id}`, branch: 'gitflare-candidate', summary: `${run.name} done`, touchedFiles: [`src/${run.name}.tsx`], changedFiles: [`src/${run.name}.tsx`] });
  return coordinator.recordExecution(mission.id, started.epoch, {
    runs,
    checks: runs.filter((run) => run.status === 'completed').map((run) => ({ id: `check-${run.id}`, name: `${run.name}: repository tests`, runId: run.id, status: 'passed' as const, candidateSha: run.commitSha!, output: 'ok' })),
    changes: runs.filter((run) => run.status === 'completed').map((run) => ({ path: `src/${run.name}.tsx`, patch: '+x', additions: 1, deletions: 0, runIds: [run.id] })),
    candidateSha: null,
    error: 'One or more agents failed; no integration candidate was approved.',
  }, true);
}

describe('retrying only failed agents', () => {
  it('keeps verified candidates and their evidence, and queues only the failed agent', async () => {
    const { coordinator, created } = workspace();
    const failed = await failedAttempt(coordinator, created);
    expect(failed.status).toBe('failed');
    const retried = await coordinator.retryAgents('retry-1', failed.id, 'retry', undefined);
    expect(retried).toMatchObject({ status: 'queued', epoch: 2, baseSha, candidateSha: null });
    const [dashboard, habits, settings] = retried.runs;
    expect(dashboard).toMatchObject({ status: 'completed', commitSha: dashboardSha, forkName: failed.runs[0]!.forkName, summary: 'Dashboard done', touchedFiles: ['src/Dashboard.tsx'], reusedFromEpoch: 1, candidateBaseSha: baseSha, model: failed.runs[0]!.model });
    expect(settings).toMatchObject({ status: 'completed', reusedFromEpoch: 1 });
    expect(habits).toEqual({ id: failed.runs[1]!.id, name: 'Habits', role: 'Implementation', task: failed.runs[1]!.task, assignment: failed.runs[1]!.assignment, model: failed.runs[1]!.model, modelConfig: failed.runs[1]!.modelConfig, limits: DEFAULT_AGENT_LIMITS, status: 'queued', changedFiles: [] });
    expect(retried.checks.map((check) => check.runId)).toEqual([dashboard!.id, settings!.id]);
    expect(retried.changes.map((change) => change.path)).toEqual(['src/Dashboard.tsx', 'src/Settings.tsx']);
    expect(coordinator.listDispatches()).toEqual([expect.objectContaining({ workflowId: `${failed.id}-2`, epoch: 2 })]);
    expect(retried.events.at(-1)!.message).toBe('Attempt 2 queued to retry 1 agent (Habits). Reusing 2 verified candidates from attempt 1 (Dashboard, Settings) after confirming each commit is still in its fork.');
    expect(coordinator.listAttempts(failed.id).map((attempt) => attempt.reason)).toContain('retry');
  });

  it('is idempotent per request key and refuses a second retry while the first is active', async () => {
    const { coordinator, created } = workspace();
    const failed = await failedAttempt(coordinator, created);
    const first = await coordinator.retryAgents('retry-same', failed.id, 'retry', undefined);
    const replay = await coordinator.retryAgents('retry-same', failed.id, 'retry', undefined);
    expect(replay.epoch).toBe(first.epoch);
    expect(coordinator.listDispatches()).toHaveLength(1);
    await expect(coordinator.retryAgents('retry-same', failed.id, 'drop', undefined)).rejects.toThrow('IDEMPOTENCY');
    await expect(coordinator.retryAgents('retry-other', failed.id, 'retry', undefined)).rejects.toThrow('MISSION_NOT_FAILED');
  });

  it('reruns named agents too, and rejects unknown agents and missions that did not fail', async () => {
    const { coordinator, created } = workspace();
    const failed = await failedAttempt(coordinator, created);
    await expect(coordinator.retryAgents('retry-unknown', failed.id, 'retry', ['not-an-agent'])).rejects.toThrow('UNKNOWN_AGENT');
    const retried = await coordinator.retryAgents('retry-named', failed.id, 'retry', [failed.runs[0]!.id]);
    expect(retried.runs.map((run) => run.status)).toEqual(['queued', 'queued', 'completed']);
    expect(retried.checks.map((check) => check.runId)).toEqual([failed.runs[2]!.id]);
    const fresh = workspace();
    await expect(fresh.coordinator.retryAgents('draft', fresh.created.id, 'retry', undefined)).rejects.toThrow('MISSION_NOT_FAILED');
    const allPassed = workspace();
    const combineFailed = await failedAttempt(allPassed.coordinator, allPassed.created, []);
    await expect(allPassed.coordinator.retryAgents('drop-none', combineFailed.id, 'drop', undefined)).rejects.toThrow('NO_FAILED_AGENTS');
    const recombined = await allPassed.coordinator.retryAgents('combine-only', combineFailed.id, 'retry', undefined);
    expect(recombined).toMatchObject({ status: 'queued', epoch: combineFailed.epoch + 1 });
    expect(recombined.runs.every((run) => run.status === 'completed' && run.reusedFromEpoch === combineFailed.epoch)).toBe(true);
    expect(recombined.events.at(-1)?.message).toContain('combine again without rerunning any agent');
  });

  it('records a moved base so carried-over candidates are re-checked', async () => {
    const { coordinator, created, repository } = workspace();
    const failed = await failedAttempt(coordinator, created);
    coordinator.saveRepository({ ...repository, headSha: movedSha });
    const retried = await coordinator.retryAgents('retry-moved', failed.id, 'retry', undefined);
    expect(retried.baseSha).toBe(movedSha);
    expect(retried.runs[0]).toMatchObject({ candidateBaseSha: baseSha, reusedFromEpoch: 1 });
    expect(retried.events.at(-1)!.message).toContain(`The default branch moved from ${baseSha.slice(0, 12)} to ${movedSha.slice(0, 12)}, so reused candidates are merged onto the new base and the combined checks re-verify them.`);
  });

  it('validates requested agent IDs', () => {
    expect(agentRunIds(undefined)).toBeUndefined();
    expect(agentRunIds(['a', 'a', 'b'])).toEqual(['a', 'b']);
    expect(() => agentRunIds('a')).toThrow('INVALID_INPUT');
    expect(() => agentRunIds(['../x'])).toThrow('INVALID_INPUT');
    expect(() => agentRunIds(Array.from({ length: 11 }, (_, i) => `r${i}`))).toThrow('INVALID_INPUT');
  });
});

describe('continuing without failed agents', () => {
  it('marks failed agents skipped with a reason and lets the combined candidate pass review', async () => {
    const { coordinator, created } = workspace();
    const failed = await failedAttempt(coordinator, created);
    const dropped = await coordinator.retryAgents('drop-1', failed.id, 'drop', undefined);
    expect(dropped).toMatchObject({ status: 'queued', epoch: 2, acceptanceCriteria: failed.acceptanceCriteria });
    expect(dropped.runs.map((run) => run.status)).toEqual(['completed', 'skipped', 'completed']);
    expect(dropped.runs[1]).toMatchObject({ skipReason: 'Excluded in attempt 2 after it failed: Model returned incomplete Anthropic output (max_tokens)' });
    expect(dropped.runs[1]!.error).toBeUndefined();
    expect(dropped.events.at(-1)).toMatchObject({ type: 'warning', message: expect.stringContaining('Attempt 2 queued without 1 agent (Habits), now marked skipped.') });
    const candidate = 'c'.repeat(40);
    const reviewed = coordinator.recordExecution(failed.id, 2, { runs: dropped.runs, checks: [...dropped.checks, { id: 'integration', name: 'Combined candidate tests', status: 'passed', candidateSha: candidate }], changes: dropped.changes, candidateSha: candidate, integrationForkName: 'gf-integration' }, true);
    expect(reviewed.status).toBe('needs_review');
  });

  it('refuses when no agent has a verified candidate', async () => {
    const { coordinator, created } = workspace();
    const failed = await failedAttempt(coordinator, created, ['Dashboard', 'Habits', 'Settings']);
    await expect(coordinator.retryAgents('drop-none', failed.id, 'drop', undefined)).rejects.toThrow('NO_COMPLETED_AGENTS');
    expect(coordinator.getMission(failed.id)!.epoch).toBe(1);
  });
});

const integratedSha = 'c'.repeat(40);

async function combinedAttempt(coordinator: GitflareCoordinator, mission: Mission, collided?: { name: string; files: string[] }): Promise<Mission> {
  const started = await coordinator.startMission(`start-${mission.id}`, mission.id);
  const shas = [dashboardSha, habitsSha, '3'.repeat(40)];
  const runs = started.runs.map((run, index) => ({ ...run, status: 'completed' as const, commitSha: shas[index], forkName: `gf-${mission.id}-1-${run.id}`, branch: 'gitflare-candidate', summary: `${run.name} done`, changedFiles: [`src/${run.name}.tsx`], ...(collided?.name === run.name ? { collision: { files: collided.files, epoch: 1 } } : {}) }));
  const checks = runs.map((run) => ({ id: `check-${run.id}`, name: `${run.name}: repository tests`, runId: run.id, status: 'passed' as const, candidateSha: run.commitSha!, output: 'ok' }));
  return coordinator.recordExecution(mission.id, started.epoch, collided
    ? { runs, checks: [...checks, { id: 'integration-merge', name: 'Combine agent changes', status: 'failed' as const, output: 'Collision' }], candidateSha: null, error: `Agent changes collide (Git merge conflict) when adding ${collided.name}` }
    : { runs, checks: [...checks, { id: 'integration', name: 'Combined candidate tests', status: 'passed' as const, candidateSha: integratedSha, output: 'ok' }], candidateSha: integratedSha, integrationForkName: `gf-${mission.id}-1-integration` }, true);
}

describe('retry guidance', () => {
  it('appends guidance to the retried agents only and records it in the event', async () => {
    const { coordinator, created } = workspace();
    const failed = await failedAttempt(coordinator, created);
    const guidance = 'Pin "wrangler": "4.149.0" and "@cloudflare/workers-types": "^5.20261006.1".';
    const retried = await coordinator.retryAgents('retry-guided', failed.id, 'retry', undefined, undefined, undefined, guidance);
    expect(retried.runs.find((run) => run.name === 'Habits')).toMatchObject({ status: 'queued', retryGuidance: guidance });
    expect(retried.runs.find((run) => run.name === 'Dashboard')!.retryGuidance).toBeUndefined();
    expect(retried.events.at(-1)!.message).toContain(`Guidance from the requester: "${guidance}"`);
    const again = await coordinator.retryAgents('retry-guided', failed.id, 'retry', undefined, undefined, undefined, guidance);
    expect(again.epoch).toBe(retried.epoch);
  });

  it('validates guidance length', async () => {
    const { retryGuidance } = await import('../src/worker/domain');
    expect(retryGuidance(undefined)).toBeUndefined();
    expect(retryGuidance('  keep it small  ')).toBe('keep it small');
    expect(() => retryGuidance('x'.repeat(2001))).toThrow('at most 2000');
    expect(() => retryGuidance(42)).toThrow('guidance must be text');
  });
});

describe('collided agents', () => {
  it('reruns the collided agent on top of the other verified candidates', async () => {
    const { coordinator, created } = workspace();
    const failed = await combinedAttempt(coordinator, created, { name: 'Habits', files: ['src/shared.ts'] });
    expect(failed.status).toBe('failed');
    const retried = await coordinator.retryAgents('retry-collided', failed.id, 'retry', undefined);
    const habits = retried.runs.find((run) => run.name === 'Habits')!;
    expect(habits.status).toBe('queued');
    expect(habits.startFrom).toEqual({ reason: 'collision', files: ['src/shared.ts'], candidates: [
      { runId: failed.runs[0]!.id, name: 'Dashboard', forkName: failed.runs[0]!.forkName, commitSha: dashboardSha },
      { runId: failed.runs[2]!.id, name: 'Settings', forkName: failed.runs[2]!.forkName, commitSha: '3'.repeat(40) },
    ] });
    expect(retried.runs.filter((run) => run.reusedFromEpoch === 1).map((run) => run.name)).toEqual(['Dashboard', 'Settings']);
    expect(retried.events.at(-1)!.message).toContain('Habits starts from the merged candidates of Dashboard, Settings to resolve the collision in src/shared.ts.');
  });

  it('lets drop_failed skip the collided agent instead of refusing', async () => {
    const { coordinator, created } = workspace();
    const failed = await combinedAttempt(coordinator, created, { name: 'Habits', files: ['src/shared.ts'] });
    const dropped = await coordinator.retryAgents('drop-collided', failed.id, 'drop', undefined);
    expect(dropped.runs.find((run) => run.name === 'Habits')!.status).toBe('skipped');
  });
});

describe('addressing a review', () => {
  it('sends open change requests to every verified agent, starting from the reviewed candidate', async () => {
    const { coordinator, created } = workspace();
    const review = await combinedAttempt(coordinator, created);
    expect(review.status).toBe('needs_review');
    await expect(coordinator.retryAgents('address-empty', review.id, 'review', undefined)).rejects.toThrow('NO_CHANGE_REQUESTS');
    coordinator.reviewMission('request', review.id, { action: 'request_changes', epoch: review.epoch, candidateSha: integratedSha, baseSha, body: 'Call readJpegOrientation from the formats module.' }, 'reviewer');
    const addressed = await coordinator.retryAgents('address', review.id, 'review', undefined, undefined, undefined, 'Keep the public API unchanged.');
    expect(addressed).toMatchObject({ status: 'queued', epoch: 2, candidateSha: null });
    const candidates = review.runs.map((run) => ({ runId: run.id, name: run.name, forkName: run.forkName, commitSha: run.commitSha }));
    for (const run of addressed.runs) {
      expect(run.status).toBe('queued');
      expect(run.startFrom).toEqual({ reason: 'review', candidates });
      expect(run.retryGuidance).toBe('Reviewer change requests on the previous candidate:\n- Call readJpegOrientation from the formats module.\n\nKeep the public API unchanged.');
    }
    expect(addressed.events.at(-1)!.message).toContain('Attempt 2 queued to address 1 change request with Dashboard, Habits, Settings, starting from the reviewed candidate.');
  });

  it('can target one agent and refuses missions that are not in review', async () => {
    const { coordinator, created } = workspace();
    const failed = await failedAttempt(coordinator, created);
    await expect(coordinator.retryAgents('address-failed', failed.id, 'review', undefined, undefined, undefined, 'x')).rejects.toThrow('MISSION_NOT_IN_REVIEW');
    const other = workspace();
    const review = await combinedAttempt(other.coordinator, other.created);
    const habits = review.runs[1]!.id;
    const addressed = await other.coordinator.retryAgents('address-one', review.id, 'review', [habits], undefined, undefined, 'Handle empty input.');
    expect(addressed.runs.map((run) => [run.name, run.status])).toEqual([['Dashboard', 'completed'], ['Habits', 'queued'], ['Settings', 'completed']]);
    expect(addressed.runs[1]!.startFrom!.candidates.map((candidate) => candidate.name)).toEqual(['Dashboard', 'Habits', 'Settings']);
  });
});

describe('retrying never discards earlier work', () => {
  it('resumes a verified agent named in run_ids from its own candidate instead of the mission base', async () => {
    const { coordinator, created } = workspace();
    const failed = await failedAttempt(coordinator, created);
    const dashboard = failed.runs[0]!;
    const retried = await coordinator.retryAgents('retry-verified', failed.id, 'retry', [dashboard.id]);
    expect(retried.runs[0]).toMatchObject({ status: 'queued', startFrom: { reason: 'retry', candidates: [{ runId: dashboard.id, name: 'Dashboard', forkName: dashboard.forkName, commitSha: dashboardSha }] } });
    expect(retried.runs[0]!.startFrom!.previousError).toBeUndefined();
    expect(retried.events.at(-1)!.message).toContain('Dashboard resumes from its previous candidate or starting point instead of the mission base.');
  });

  it('resumes a failed agent that pushed a candidate and tells it why that attempt failed', async () => {
    const { coordinator, created } = workspace();
    const started = await coordinator.startMission('start', created.id);
    const runs = started.runs.map((run, index) => ({ ...run, status: index === 1 ? 'failed' as const : 'completed' as const, commitSha: String(index + 1).repeat(40), forkName: `fork-${run.id}`, changedFiles: [`src/${run.name}.tsx`], ...(index === 1 ? { error: 'Candidate checks failed: not ok 3 - wraps negative zero' } : {}) }));
    const failed = coordinator.recordExecution(created.id, started.epoch, { runs, checks: runs.map((run) => ({ id: `check-${run.id}`, name: run.name, runId: run.id, status: run.status === 'completed' ? 'passed' as const : 'failed' as const, candidateSha: run.commitSha })), changes: [], candidateSha: null, error: 'One agent failed.' }, true);
    const retried = await coordinator.retryAgents('retry-own', failed.id, 'retry', undefined);
    expect(retried.runs[1]).toMatchObject({ status: 'queued', startFrom: { reason: 'retry', previousError: 'Candidate checks failed: not ok 3 - wraps negative zero', candidates: [{ runId: runs[1]!.id, commitSha: '2'.repeat(40), forkName: `fork-${runs[1]!.id}` }] } });
  });

  it('keeps the reviewed starting point and change requests when a failed review round is retried', async () => {
    const { coordinator, created } = workspace();
    const review = await combinedAttempt(coordinator, created);
    coordinator.reviewMission('request', review.id, { action: 'request_changes', epoch: review.epoch, candidateSha: integratedSha, baseSha, body: 'Use a 64-tick client ring.' }, 'reviewer');
    const habits = review.runs[1]!.id;
    const addressed = await coordinator.retryAgents('address', review.id, 'review', [habits]);
    const reviewStart = addressed.runs[1]!.startFrom;
    const requests = addressed.runs[1]!.retryGuidance!;
    expect(requests).toContain('Use a 64-tick client ring.');
    const failedRound = coordinator.recordExecution(review.id, addressed.epoch, { runs: addressed.runs.map((run) => run.id === habits ? { ...run, status: 'failed' as const, error: 'Runner timed out' } : run), checks: addressed.checks, changes: addressed.changes, candidateSha: null, error: 'One agent failed.' }, true);
    expect(failedRound.status).toBe('failed');
    const retried = await coordinator.retryAgents('retry-round', review.id, 'retry', undefined, undefined, undefined, 'Batch acks with a token bucket.');
    const rerun = retried.runs.find((run) => run.id === habits)!;
    expect(rerun.startFrom).toEqual(reviewStart);
    expect(rerun.retryGuidance).toBe(`${requests}\n\nBatch acks with a token bucket.`);
    expect(retried.runs.filter((run) => run.reusedFromEpoch !== undefined).map((run) => run.name)).toEqual(['Dashboard', 'Settings']);
  });
});

describe('mission candidate prefixes', () => {
  it('finds candidate commits by a prefix of at least 7 characters', async () => {
    const { coordinator, created } = workspace();
    await failedAttempt(coordinator, created);
    expect(coordinator.missionCandidateShas(dashboardSha.slice(0, 8))).toEqual([dashboardSha]);
    expect(coordinator.missionCandidateShas(dashboardSha.slice(0, 6))).toEqual([]);
    expect(coordinator.missionCandidateShas('f'.repeat(8))).toEqual([]);
  });
});
