import { describe, expect, it, vi } from 'vitest';
import type { Repository } from '../src/shared/types';
import type { AppEnv } from '../src/worker/env';
import { applyImportChange, IMPORT_REGISTRY, newImportJob, type ImportChange, type ImportRegistryEntry, type StoredImport } from '../src/worker/github-import';
import { runGithubImportCron } from '../src/worker/github-import-runtime';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {}, WorkflowEntrypoint: class {} }));

const now = Date.parse('2026-10-20T12:00:00.000Z');
const iso = (offset: number) => new Date(now + offset).toISOString();
const principal = { userId: 'owner-1', workspaceId: 'w1', role: 'Owner' as const };

function store() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: <T>(key: string) => values.has(key) ? structuredClone(values.get(key)) as T : undefined,
    put: (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
    delete: (key: string) => { values.delete(key); },
    list: <T>(prefix: string) => [...values.keys()].filter(key => key.startsWith(prefix)).sort().map(key => structuredClone(values.get(key)) as T),
  };
}

function environment(jobs: Record<string, StoredImport | null>) {
  const registry = new Map<string, ImportRegistryEntry>(Object.keys(jobs).map(id => [id, { repositoryId: id, workspaceId: 'w1' }]));
  const stores = new Map(Object.entries(jobs).map(([id, job]) => { const s = store(); if (job) s.put('github-import', job); return [id, s]; }));
  const created: { id: string; params: { runId: string; generation: number } }[] = [];
  const repository = (id: string): Repository => ({ id, workspaceId: 'w1', name: id, description: '', defaultBranch: 'main', provider: 'artifacts', headSha: 'a'.repeat(40), createdAt: iso(0), updatedAt: iso(0) });
  const env = {
    GITFLARE_COORDINATOR: {
      getByName(name: string) {
        if (name === IMPORT_REGISTRY) return { githubImportRegistry: async () => [...registry.values()], registerGithubImport: async (entry: ImportRegistryEntry, enabled: boolean) => { if (enabled) registry.set(entry.repositoryId, entry); else registry.delete(entry.repositoryId); } };
        const id = name.replace('repository:', '');
        const s = stores.get(id);
        return { getRepository: async () => s ? repository(id) : undefined, githubImport: async () => s?.get<StoredImport>('github-import') ?? null, changeGithubImport: async (change: ImportChange) => applyImportChange(s!, change) };
      },
    },
    MISSION_WORKFLOW: { create: async (options: { id: string; params: { runId: string; generation: number } }) => { created.push(options); }, get: async () => ({ status: async () => ({ status: 'running' }) }) },
  } as unknown as AppEnv;
  return { env, registry, stores, created };
}

function job(fields: Partial<StoredImport>): StoredImport {
  return { ...newImportJob({ requestId: 'request-key-00000001', owner: 'acme', name: 'app', options: { issues: true, pullRequests: false, releases: false }, credential: null, keepCredential: false, sourcePrivate: false, principal, now: iso(-7_200_000) }), ...fields };
}

describe('GitHub import cron', () => {
  it('pulls transition repositories hourly, resumes stalled jobs and forgets finished ones', async () => {
    const { env, registry, stores, created } = environment({
      due: job({ state: 'completed', phase: 'done', transition: { enabled: true, lastPullAt: iso(-3_600_000) } }),
      recent: job({ state: 'completed', phase: 'done', transition: { enabled: true, lastPullAt: iso(-600_000) } }),
      stalled: job({ state: 'waiting', retryAt: iso(-1_200_000), updatedAt: iso(-1_800_000) }),
      sleeping: job({ state: 'waiting', retryAt: iso(600_000), updatedAt: iso(0) }),
      finished: job({ state: 'completed', phase: 'done' }),
      canonical: job({ state: 'completed', phase: 'done', transition: { enabled: false }, canonical: { at: iso(0), by: 'owner-1' } }),
      gone: null,
    });
    expect(await runGithubImportCron(env, now)).toEqual({ pulled: 1, resumed: 1, removed: 3 });
    expect([...registry.keys()].sort()).toEqual(['due', 'recent', 'sleeping', 'stalled']);
    expect(stores.get('due')!.get<StoredImport>('github-import')).toMatchObject({ mode: 'pull', state: 'queued', phase: 'issues' });
    expect(created.map(item => item.id.split('-').slice(0, 2).join('-'))).toEqual(['github-import', 'github-import']);
    expect(created.find(item => item.params.runId === stores.get('stalled')!.get<StoredImport>('github-import')!.runId)!.params.generation).toBeGreaterThan(0);
  });
});
