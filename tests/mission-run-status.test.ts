import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mission, Repository } from '../src/shared/types';
import type { AppEnv } from '../src/worker/env';
import { draftRuns, GitflareCoordinator } from '../src/worker/coordinator';
import { capacityError, WORKSPACE_MISSION_LIMIT } from '../src/worker/capacity';

vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: DurableObjectState, protected env: AppEnv) {} }, WorkerEntrypoint: class {}, WorkflowEntrypoint: class {} }));

const baseSha = 'a'.repeat(40);
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function coordinator() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  let alarm: number | null = null;
  const ctx = {
    storage: {
      getAlarm: vi.fn(async () => alarm),
      setAlarm: vi.fn(async (when: number) => { alarm = when; }),
      sql: { exec(query: string, ...args: SQLInputValue[]) { const statement = db.prepare(query); const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []); return { toArray: () => rows }; } },
      transactionSync<T>(fn: () => T): T { db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as DurableObjectState;
  const value = new GitflareCoordinator(ctx, {} as AppEnv);
  const now = new Date().toISOString();
  const repository: Repository = { id: 'repo', name: 'chat', description: '', defaultBranch: 'main', headSha: baseSha, provider: 'artifacts', createdAt: now, updatedAt: now };
  value.saveRepository(repository);
  return value;
}

describe('mission run status', () => {
  it('reports the runs of a draft mission as draft until it is started', async () => {
    const book = coordinator();
    const mission = book.createMission('create-draft', { repositoryId: 'repo', title: 'Chat', prompt: 'Build a chat room.', mode: 'race' });
    expect(mission.status).toBe('draft');
    expect(mission.runs.map((run) => run.status)).toEqual(['draft', 'draft']);
    expect(book.getMission(mission.id)!.runs.map((run) => run.status)).toEqual(['draft', 'draft']);
    const started = await book.startMission('start-draft', mission.id);
    expect(started.runs.map((run) => run.status)).toEqual(['queued', 'queued']);
    expect(book.listMissions()[0].runs.map((run) => run.status)).toEqual(['queued', 'queued']);
  });

  it('shows draft for runs stored as queued on missions created before the draft run status', () => {
    const legacy = { status: 'draft', runs: [{ id: 'a', status: 'queued' }, { id: 'b', status: 'skipped' }] } as unknown as Mission;
    expect(draftRuns(legacy).runs.map((run) => run.status)).toEqual(['draft', 'skipped']);
    const queued = { ...legacy, status: 'queued' } as Mission;
    expect(draftRuns(queued)).toBe(queued);
  });

  it('finds the mission and fork holding a combined or race candidate commit', () => {
    const book = coordinator();
    const mission = book.createMission('create-candidates', { repositoryId: 'repo', title: 'Chat', prompt: 'Build a chat room.', mode: 'race' });
    const internal = book as unknown as { store: { put(key: string, value: unknown): void } };
    internal.store.put(`mission:${mission.id}`, { ...mission, status: 'needs_review', candidateSha: 'c'.repeat(40), integrationForkName: 'fork-combined', runs: mission.runs.map((run, index) => ({ ...run, status: 'completed', commitSha: String(index + 1).repeat(40), forkName: `fork-${index}` })) });
    expect(book.missionCandidate('c'.repeat(40))).toEqual({ missionId: mission.id, forkName: 'fork-combined' });
    expect(book.missionCandidate('2'.repeat(40))).toEqual({ missionId: mission.id, forkName: 'fork-1' });
    expect(book.missionCandidate('9'.repeat(40))).toBeUndefined();
  });

  it('states the workspace mission limit and the per-mission agent concurrency together', () => {
    expect(WORKSPACE_MISSION_LIMIT).toBe(2);
    expect(capacityError('mission').detail).toBe('This workspace is already running 2 missions, the most it can run at once (each mission runs up to three agents at a time). Wait for one to finish or cancel it, then start again.');
  });
});
