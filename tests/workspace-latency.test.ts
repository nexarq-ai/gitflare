import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MissionSummary, Repository } from '../src/shared/types';
import type { AppEnv } from '../src/worker/env';
import { GitflareCoordinator, type MissionSummaryCache } from '../src/worker/coordinator';
import { collectMissionSummaries } from '../src/worker/workspace-summaries';
import { securityHarness } from './security-harness';

vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: DurableObjectState, protected env: AppEnv) {} }, WorkerEntrypoint: class {}, WorkflowEntrypoint: class {} }));

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
  return new GitflareCoordinator(ctx, {} as AppEnv);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const base: Repository = { id: 'repo', name: 'repo', description: '', defaultBranch: 'main', headSha: null, provider: 'artifacts', createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z' };

async function fixture(repositoryCount: number, missionsPerRepository: number, rpcMs: number) {
  const token = 'latency-owner-token-'.repeat(3);
  const security = securityHarness();
  const catalog = durable();
  const coordinators = new Map<string, GitflareCoordinator>();
  for (let index = 0; index < repositoryCount; index++) {
    const item = { ...base, id: `repo-${index}`, name: `repo-${index}` };
    const coordinator = durable();
    coordinator.saveRepository(item); catalog.saveRepository(item);
    for (let mission = 0; mission < missionsPerRepository; mission++) coordinator.createMission(`create-${mission}`, { repositoryId: item.id, title: `Mission ${mission}`, prompt: 'Measure the workspace route.' });
    coordinators.set(`repository:${item.id}`, coordinator);
  }
  const calls: string[] = [];
  const extraDelay = new Map<string, number>();
  const delayed = <T extends object>(label: string, target: T): T => new Proxy(target, { get(object, property, receiver) {
    const value = Reflect.get(object, property, receiver);
    if (typeof value !== 'function') return value;
    return async (...args: unknown[]) => { calls.push(`${label}.${String(property)}${property === 'shardCall' ? `:${String(args[1])}` : ''}`); await sleep(rpcMs + (extraDelay.get(label) ?? 0)); return value.apply(object, args); };
  } });
  const env = {
    APP_ENV: 'production', OWNER_TOKEN: token, WORKSPACE_NAME: 'Gitflare',
    GITFLARE_SECURITY: { getByName: (name: string) => delayed('security', security.namespace.getByName(name)) },
    GITFLARE_COORDINATOR: { getByName: (name: string) => name === 'catalog:owner' ? delayed('catalog', catalog) : delayed(name, coordinators.get(name)!) },
  } as unknown as AppEnv;
  const deferred: Promise<unknown>[] = [];
  const ctx = { waitUntil: (work: Promise<unknown>) => { deferred.push(work); }, passThroughOnException() {} } as unknown as ExecutionContext;
  const worker = (await import('../src/worker/index')).default;
  const get = async () => {
    const started = performance.now();
    const response = await worker.fetch(new Request('https://gitflare.test/api/workspace', { headers: { Authorization: `Bearer ${token}` } }), env, ctx);
    return { response, elapsed: performance.now() - started };
  };
  return { get, calls, catalog, coordinators, extraDelay, settle: () => Promise.all(deferred.splice(0)) };
}

describe('workspace route latency', () => {
  it.each([[1, 5], [12, 5], [40, 20]])('answers %i repositories with %i missions each in four sequential Durable Object rounds', async (repositories, missions) => {
    const rpcMs = 250;
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = await fixture(repositories, missions, rpcMs);
    await f.get(); await f.settle();
    f.calls.length = 0; logs.mockClear();
    const { response, elapsed } = await f.get();
    expect(response.status).toBe(200);
    expect((await response.json() as { missions: unknown[] }).missions).toHaveLength(repositories * missions);
    expect(elapsed).toBeLessThan(rpcMs * 6);
    expect(f.calls.filter(call => call === 'security.shardCall:checkMany')).toHaveLength(2);
    const timing = logs.mock.calls.map(([line]) => String(line)).find(line => line.includes('workspace_timing'))!;
    expect(JSON.parse(timing)).toMatchObject({ event: 'workspace_timing', repositories, missions: repositories * missions, staleRepositories: 0, totalMs: expect.any(Number) });
    expect(timing).not.toMatch(/repo-|Mission|owner/);
    logs.mockRestore();
  });

  it('serves cached summaries for a repository that misses the deadline and refreshes the cache afterwards', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = await fixture(3, 2, 5);
    await f.get(); await f.settle();
    expect(f.catalog.listSummaryCache().map(entry => entry.repositoryId).sort()).toEqual(['repo-0', 'repo-1', 'repo-2']);
    f.coordinators.get('repository:repo-1')!.createMission('create-late', { repositoryId: 'repo-1', title: 'Late mission', prompt: 'Created while the repository is slow.' });
    f.extraDelay.set('repository:repo-1', 4_000);
    const { response, elapsed } = await f.get();
    expect(elapsed).toBeLessThan(3_500);
    const titles = (await response.json() as { missions: { title: string }[] }).missions.map(mission => mission.title);
    expect(titles).toHaveLength(6);
    expect(titles).not.toContain('Late mission');
    await f.settle();
    expect(f.catalog.listSummaryCache().find(entry => entry.repositoryId === 'repo-1')!.summaries.map(mission => mission.title)).toContain('Late mission');
    vi.restoreAllMocks();
  }, 20_000);
});

describe('mission summary collection', () => {
  const summary = (id: string, repositoryId: string) => ({ id, repositoryId, title: id }) as unknown as MissionSummary;

  it('waits for repositories without a cache, falls back to the cache on failure and saves only changes', async () => {
    const saved: MissionSummaryCache[][] = [];
    const deferred: Promise<unknown>[] = [];
    const cached: MissionSummaryCache[] = [{ repositoryId: 'a', summaries: [summary('a1', 'a')], cachedAt: '' }, { repositoryId: 'b', summaries: [summary('b-old', 'b')], cachedAt: '' }];
    const result = await collectMissionSummaries(['a', 'b', 'c'], {
      live: async id => { if (id === 'b') throw new Error('unavailable'); await sleep(id === 'c' ? 30 : 0); return [summary(`${id}1`, id)]; },
      cached, save: async entries => { saved.push(entries); }, defer: work => { deferred.push(work); }, deadlineMs: 10,
    });
    expect(result.summaries.map(item => item.id)).toEqual(['a1', 'b-old', 'c1']);
    expect(result.stale).toBe(1);
    await Promise.all(deferred);
    expect(saved).toEqual([[{ repositoryId: 'c', summaries: [summary('c1', 'c')], cachedAt: expect.any(String) }]]);
  });

  it('fails like before when a repository without a cache fails', async () => {
    await expect(collectMissionSummaries(['a'], { live: async () => { throw new Error('unavailable'); }, cached: [], save: async () => {}, defer: work => { void work; } })).rejects.toThrow('unavailable');
  });
});
