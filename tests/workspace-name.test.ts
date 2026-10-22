import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../src/worker/env';
import { GitflareCoordinator } from '../src/worker/coordinator';
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

describe('workspace name', () => {
  it('reports the same workspace name from the workspace and access routes for the legacy owner', async () => {
    const token = 'workspace-name-owner-token-'.repeat(2);
    const security = securityHarness();
    const catalog = durable();
    const env = {
      APP_ENV: 'production', OWNER_TOKEN: token, WORKSPACE_NAME: 'Gitflare development',
      GITFLARE_SECURITY: security.namespace,
      GITFLARE_COORDINATOR: { getByName: () => catalog },
    } as unknown as AppEnv;
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const worker = (await import('../src/worker/index')).default;
    const get = async (path: string) => (await worker.fetch(new Request(`https://gitflare.test${path}`, { headers: { Authorization: `Bearer ${token}` } }), env, ctx)).json() as Promise<Record<string, any>>;
    const workspace = await get('/api/workspace');
    const access = await get('/api/access');
    expect(workspace.name).toBe('Gitflare development');
    expect(access.workspace.name).toBe(workspace.name);
    expect(access.workspaces.map((item: { name: string }) => item.name)).toEqual([workspace.name]);
  });
});
