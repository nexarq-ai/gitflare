import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: DurableObjectState, protected env: unknown) {} }, WorkerEntrypoint: class {}, WorkflowEntrypoint: class {} }));
import type { Repository } from '../src/shared/types';
import type { AppEnv } from '../src/worker/env';
import { GitflareCoordinator } from '../src/worker/coordinator';
import { preparePreview, retirePreview, retireMissionPreview, type PreviewRetireParams } from '../src/worker/background-work';
import { cloudflareDeployClient } from '../src/worker/cloudflare-deploy';
import { readMigrationFiles } from '../src/worker/d1-migrations';
import { bindPreviewD1, deletePreviewD1, PREVIEW_D1_LIMIT, previewD1Migrations } from '../src/worker/preview-d1';
import { previewAlias } from '../src/worker/worker-previews';
import { hostedPreviewBindings, readWorkerConfig, type D1DatabaseSource, type ResolvedWorkerConfig } from '../src/worker/worker-bundle';

const WORKER_SENTINEL = 'GITFLARE_WORKER_BUNDLE ';
const MIGRATIONS_SENTINEL = 'GITFLARE_D1_MIGRATIONS ';
const accountId = 'f'.repeat(32);
const token = 'operator-previews-token-SECRET-value';
const candidateSha = 'b'.repeat(40);
const baseSha = 'a'.repeat(40);
const sqlite: DatabaseSync[] = [];
const roots: string[] = [];
afterEach(() => { for (const db of sqlite.splice(0)) db.close(); });
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function resolved(d1Databases: D1DatabaseSource[], overrides: Partial<ResolvedWorkerConfig> = {}): ResolvedWorkerConfig {
  return {
    configPath: 'wrangler.jsonc', name: 'app', main: '/workspace/repo/src/index.ts', compatibilityDate: '2026-10-01', compatibilityFlags: [], assets: false, containers: [], migrations: [], exports: {},
    production: { vars: {}, durableObjects: [], bindings: d1Databases.map((entry) => ({ name: entry.binding, type: 'd1' })), d1Databases },
    previews: null,
    ...overrides,
  };
}

function d1Api(options: { forbidden?: boolean } = {}) {
  const store = new Map<string, { name: string; db: DatabaseSync }>();
  const calls: string[] = [];
  let next = 0;
  const ok = (result: unknown) => Response.json({ success: true, result });
  const handle = async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const prefix = `/client/v4/accounts/${accountId}/d1/database`;
    if (!url.pathname.startsWith(prefix)) return null;
    const rest = url.pathname.slice(prefix.length);
    calls.push(`${request.method} ${rest || '/'}${url.search}`);
    if (request.headers.get('authorization') !== `Bearer ${token}`) return Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 401 });
    if (options.forbidden) return Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 });
    if (rest === '' && request.method === 'GET') return ok([...store].filter(([, entry]) => entry.name.includes(url.searchParams.get('name') ?? '')).map(([uuid, entry]) => ({ uuid, name: entry.name })));
    if (rest === '' && request.method === 'POST') {
      const { name } = await request.json() as { name: string };
      const uuid = `0000000${++next}-d1d1-4d1d-8d1d-d1d1d1d1d1d1`;
      const db = new DatabaseSync(':memory:');
      sqlite.push(db);
      store.set(uuid, { name, db });
      return ok({ uuid, name });
    }
    const match = /^\/([^/]+)(\/query)?$/.exec(rest);
    const entry = match ? store.get(match[1]) : undefined;
    if (!match || !entry) return Response.json({ success: false, errors: [{ code: 7404, message: 'The database could not be found' }] }, { status: 404 });
    if (request.method === 'DELETE' && !match[2]) { store.delete(match[1]); return ok(null); }
    const { sql } = await request.json() as { sql: string };
    try {
      if (/^\s*SELECT/i.test(sql)) return ok([{ success: true, results: entry.db.prepare(sql).all() }]);
      entry.db.exec('BEGIN');
      entry.db.exec(sql);
      entry.db.exec('COMMIT');
      return ok([{ success: true, results: [] }]);
    } catch (error) {
      if (entry.db.isTransaction) entry.db.exec('ROLLBACK');
      return Response.json({ success: false, errors: [{ code: 7500, message: `${(error as Error).message}: SQLITE_ERROR` }] }, { status: 400 });
    }
  };
  const seed = (uuid: string, name: string) => { const db = new DatabaseSync(':memory:'); sqlite.push(db); store.set(uuid, { name, db }); return db; };
  return { store, calls, handle, seed };
}

function previewsHandler(alias: string) {
  const calls: { method: string; path: string; form?: FormData }[] = [];
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const entry: { method: string; path: string; form?: FormData } = { method: request.method, path: url.pathname + url.search };
    if (request.method === 'POST' && !request.headers.get('content-type')?.includes('json')) entry.form = await request.formData();
    calls.push(entry);
    if (request.method === 'GET') return Response.json({ success: false, errors: [{ code: 10025 }] }, { status: 404 });
    if (request.method === 'DELETE') return Response.json({ success: true, result: null });
    if (url.pathname.endsWith('/deployments')) return Response.json({ success: true, result: { id: 'deployment-id', urls: ['https://deployment-id-gitflare-previews.example.workers.dev'] } });
    return Response.json({ success: true, result: { id: 'preview-id', name: alias, urls: [`https://${alias}-gitflare-previews.example.workers.dev`] } });
  };
  return { calls, handle };
}

const block = (d1Databases: D1DatabaseSource[], vars: Record<string, string>) => ({ vars, durableObjects: [], bindings: d1Databases.map((entry) => ({ name: entry.binding, type: 'd1' })), d1Databases });
const configOutput = (d1Databases: D1DatabaseSource[], previews: D1DatabaseSource[] | null = null) => `${WORKER_SENTINEL}${JSON.stringify({ configPath: 'wrangler.jsonc', main: '/workspace/repo/src/index.ts', compatibilityDate: '2026-10-01', compatibilityFlags: [], assets: false, migrations: [], exports: {}, production: block(d1Databases, { GREETING: 'hi' }), previews: previews ? block(previews, { GREETING: 'preview' }) : null })}\n`;

function d1Sandbox(d1Databases: D1DatabaseSource[], migrations: Record<string, { name: string; sql: string }[] | null>, previews: D1DatabaseSource[] | null = null) {
  const recorded: string[] = [];
  const runner = {
    prepare: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    startPreview: vi.fn(async () => {}),
    expireAt: vi.fn(async () => {}),
    install: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    command: vi.fn(async (argv: string[]) => {
      recorded.push(argv.join(' '));
      if (argv[0] === 'git' && argv[1] === 'ls-files') return { exitCode: 0, stdout: 'wrangler.jsonc\nsrc/index.ts\npackage.json\npackage-lock.json\nmigrations/0001_init.sql\n', stderr: '' };
      if (argv[0] === 'git' && argv[1] === 'show') return { exitCode: 128, stdout: '', stderr: 'missing' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
    check: vi.fn(async (script: string) => { recorded.push(script); return { exitCode: 0, stdout: '', stderr: '' }; }),
    collect: vi.fn(async (script: string) => {
      recorded.push(script);
      if (script.includes('unstable_readConfig')) return { exitCode: 0, stdout: configOutput(d1Databases, previews), stderr: '' };
      if (script.includes(MIGRATIONS_SENTINEL.trim())) return { exitCode: 0, stdout: `${MIGRATIONS_SENTINEL}${JSON.stringify(migrations)}\n`, stderr: '' };
      return { exitCode: 0, stdout: `${WORKER_SENTINEL}${JSON.stringify({ configPath: 'wrangler.jsonc', files: [{ name: 'index.js', data: Buffer.from('export default {}').toString('base64') }] })}\n`, stderr: '' };
    }),
  };
  return { runner, recorded };
}

const artifacts = { get: async (name: string) => ({ [Symbol.dispose]() {}, info: async () => ({ name, remote: `https://git.example/${name}.git`, defaultBranch: 'main' }), log: async () => [{ hash: candidateSha }] }) };

function coordinatorHarness() {
  const db = new DatabaseSync(':memory:');
  sqlite.push(db);
  const ctx = {
    storage: {
      getAlarm: vi.fn(async () => null), setAlarm: vi.fn(async () => {}),
      sql: { exec(query: string, ...args: SQLInputValue[]) { const statement = db.prepare(query); const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []); return { toArray: () => rows }; } },
      transactionSync<T>(fn: () => T): T { db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    },
  } as unknown as DurableObjectState;
  return new GitflareCoordinator(ctx, {} as AppEnv);
}

async function previewHarness() {
  const coordinator = coordinatorHarness();
  const catalog = coordinatorHarness();
  const now = new Date().toISOString();
  const repository: Repository = { id: 'repo', name: 'd1-app', description: '', defaultBranch: 'main', headSha: baseSha, provider: 'artifacts', createdAt: now, updatedAt: now };
  coordinator.saveRepository(repository);
  catalog.saveRepository(repository);
  const draft = coordinator.createMission('create', { repositoryId: repository.id, title: 'Add notes table', prompt: 'Store notes in D1.', tasks: [{ name: 'Agent', role: 'Implementation', task: 'Add the table.' }] });
  const started = await coordinator.startMission('start', draft.id);
  const mission = coordinator.recordExecution(draft.id, started.epoch, { candidateSha, integrationForkName: 'combined', runs: started.runs.map((run) => ({ ...run, status: 'completed', commitSha: candidateSha, forkName: 'fork' })), checks: [{ id: 'combined', name: 'Combined tests', status: 'passed', candidateSha, output: 'ok' }], changes: [] }, true);
  const failed = coordinator.previewFailed.bind(coordinator);
  const release = catalog.releasePreviewSlot.bind(catalog);
  Object.assign(coordinator, { previewFailed: async (...args: Parameters<typeof failed>) => failed(...args) });
  Object.assign(catalog, { releasePreviewSlot: async (...args: Parameters<typeof release>) => release(...args) });
  const alias = previewAlias(mission.id, 'gitflare-previews');
  const principal = { userId: 'owner', workspaceId: 'legacy', role: 'Owner' as const };
  const created: { id: string; params: unknown }[] = [];
  const envFor = (runner: unknown) => ({
    GITFLARE_SECURITY: { getByName: () => ({ identityCall: async () => null, shardCall: async () => undefined }) },
    GITFLARE_COORDINATOR: { getByName: (name: string) => name.startsWith('catalog') ? catalog : coordinator },
    ARTIFACTS: artifacts, SANDBOX: { getByName: () => runner },
    PREVIEWS_ACCOUNT_ID: accountId, PREVIEWS_WORKER_NAME: 'gitflare-previews', PREVIEWS_API_TOKEN: token,
    MISSION_WORKFLOW: { create: vi.fn(async (input: { id: string; params: unknown }) => { created.push(input); return {}; }), get: vi.fn() },
  } as unknown as AppEnv);
  const step = { do: async <T,>(_name: string, _config: unknown, callback: () => Promise<T>) => callback() };
  const run = async (runner: unknown, key: string) => {
    catalog.reservePreviewSlot(mission.id, Date.now() + 60_000);
    const claim = coordinator.claimPreview(key, mission.id, mission.epoch, candidateSha);
    await preparePreview(envFor(runner), { kind: 'preview', repositoryId: repository.id, missionId: mission.id, epoch: mission.epoch, candidateSha, claimId: claim.claimId, principal }, step);
    return claim.claimId;
  };
  return { coordinator, catalog, repository, mission, alias, run, envFor, step, created };
}

async function withFetch<T>(handler: (request: Request) => Promise<Response>, body: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => handler(input instanceof Request ? input : new Request(input, init))) as typeof fetch;
  try { return await body(); }
  finally { globalThis.fetch = realFetch; }
}

const PRODUCTION_DB: D1DatabaseSource = { binding: 'DB', databaseId: 'e5aec431-6c88-4454-afac-7cf26941d158', databaseName: 'notes-prod', migrationsDir: 'migrations', migrationsDirSet: false };
const STAGING_ID = '0000staging-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
const PREVIEW_DB: D1DatabaseSource = { binding: 'DB', databaseId: STAGING_ID, databaseName: 'notes-staging', migrationsDir: 'migrations', migrationsDirSet: false };
const INIT = { name: '0001_init.sql', sql: 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);' };
const SEED = { name: '0002_seed.sql', sql: "INSERT INTO notes (body) VALUES ('hello');" };
const NO_PREVIEW_DB = 'D1 binding DB has no preview database. Add previews.d1_databases to wrangler.jsonc to give previews a staging database.';

describe('preview D1 databases follow Cloudflare’s previews model', () => {
  it('binds the configured preview database, applies its migrations idempotently and never creates or deletes it', async () => {
    const h = await previewHarness();
    const d1 = d1Api();
    const staging = d1.seed(STAGING_ID, 'notes-staging');
    const previews = previewsHandler(h.alias);
    const handler = async (request: Request) => await d1.handle(request) ?? previews.handle(request);

    const firstClaim = await withFetch(handler, () => h.run(d1Sandbox([PRODUCTION_DB], { migrations: [INIT] }, [PREVIEW_DB]).runner, 'preview-key-d1-0001'));
    const status = h.coordinator.previewStatus(h.mission.id);
    expect(status).toMatchObject({ status: 'ready', kind: 'worker' });
    expect(status.worker?.notes).toContain('D1 DB → preview database notes-staging, migrations applied: 1');
    expect(status.worker?.d1Databases).toEqual([{ binding: 'DB', databaseName: 'notes-staging', databaseId: STAGING_ID, migrationsApplied: 1 }]);
    expect(d1.calls.filter((call) => call === 'POST /' || call.startsWith('DELETE'))).toEqual([]);
    const deployment = previews.calls.find((call) => call.path.endsWith('/deployments'))!;
    const metadata = JSON.parse(String(deployment.form!.get('metadata')));
    expect(metadata.env.DB).toEqual({ type: 'd1', database_id: STAGING_ID, database_name: 'notes-staging' });
    expect(JSON.stringify(metadata)).not.toContain(PRODUCTION_DB.databaseId);
    expect(staging.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).toEqual([{ name: '0001_init.sql' }]);
    expect(h.coordinator.workerPreview(h.mission.id)).not.toHaveProperty('d1DatabaseIds');

    await h.coordinator.previewFailed(h.mission.id, firstClaim);
    await withFetch(handler, () => h.run(d1Sandbox([PRODUCTION_DB], { migrations: [INIT, SEED] }, [PREVIEW_DB]).runner, 'preview-key-d1-0002'));
    expect(staging.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).toEqual([{ name: '0001_init.sql' }, { name: '0002_seed.sql' }]);
    expect(staging.prepare('SELECT body FROM notes').all()).toEqual([{ body: 'hello' }]);

    await retireMissionPreview(h.envFor(null), h.repository.id, h.mission.id, 'legacy');
    await withFetch(handler, () => retirePreview(h.envFor(null), h.created[0].params as PreviewRetireParams, h.step));
    expect(previews.calls.some((call) => call.method === 'DELETE')).toBe(true);
    expect(d1.store.has(STAGING_ID)).toBe(true);
    expect(d1.calls.filter((call) => call === 'POST /' || call.startsWith('DELETE'))).toEqual([]);
  });

  it('never binds the production database and notes the missing preview database without creating one', async () => {
    const h = await previewHarness();
    const d1 = d1Api();
    const previews = previewsHandler(h.alias);
    const sandbox = d1Sandbox([PRODUCTION_DB], { migrations: [INIT] });
    await withFetch(async (request) => await d1.handle(request) ?? previews.handle(request), () => h.run(sandbox.runner, 'preview-key-d1-0003'));
    const status = h.coordinator.previewStatus(h.mission.id);
    expect(status).toMatchObject({ status: 'ready', kind: 'worker' });
    expect(status.worker?.notes).toContain(NO_PREVIEW_DB);
    expect(status.worker).not.toHaveProperty('d1Databases');
    expect(d1.calls).toEqual([]);
    const metadata = JSON.parse(String(previews.calls.find((call) => call.path.endsWith('/deployments'))!.form!.get('metadata')));
    expect(metadata.env).not.toHaveProperty('DB');
    expect(JSON.stringify(metadata)).not.toContain(PRODUCTION_DB.databaseId);
    expect(sandbox.recorded.some((entry) => entry.includes(MIGRATIONS_SENTINEL.trim()))).toBe(false);
  });

  it('treats a previews entry without database_id like a missing preview database', () => {
    const config = resolved([PRODUCTION_DB], { previews: { vars: {}, durableObjects: [], bindings: [{ name: 'DB', type: 'd1' }], d1Databases: [{ binding: 'DB', migrationsDir: 'migrations', migrationsDirSet: false }] } });
    expect(previewD1Migrations(config)).toEqual([]);
    const plan = hostedPreviewBindings(config);
    expect(plan.env).toEqual({});
    expect(plan.notes).toEqual([NO_PREVIEW_DB]);
  });

  it('fails the preview with the failing migration and the D1 error', async () => {
    const h = await previewHarness();
    const d1 = d1Api();
    d1.seed(STAGING_ID, 'notes-staging');
    const previews = previewsHandler(h.alias);
    const broken = { name: '0002_broken.sql', sql: 'CREATE TABLE notes (id INTEGER PRIMARY KEY);' };
    await withFetch(async (request) => await d1.handle(request) ?? previews.handle(request), () => h.run(d1Sandbox([], { migrations: [INIT, broken] }, [PREVIEW_DB]).runner, 'preview-key-d1-0004'));
    const status = h.coordinator.previewStatus(h.mission.id);
    expect(status.status).toBe('failed');
    expect(status.error).toContain('D1 migration 0002_broken.sql on notes-staging failed');
    expect(status.error).toContain('table notes already exists');
    expect(status.error).not.toContain(token);
    expect(previews.calls.some((call) => call.path.endsWith('/deployments'))).toBe(false);
    expect(d1.store.has(STAGING_ID)).toBe(true);
  });

  it('names the account when the preview database is not on it, and the permission when D1 is refused', async () => {
    const missing = d1Api();
    const call = cloudflareDeployClient({ accessToken: token, accountId, scopes: [], source: 'workspace' }, (request) => missing.handle(request) as Promise<Response>).call;
    const set = { binding: 'DB', databaseName: 'notes-staging', databaseId: STAGING_ID, directory: 'migrations', table: 'd1_migrations', files: [] };
    await expect(bindPreviewD1(call, accountId, [set])).rejects.toMatchObject({ code: 'PREVIEW_D1_NOT_FOUND', message: expect.stringContaining(`account ${accountId}`) });
    const forbidden = d1Api({ forbidden: true });
    const refused = cloudflareDeployClient({ accessToken: token, accountId, scopes: [], source: 'workspace' }, (request) => forbidden.handle(request) as Promise<Response>).call;
    await expect(bindPreviewD1(refused, accountId, [set])).rejects.toMatchObject({ code: 'PREVIEWS_D1_FORBIDDEN', message: expect.stringContaining('D1 Edit') });
  });

  it('still deletes isolated databases recorded by earlier previews when they retire', async () => {
    const h = await previewHarness();
    const d1 = d1Api();
    const legacy = '0000legacy-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
    d1.seed(legacy, `gfp-${h.alias}-db`);
    const previews = previewsHandler(h.alias);
    const params: PreviewRetireParams = { kind: 'preview-retire', repositoryId: h.repository.id, missionId: h.mission.id, previewName: h.alias, workspaceId: 'legacy', d1DatabaseIds: [legacy] };
    await withFetch(async (request) => await d1.handle(request) ?? previews.handle(request), () => retirePreview(h.envFor(null), params, h.step));
    expect(d1.store.has(legacy)).toBe(false);
    const call = cloudflareDeployClient({ accessToken: token, accountId, scopes: [], source: 'workspace' }, (request) => d1.handle(request) as Promise<Response>).call;
    expect(await deletePreviewD1(call, accountId, [legacy])).toEqual({ deleted: [], missing: [legacy] });
  });

  it('refuses more than three preview databases before touching Cloudflare', () => {
    const entries = ['A', 'B', 'C', 'D'].map((binding, index) => ({ binding, databaseId: `id-${index}`, migrationsDir: 'migrations', migrationsDirSet: false }));
    expect(PREVIEW_D1_LIMIT).toBe(3);
    expect(() => previewD1Migrations(resolved([], { previews: { vars: {}, durableObjects: [], bindings: [], d1Databases: entries } }))).toThrow('at most 3 preview D1 databases; previews.d1_databases declares 4');
  });

  it('treats a missing default migrations directory as no migrations but requires an explicit one', async () => {
    const previewsWith = (entry: D1DatabaseSource) => resolved([], { previews: { vars: {}, durableObjects: [], bindings: [], d1Databases: [entry] } });
    const [implicit] = previewD1Migrations(previewsWith(PREVIEW_DB));
    const [explicit] = previewD1Migrations(previewsWith({ ...PREVIEW_DB, migrationsDir: 'db/migrations', migrationsDirSet: true }));
    const sandbox = { collect: async () => ({ exitCode: 0, stdout: `${MIGRATIONS_SENTINEL}${JSON.stringify({ migrations: null, 'db/migrations': null })}\n`, stderr: '' }) };
    expect(await readMigrationFiles(sandbox, [implicit])).toMatchObject([{ binding: 'DB', databaseId: STAGING_ID, files: [] }]);
    await expect(readMigrationFiles(sandbox, [explicit])).rejects.toMatchObject({ code: 'D1_MIGRATIONS_DIRECTORY_MISSING' });
    expect(() => previewD1Migrations(previewsWith({ ...PREVIEW_DB, migrationsDir: null, migrationsDirSet: true }))).toThrow('outside the repository');
  });
});

describe('preview D1 configuration from the real Wrangler', () => {
  function project(files: Record<string, string>): string {
    const base = join(__dirname, '..', '.wrangler');
    mkdirSync(base, { recursive: true });
    const root = mkdtempSync(join(base, 'preview-d1-'));
    roots.push(root);
    symlinkSync(join(__dirname, '..', 'node_modules'), join(root, 'node_modules'));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }
  const sandboxFor = (root: string) => {
    const run = async (script: string) => { const result = spawnSync('bash', ['-c', script], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }; };
    return { check: run, collect: run };
  };

  it('reads preview database ids from the previews block, skips entries without one and reads migrations relative to the config', async () => {
    const root = project({
      'apps/api/wrangler.jsonc': JSON.stringify({
        name: 'notes', main: 'src/index.ts', compatibility_date: '2026-10-01',
        d1_databases: [{ binding: 'DB', database_name: 'notes-prod', database_id: 'e5aec431-6c88-4454-afac-7cf26941d158', migrations_dir: 'db' }],
        previews: { d1_databases: [{ binding: 'DB', database_name: 'notes-staging', database_id: '11111111-2222-4333-8444-555555555555' }, { binding: 'AUDIT', database_id: '66666666-7777-4888-9999-000000000000', migrations_dir: 'audit', migrations_table: 'audit_migrations' }, { binding: 'CACHE_DB' }] },
      }),
      'apps/api/src/index.ts': 'export default { fetch() { return new Response("ok"); } };',
      'apps/api/migrations/0001_init.sql': INIT.sql,
      'apps/api/audit/0001_audit.sql': 'CREATE TABLE audit (id INTEGER PRIMARY KEY);',
    });
    const sandbox = sandboxFor(root);
    const config = await readWorkerConfig(sandbox, 'apps/api/wrangler.jsonc');
    expect(config?.previews?.d1Databases).toEqual([
      { binding: 'DB', databaseId: '11111111-2222-4333-8444-555555555555', databaseName: 'notes-staging', migrationsDir: 'apps/api/migrations', migrationsDirSet: false },
      { binding: 'AUDIT', databaseId: '66666666-7777-4888-9999-000000000000', migrationsDir: 'apps/api/audit', migrationsDirSet: true, migrationsTable: 'audit_migrations' },
      { binding: 'CACHE_DB', migrationsDir: 'apps/api/migrations', migrationsDirSet: false },
    ]);
    expect(config?.production.d1Databases).toEqual([{ binding: 'DB', databaseId: 'e5aec431-6c88-4454-afac-7cf26941d158', databaseName: 'notes-prod', migrationsDir: 'apps/api/db', migrationsDirSet: true }]);
    const sets = await readMigrationFiles(sandbox, previewD1Migrations(config!));
    expect(sets.map((set) => [set.binding, set.databaseId, set.table, set.files.map((file) => file.name)])).toEqual([['DB', '11111111-2222-4333-8444-555555555555', 'd1_migrations', ['0001_init.sql']], ['AUDIT', '66666666-7777-4888-9999-000000000000', 'audit_migrations', ['0001_audit.sql']]]);
    expect(hostedPreviewBindings(config!).notes).toContain('D1 binding CACHE_DB has no preview database. Add previews.d1_databases to wrangler.jsonc to give previews a staging database.');
  }, 60_000);
});
