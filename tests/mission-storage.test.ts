import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileChange, Mission, MissionAttempt, Repository } from '../src/shared/types';
import type { AppEnv } from '../src/worker/env';
import { GitflareCoordinator } from '../src/worker/coordinator';
import { MISSION_BLOB_MIN_CHARS, summarizeMission } from '../src/worker/mission-storage';
import { securityHarness } from './security-harness';

vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: DurableObjectState, protected env: AppEnv) {} }, WorkerEntrypoint: class {}, WorkflowEntrypoint: class {} }));

const baseSha = 'a'.repeat(40);
const candidateSha = 'b'.repeat(40);
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function durable() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  const ctx = {
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      sql: { exec(query: string, ...args: SQLInputValue[]) { const statement = db.prepare(query); const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []); return { toArray: () => rows }; } },
      transactionSync<T>(fn: () => T): T { db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    },
  } as unknown as DurableObjectState;
  const coordinator = new GitflareCoordinator(ctx, {} as AppEnv);
  const rows = (prefix: string) => db.prepare('SELECT key, length(value) AS bytes FROM records WHERE key >= ? AND key < ? ORDER BY key').all(prefix, `${prefix}￿`) as { key: string; bytes: number }[];
  const raw = (key: string) => JSON.parse((db.prepare('SELECT value FROM records WHERE key = ?').get(key) as { value: string }).value);
  const writeRaw = (key: string, value: unknown) => db.prepare('INSERT INTO records (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  return { coordinator, db, rows, raw, writeRaw };
}

const repository: Repository = { id: 'repo', name: 'capacity-lab', description: '', defaultBranch: 'main', headSha: baseSha, provider: 'artifacts', createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z' };

function patchFor(agent: number, file: number) {
  return Array.from({ length: 300 }, (_, line) => `+agent ${agent} file ${file} line ${line} ${'x'.repeat(24)}`).join('\n').slice(0, 12_000);
}

function largeResult(mission: Mission, agents: number, files: number) {
  const changes: FileChange[] = [];
  for (let agent = 0; agent < agents; agent++) for (let file = 0; file < files; file++) changes.push({ path: `src/agent-${agent}/file-${file}.ts`, additions: 300, deletions: 0, patch: patchFor(agent, file), runIds: [mission.runs[agent % mission.runs.length]!.id] });
  return {
    candidateSha, integrationForkName: 'fork',
    runs: mission.runs.map((run) => ({ ...run, status: 'completed' as const, commitSha: candidateSha, forkName: `fork-${run.id}`, summary: 'Done' })),
    checks: mission.runs.map((run) => ({ id: `check-${run.id}`, name: `${run.name}: repository tests`, runId: run.id, status: 'passed' as const, candidateSha, output: 'ok '.repeat(4000) })),
    changes,
  };
}

async function largeMission(context: ReturnType<typeof durable>, agents = 6, files = 40) {
  const { coordinator } = context;
  coordinator.saveRepository(repository);
  const tasks = Array.from({ length: agents }, (_, index) => ({ name: `Agent ${index + 1}`, role: 'Implementation', task: `Implement the separately assigned change number ${index + 1}.` }));
  const draft = coordinator.createMission('create-large', { repositoryId: repository.id, title: 'Large change', prompt: 'Change many files across the repository.', tasks });
  const started = await coordinator.startMission('start-large', draft.id);
  return coordinator.recordExecution(draft.id, started.epoch, largeResult(started, agents, files), true);
}

describe('mission storage layout', () => {
  it('keeps the mission row small and stores each distinct patch once across attempt snapshots', async () => {
    const context = durable();
    const mission = await largeMission(context);
    const fullBytes = JSON.stringify(mission).length;
    expect(fullBytes).toBeGreaterThan(2_000_000);
    const [core] = context.rows('mission:');
    expect(core!.bytes).toBeLessThan(150_000);
    context.coordinator.approveMission('approve', mission.id, candidateSha, baseSha);
    context.coordinator.revokeApproval('revoke', mission.id, candidateSha, baseSha);
    const attempts = context.rows(`attempt:${mission.id}:`);
    expect(attempts.length).toBe(4);
    for (const attempt of attempts) expect(attempt.bytes).toBeLessThan(150_000);
    const distinct = new Set([...mission.changes.map((change) => change.patch), ...mission.checks.map((check) => check.output), ...mission.runs.map((run) => run.task)].filter((value) => value && value.length >= MISSION_BLOB_MIN_CHARS));
    expect(context.rows(`mission-blob:${mission.id}:`)).toHaveLength(distinct.size);
    const detail = context.coordinator.getMission(mission.id)!;
    expect(detail.changes).toEqual(mission.changes);
    expect(detail.checks).toEqual(mission.checks);
    expect(detail.runs).toEqual(mission.runs);
    const history = context.coordinator.listAttempts(mission.id);
    expect(history.find((attempt) => attempt.reason === 'completed')!.snapshot.changes).toEqual(mission.changes);
  });

  it('returns lightweight summaries while the detail read keeps every patch and log', async () => {
    const context = durable();
    const mission = await largeMission(context);
    const [summary] = context.coordinator.listMissionSummaries();
    const summaryBytes = JSON.stringify(summary).length;
    const detailBytes = JSON.stringify(context.coordinator.getMission(mission.id)).length;
    expect(summaryBytes * 50).toBeLessThan(detailBytes);
    expect(summary).toMatchObject({ id: mission.id, status: 'needs_review', candidateSha, changeCount: 240, additions: 240 * 300, eventCount: mission.events.length, openChangeRequests: 0 });
    expect(summary).not.toHaveProperty('changes');
    expect(summary).not.toHaveProperty('authorization');
    expect(summary!.checks.every((check) => !('output' in check))).toBe(true);
    expect(summary!.runs.every((run) => !('task' in run) && run.assignment.startsWith('Implement'))).toBe(true);
    expect(summary).toEqual(summarizeMission(context.coordinator.getMission(mission.id)!));
  });

  it('reads and lazily migrates legacy single-row missions and snapshots without losing data', async () => {
    const context = durable();
    context.coordinator.saveRepository(repository);
    const draft = context.coordinator.createMission('create-legacy', { repositoryId: repository.id, title: 'Legacy', prompt: 'Recorded before split storage.', tasks: [{ name: 'Agent', role: 'Implementation', task: 'Change the configuration file.' }] });
    const legacy: Mission = { ...draft, status: 'needs_review', epoch: 1, candidateSha, runs: draft.runs.map((run) => ({ ...run, status: 'completed', commitSha: candidateSha })), checks: [{ id: 'combined', name: 'Combined tests', status: 'passed', candidateSha, output: 'legacy log '.repeat(1200) }], changes: [{ path: 'config.json', additions: 2, deletions: 1, patch: '+legacy\n'.repeat(1500), runIds: [draft.runs[0]!.id] }], reviews: [{ id: 'review-1', kind: 'comment', body: 'Long legacy review. '.repeat(100), authorId: 'owner', createdAt: draft.createdAt, epoch: 1, candidateSha, baseSha }] };
    const legacyAttempt: MissionAttempt = { id: 'attempt-legacy', epoch: 1, recordedAt: '2026-10-13T00:00:00Z', reason: 'completed', snapshot: legacy };
    context.writeRaw(`mission:${legacy.id}`, legacy);
    context.writeRaw(`attempt:${legacy.id}:${legacyAttempt.id}`, legacyAttempt);
    expect(context.rows(`mission-blob:${legacy.id}:`)).toHaveLength(0);

    expect(context.coordinator.listMissionSummaries()[0]).toMatchObject({ id: legacy.id, changeCount: 1, reviewCount: 1 });
    expect(context.raw(`mission:${legacy.id}`).changes[0].patch).toBe(legacy.changes[0]!.patch);

    expect(context.coordinator.getMission(legacy.id)).toEqual(legacy);
    const migrated = context.raw(`mission:${legacy.id}`);
    expect(migrated.changes[0].patch).toEqual({ $blob: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(migrated.reviews[0].body).toEqual({ $blob: expect.any(String) });
    expect(context.coordinator.getMission(legacy.id)).toEqual(legacy);

    expect(context.coordinator.listAttempts(legacy.id)).toEqual([legacyAttempt]);
    expect(context.raw(`attempt:${legacy.id}:${legacyAttempt.id}`).snapshot.checks[0].output).toEqual({ $blob: expect.any(String) });
    expect(context.coordinator.listAttempts(legacy.id)).toEqual([legacyAttempt]);
    expect(context.rows(`mission-blob:${legacy.id}:`)).toHaveLength(3);

    const restarted = new GitflareCoordinator((context.coordinator as unknown as { ctx: DurableObjectState }).ctx, {} as AppEnv);
    expect(restarted.getMission(legacy.id)).toEqual(legacy);
  });

  it('migrates a legacy row on its next write and keeps unchanged evidence', async () => {
    const context = durable();
    context.coordinator.saveRepository(repository);
    const draft = context.coordinator.createMission('create-write', { repositoryId: repository.id, title: 'Legacy write', prompt: 'Recorded before split storage.' });
    const legacy: Mission = { ...draft, status: 'failed', epoch: 1, changes: [{ path: 'a.ts', additions: 1, deletions: 0, patch: '+a\n'.repeat(400), runIds: [] }] };
    context.writeRaw(`mission:${legacy.id}`, legacy);
    const cancelled = context.coordinator.cancelMission('cancel-legacy', legacy.id);
    expect(cancelled.changes).toEqual(legacy.changes);
    expect(context.raw(`mission:${legacy.id}`).changes[0].patch).toEqual({ $blob: expect.any(String) });
    expect(context.coordinator.getMission(legacy.id)!.changes).toEqual(legacy.changes);
    expect(context.coordinator.listAttempts(legacy.id)[0]!.snapshot.changes).toEqual(legacy.changes);
  });

  it('indexes mission ownership for constant-time lookups', () => {
    const { coordinator } = durable();
    expect(coordinator.missionRepository('mission-1')).toBeUndefined();
    coordinator.indexMission('mission-1', 'repo');
    expect(coordinator.missionRepository('mission-1')).toBe('repo');
    expect(coordinator.listMissionSummaries()).toEqual([]);
  });
});

describe('mission lookup and batched access over HTTP', () => {
  const token = 'storage-owner-token-'.repeat(3);

  async function fixture(repositoryCount: number) {
    const security = securityHarness();
    const catalog = durable().coordinator;
    const repositories = Array.from({ length: repositoryCount }, (_, index) => ({ ...repository, id: `repo-${index}`, name: `repo-${index}` }));
    const coordinators = new Map(repositories.map((item) => { const context = durable(); context.coordinator.saveRepository(item); catalog.saveRepository(item); return [`repository:${item.id}`, context.coordinator]; }));
    const target = coordinators.get(`repository:repo-${repositoryCount - 1}`)!;
    const mission = target.createMission('create-target', { repositoryId: `repo-${repositoryCount - 1}`, title: 'Target', prompt: 'Find this mission quickly.' });
    const selectors: string[] = [];
    const securityCalls = { check: 0, checkMany: 0 };
    const counted = (name: string) => new Proxy(security.namespace.getByName(name), { get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (property === 'shardCall') return (workspaceId: string, op: string, args: unknown[]) => { if (op === 'check' || op === 'checkMany') securityCalls[op]++; return object.shardCall(workspaceId, op, args); };
      if (property === 'check' || property === 'checkMany') securityCalls[property]++;
      return typeof value === 'function' ? value.bind(object) : value;
    } });
    const env = {
      APP_ENV: 'production', OWNER_TOKEN: token, WORKSPACE_NAME: 'Gitflare', GITFLARE_SECURITY: { getByName: counted },
      GITFLARE_COORDINATOR: { getByName: (name: string) => { selectors.push(name); if (name === 'catalog:owner') return catalog; const found = coordinators.get(name); if (!found) throw new Error(`Unexpected selector ${name}`); return found; } },
    } as unknown as AppEnv;
    const worker = (await import('../src/worker/index')).default;
    const get = (path: string) => worker.fetch(new Request(`https://gitflare.test${path}`, { headers: { Authorization: `Bearer ${token}` } }), env);
    return { mission, selectors, securityCalls, get, catalog };
  }

  it('finds a mission by index after the first lookup instead of scanning every repository', async () => {
    const f = await fixture(12);
    expect((await f.get(`/api/missions/${f.mission.id}`)).status).toBe(200);
    expect(f.selectors.filter((name) => name.startsWith('repository:'))).toHaveLength(12);
    expect(f.catalog.missionRepository(f.mission.id)).toBe('repo-11');
    f.selectors.length = 0;
    const detail = await (await f.get(`/api/missions/${f.mission.id}`)).json() as Mission;
    expect(detail.id).toBe(f.mission.id);
    expect(f.selectors.filter((name) => name.startsWith('repository:'))).toEqual(['repository:repo-11']);
    expect((await f.get('/api/missions/unknown-mission')).status).toBe(404);
  });

  it('lists workspace summaries with one batched access read regardless of size', async () => {
    const f = await fixture(12);
    const response = await f.get('/api/workspace');
    expect(response.status).toBe(200);
    const workspace = await response.json() as { repositories: Repository[]; missions: Record<string, unknown>[] };
    expect(workspace.repositories).toHaveLength(12);
    expect(workspace.missions.map((mission) => mission.id)).toEqual([f.mission.id]);
    expect(workspace.missions[0]).toHaveProperty('changeCount', 0);
    expect(workspace.missions[0]).not.toHaveProperty('changes');
    expect(f.securityCalls).toEqual({ check: 0, checkMany: 2 });
  });
});
