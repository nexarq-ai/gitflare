import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Repository } from '../src/shared/types';
import type { Principal } from '../src/worker/security';
import { ApiError } from '../src/worker/domain';
import { SqlStore } from '../src/worker/store';
import { DeploymentLedger, deploymentsApi, landedDeployments, parseDeployTargets, policyDeployTargets, rollbackTarget, runDeployment, type BuiltTarget, type DeployApiContext, type DeployDependencies, type DeploymentRecord, type DeployPlatform, type DeployTarget, type WorkerDeployer } from '../src/worker/deployments';
import { parseWorkerBundle, type ResolvedWorkerConfig } from '../src/worker/worker-bundle';
import type { D1MigrationSet } from '../src/worker/d1-migrations';
import { changedPaths, validWatchPath, watchPathsMatch } from '../src/worker/deploy-changes';

const sha = 'c'.repeat(40);
const accountId = 'a'.repeat(32);
const owner: Principal = { userId: 'owner', workspaceId: 'w', role: 'Owner' };
const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });

function ledger() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  return new DeploymentLedger(new SqlStore({ exec(query: string, ...args: SQLInputValue[]) { const statement = db.prepare(query); const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []); return { toArray: () => rows }; } } as unknown as SqlStorage));
}

const api: DeployTarget = { workerName: 'prahari-api', configPath: 'apps/api/wrangler.jsonc', d1Migrations: true };
const web: DeployTarget = { workerName: 'prahari-web', configPath: 'apps/web/wrangler.jsonc', buildCommand: 'pnpm --filter @prahari/web build', d1Migrations: false };

function workerConfig(name: string, deploy: Record<string, unknown>, migrations: ResolvedWorkerConfig['migrations'] = []): ResolvedWorkerConfig {
  return { configPath: `apps/${name}/wrangler.jsonc`, main: 'index.js', compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'], assets: false, containers: [], migrations, exports: {}, production: { vars: {}, durableObjects: [], bindings: [] }, previews: null, deploy: { name, compatibility_date: '2026-07-01', ...deploy } };
}
const bundleFor = (config: ResolvedWorkerConfig) => parseWorkerBundle(`GITFLARE_WORKER_BUNDLE ${JSON.stringify({ files: [{ name: 'index.js', data: Buffer.from('export default {}').toString('base64') }] })}`, config);
const apiBundle = bundleFor(workerConfig('prahari-api', { d1_databases: [{ binding: 'DB', database_name: 'prahari-db', database_id: 'db-id', migrations_dir: 'apps/api/migrations' }], queues: { consumers: [{ queue: 'prahari-ingest' }] } }, [{ tag: 'v1', new_sqlite_classes: ['TicketDO'] }]));
const webBundle = bundleFor(workerConfig('prahari-web', { services: [{ binding: 'API', service: 'prahari-api' }], routes: [{ pattern: 'support.nexarq.dev', custom_domain: true }] }));
const migrationSet: D1MigrationSet = { binding: 'DB', databaseName: 'prahari-db', databaseId: 'db-id', directory: 'apps/api/migrations', table: 'd1_migrations', files: [{ name: '0000_init.sql', sql: 'CREATE TABLE t(id);' }] };

function record(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  const now = new Date().toISOString();
  return { id: `0000${Math.random().toString(36).slice(2, 8)}-${crypto.randomUUID()}`, attemptId: crypto.randomUUID(), repositoryId: 'repo', workerName: 'prahari-api', accountId, environment: 'production', rollout: 'immediate', mode: 'deploy', commitSha: sha, trigger: 'land', status: 'queued', percentage: 0, actorId: 'owner', createdAt: now, updatedAt: now, targets: [api, web].map((target) => ({ ...target, status: 'pending' as const, percentage: 0 })), ...overrides };
}

function flow(initial: DeploymentRecord, options: { scopes?: string[]; liveTags?: Record<string, { exists: boolean; tag?: string }>; failOn?: string; bundles?: Record<string, ReturnType<typeof bundleFor>>; policy?: DeployTarget[] | null; mapped?: string[]; changed?: string[] | null } = {}) {
  const book = ledger();
  book.create('seed-request-000001', 'seed', initial);
  const events: string[] = [];
  const deployers: Record<string, WorkerDeployer> = {};
  const deployerFor = (workerName: string): WorkerDeployer => deployers[workerName] ??= {
    accountId,
    scopes: options.scopes ?? ['workers-scripts.edit', 'd1.write', 'queues.write', 'workers-routes.write', 'zone.read'],
    call: vi.fn(async () => null) as unknown as WorkerDeployer['call'],
    uploadVersion: vi.fn(async (_bundle, _annotations, metadata) => { events.push(`${workerName}:upload-version:${JSON.stringify((metadata as { migrations?: unknown })?.migrations ?? null)}`); if (options.failOn === `${workerName}:upload`) throw new ApiError(502, 'CLOUDFLARE_DEPLOY_REJECTED', 'rejected'); return { id: `${workerName}-v2` }; }),
    uploadScript: vi.fn(async (_bundle, metadata) => { events.push(`${workerName}:upload-script:${JSON.stringify((metadata as { migrations?: unknown }).migrations)}`); return { id: `${workerName}-v2` }; }),
    latestDeployment: vi.fn(async () => ({ versions: [{ version_id: `${workerName}-v1`, percentage: 100 }] })),
    deploy: vi.fn(async (versions) => { events.push(`${workerName}:deploy:${versions.map((item: { version_id: string; percentage: number }) => `${item.version_id}@${item.percentage}`).join(',')}`); return { id: 'd' }; }),
  };
  const platform: DeployPlatform = {
    ensureResources: vi.fn(async () => { events.push('ensure-resources'); return { notes: [], created: [], resolved: { d1: {} } }; }),
    applyTriggers: vi.fn(async (_call, _account, workerName) => { events.push(`${workerName}:triggers`); return { notes: [`${workerName} triggers applied`] }; }),
    currentMigrationTag: vi.fn(async (_call, _account, workerName) => options.liveTags?.[workerName] ?? { exists: true, tag: 'v1' }),
    applyD1Migrations: vi.fn(async (_call, _account, set) => { events.push(`d1:${set.databaseName}`); if (options.failOn === 'd1') throw new ApiError(502, 'D1_MIGRATION_FAILED', 'D1 migration 0000_init.sql on prahari-db failed: syntax'); return { binding: set.binding, databaseName: set.databaseName, databaseId: 'db-id', table: 'd1_migrations', pending: ['0000_init.sql'], applied: ['0000_init.sql'] }; }),
  };
  const build = vi.fn(async (_repository: Repository, _record: DeploymentRecord, target: { workerName: string; d1Migrations: boolean }, _index: number, _assert: () => Promise<void>, publish: (built: BuiltTarget) => Promise<unknown>) => {
    events.push(`${target.workerName}:build`);
    const bundle = options.bundles?.[target.workerName] ?? (target.workerName === 'prahari-api' ? apiBundle : webBundle);
    return publish({ bundle, migrations: target.d1Migrations ? [migrationSet] : [], ...(target.workerName === 'prahari-web' ? { uploadAssets: async () => { events.push('prahari-web:assets'); return { jwt: 'completion', config: { not_found_handling: 'single-page-application' }, uploaded: 3, total: 62 }; } } : {}) });
  });
  const sleeps: number[] = [];
  const step = { do: async <T,>(_name: string, _config: unknown, callback: () => Promise<T>) => callback(), sleep: async (_name: string, duration: number) => { sleeps.push(duration); } };
  const dependencies: DeployDependencies = {
    coordinator: { getRepository: async () => ({ id: 'repo', name: 'prahari', defaultBranch: 'main' } as Repository), getDeployment: async (id) => book.get(id), updateDeployment: async (id, expected, patch) => book.update(id, expected, patch) },
    authorize: vi.fn(async () => {}),
    deployer: vi.fn(async (_principal, _record, workerName) => deployerFor(workerName)),
    build: build as unknown as DeployDependencies['build'],
    platform,
    ...(options.policy !== undefined ? { policyTargets: async () => options.policy ?? null } : {}),
    mappedWorkers: async () => ({ accountId, workers: options.mapped ?? ['prahari-api', 'prahari-web'] }),
    ...(options.changed !== undefined ? { changedPaths: async () => options.changed ?? null } : {}),
  };
  return { book, events, sleeps, build, platform, deployers, run: () => runDeployment({ kind: 'deploy', repositoryId: 'repo', deploymentId: initial.id, principal: owner }, step, dependencies) };
}

describe('multi-target deployments', () => {
  it('deploys api before web: build, D1 migrations, script upload, promotion, then triggers', async () => {
    const initial = record();
    const run = flow(initial);
    await run.run();
    expect(run.events).toEqual([
      'prahari-api:build', 'ensure-resources', 'd1:prahari-db', 'prahari-api:upload-version:null', 'prahari-api:deploy:prahari-api-v2@100', 'prahari-api:triggers',
      'prahari-web:build', 'ensure-resources', 'prahari-web:assets', 'prahari-web:upload-version:null', 'prahari-web:deploy:prahari-web-v2@100', 'prahari-web:triggers',
    ]);
    const final = run.book.get(initial.id)!;
    expect(final).toMatchObject({ status: 'succeeded', versionId: 'prahari-api-v2', previousVersionId: 'prahari-api-v1', percentage: 100, targetsSource: 'settings' });
    expect(final.targets).toMatchObject([
      { workerName: 'prahari-api', status: 'succeeded', versionId: 'prahari-api-v2', previousVersionId: 'prahari-api-v1', migrations: [{ applied: ['0000_init.sql'] }] },
      { workerName: 'prahari-web', status: 'succeeded', versionId: 'prahari-web-v2', assets: { uploaded: 3, total: 62 }, notes: ['prahari-web triggers applied'] },
    ]);
  });

  it('applies a pending Durable Object migration with a full script upload and records the previous version', async () => {
    const initial = record();
    const run = flow(initial, { liveTags: { 'prahari-api': { exists: true } } });
    await run.run();
    expect(run.events.slice(0, 5)).toEqual(['prahari-api:build', 'ensure-resources', 'd1:prahari-db', 'prahari-api:upload-script:{"new_tag":"v1","steps":[{"new_sqlite_classes":["TicketDO"]}]}', 'prahari-api:triggers']);
    expect(run.book.get(initial.id)!.targets![0]).toMatchObject({ status: 'succeeded', deployedOnUpload: true, previousVersionId: 'prahari-api-v1', durableObjectMigration: { new_tag: 'v1' }, percentage: 100 });
  });

  it('stops at the first failure and never touches web when api fails', async () => {
    const initial = record();
    const run = flow(initial, { failOn: 'd1' });
    await run.run();
    expect(run.events).toEqual(['prahari-api:build', 'ensure-resources', 'd1:prahari-db']);
    expect(run.book.get(initial.id)).toMatchObject({ status: 'failed', errorCode: 'D1_MIGRATION_FAILED', targets: [{ status: 'failed', errorCode: 'D1_MIGRATION_FAILED' }, { status: 'skipped' }] });
    const uploadFailure = flow(record(), { failOn: 'prahari-api:upload' });
    await uploadFailure.run();
    expect(uploadFailure.events.some((event) => event.startsWith('prahari-web'))).toBe(false);
  });

  it('upload-only mode uploads versions without migrations, promotion or triggers', async () => {
    const initial = record({ mode: 'upload-only' });
    const run = flow(initial);
    await run.run();
    expect(run.events).toEqual(['prahari-api:build', 'ensure-resources', 'prahari-api:upload-version:null', 'prahari-web:build', 'ensure-resources', 'prahari-web:assets', 'prahari-web:upload-version:null']);
    expect(run.book.get(initial.id)).toMatchObject({ status: 'uploaded', targets: [{ status: 'uploaded', versionId: 'prahari-api-v2', notes: ['D1 migrations were not applied because this deployment only uploads a version.'] }, { status: 'uploaded' }] });
  });

  it('upload-only refuses a pending Durable Object migration instead of deploying it', async () => {
    const initial = record({ mode: 'upload-only' });
    const run = flow(initial, { liveTags: { 'prahari-api': { exists: true } } });
    await run.run();
    expect(run.book.get(initial.id)).toMatchObject({ status: 'failed', errorCode: 'DO_MIGRATION_REQUIRES_DEPLOY' });
  });

  it('rolls out gradually across targets and promotes all after one soak', async () => {
    const initial = record({ rollout: 'gradual' });
    const run = flow(initial);
    await run.run();
    expect(run.events.filter((event) => event.includes(':deploy:'))).toEqual(['prahari-api:deploy:prahari-api-v2@10,prahari-api-v1@90', 'prahari-web:deploy:prahari-web-v2@10,prahari-web-v1@90', 'prahari-api:deploy:prahari-api-v2@100', 'prahari-web:deploy:prahari-web-v2@100']);
    expect(run.sleeps).toHaveLength(1);
    expect(run.book.get(initial.id)).toMatchObject({ status: 'succeeded', targets: [{ status: 'succeeded', percentage: 100 }, { status: 'succeeded', percentage: 100 }] });
  });

  it('refuses a web-before-api order when web binds to api', async () => {
    const initial = record({ targets: [web, api].map((target) => ({ ...target, status: 'pending' as const, percentage: 0 })) });
    const run = flow(initial);
    await run.run();
    expect(run.book.get(initial.id)).toMatchObject({ status: 'failed', errorCode: 'DEPLOY_ORDER_INVALID' });
    expect(run.events).toEqual(['prahari-web:build']);
  });

  it('names the missing OAuth scopes before touching Cloudflare', async () => {
    const initial = record();
    const run = flow(initial, { scopes: ['workers-scripts.edit'] });
    await run.run();
    const failed = run.book.get(initial.id)!;
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'CLOUDFLARE_SCOPE_MISSING' });
    expect(failed.error).toContain('d1.write');
    expect(failed.error).toContain('queues.write');
    expect(run.platform.ensureResources).not.toHaveBeenCalled();
  });

  it('refuses a config whose Worker name differs from the target', async () => {
    const initial = record({ targets: [{ ...api, workerName: 'other', status: 'pending', percentage: 0 }] });
    const run = flow(initial, { bundles: { other: apiBundle } });
    await run.run();
    expect(run.book.get(initial.id)).toMatchObject({ status: 'failed', errorCode: 'DEPLOY_TARGET_NAME_MISMATCH' });
  });

  it('takes targets from gitflare.json at the base revision ahead of settings, but only for linked Workers', async () => {
    const initial = record({ targets: [{ ...web, status: 'pending', percentage: 0 }] });
    const run = flow(initial, { policy: [api] });
    await run.run();
    expect(run.book.get(initial.id)).toMatchObject({ status: 'succeeded', targetsSource: 'gitflare.json', targets: [{ workerName: 'prahari-api', status: 'succeeded' }] });
    const unlinked = flow(record(), { policy: [api, web], mapped: ['prahari-api'] });
    await unlinked.run();
    expect(unlinked.events).toEqual([]);
    expect(unlinked.book.get(unlinked.book.state().deployments[0].id)).toMatchObject({ status: 'failed', errorCode: 'WORKER_NOT_MAPPED' });
  });

  it('rolls back every target in reverse order without building', async () => {
    const live = record({ status: 'succeeded', targets: [{ ...api, status: 'succeeded', percentage: 100, versionId: 'api-v2', previousVersionId: 'api-v1' }, { ...web, status: 'succeeded', percentage: 100, versionId: 'web-v2', previousVersionId: 'web-v1' }] });
    const target = rollbackTarget([live]);
    expect(target.targets.map((item) => [item.workerName, item.versionId])).toEqual([['prahari-web', 'web-v1'], ['prahari-api', 'api-v1']]);
    const initial = record({ trigger: 'rollback', commitSha: null, versionId: target.versionId, targets: target.targets });
    const run = flow(initial);
    await run.run();
    expect(run.build).not.toHaveBeenCalled();
    expect(run.events).toEqual(['prahari-web:deploy:web-v1@100', 'prahari-api:deploy:api-v1@100']);
    expect(run.book.get(initial.id)).toMatchObject({ status: 'succeeded' });
  });
});

describe('selective deployments', () => {
  const watched = (target: DeployTarget, watchPaths: string[]) => ({ ...target, watchPaths, status: 'pending' as const, percentage: 0 });
  const apiWatch = ['apps/api/**', 'packages/**', 'pnpm-lock.yaml'];
  const webWatch = ['apps/web/**', 'packages/**', 'pnpm-lock.yaml', '!apps/web/**/*.md'];

  it('deploys only the chosen web target when its api dependency already exists in the environment', async () => {
    const initial = record({ trigger: 'manual', selectedWorkers: ['prahari-web'] });
    const run = flow(initial);
    await run.run();
    expect(run.events).toEqual(['prahari-web:build', 'ensure-resources', 'prahari-web:assets', 'prahari-web:upload-version:null', 'prahari-web:deploy:prahari-web-v2@100', 'prahari-web:triggers']);
    expect(run.platform.currentMigrationTag).toHaveBeenCalledWith(expect.anything(), accountId, 'prahari-api');
    expect(run.book.get(initial.id)).toMatchObject({ status: 'succeeded', targets: [{ workerName: 'prahari-web', status: 'succeeded' }], skippedTargets: [{ workerName: 'prahari-api', reason: 'not selected' }] });
  });

  it('refuses a chosen target whose service-binding target does not exist yet, naming it', async () => {
    const initial = record({ trigger: 'manual', selectedWorkers: ['prahari-web'] });
    const run = flow(initial, { liveTags: { 'prahari-api': { exists: false } } });
    await run.run();
    const failed = run.book.get(initial.id)!;
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'DEPLOY_DEPENDENCY_MISSING' });
    expect(failed.error).toContain('prahari-api');
    expect(run.events).toEqual(['prahari-web:build']);
  });

  it('keeps dependency order among a chosen subset and rejects unknown names', async () => {
    const both = flow(record({ trigger: 'manual', selectedWorkers: ['prahari-web', 'prahari-api'] }));
    await both.run();
    expect(both.events.filter((event) => event.endsWith(':build'))).toEqual(['prahari-api:build', 'prahari-web:build']);
    const unknown = flow(record({ trigger: 'manual', selectedWorkers: ['prahari-cron'] }));
    await unknown.run();
    expect(unknown.book.state().deployments[0]).toMatchObject({ status: 'failed', errorCode: 'DEPLOY_TARGET_NOT_CONFIGURED' });
  });

  it('deploys on land only the targets whose watch paths match the landed change', async () => {
    const targets = [watched(api, apiWatch), watched(web, webWatch)];
    const webOnly = flow(record({ targets }), { changed: ['apps/web/src/routes/index.tsx', 'apps/web/README.md'] });
    await webOnly.run();
    expect(webOnly.events.filter((event) => event.endsWith(':build'))).toEqual(['prahari-web:build']);
    expect(webOnly.book.state().deployments[0]).toMatchObject({ status: 'succeeded', skippedTargets: [{ workerName: 'prahari-api', reason: 'no changes under watch paths' }] });
    const lockfile = flow(record({ targets }), { changed: ['pnpm-lock.yaml'] });
    await lockfile.run();
    expect(lockfile.events.filter((event) => event.endsWith(':build'))).toEqual(['prahari-api:build', 'prahari-web:build']);
    const unknownDiff = flow(record({ targets }), { changed: null });
    await unknownDiff.run();
    expect(unknownDiff.events.filter((event) => event.endsWith(':build'))).toEqual(['prahari-api:build', 'prahari-web:build']);
    const manual = flow(record({ targets, trigger: 'manual' }), { changed: ['docs/guide.md'] });
    await manual.run();
    expect(manual.events.filter((event) => event.endsWith(':build'))).toEqual(['prahari-api:build', 'prahari-web:build']);
  });

  it('deploys nothing when a land only changes docs, and records why', async () => {
    const initial = record({ targets: [watched(api, apiWatch), watched(web, webWatch)] });
    const run = flow(initial, { changed: ['docs/guide.md', 'README.md', 'apps/web/CHANGELOG.md'] });
    await run.run();
    expect(run.events).toEqual([]);
    expect(run.book.get(initial.id)).toMatchObject({ status: 'skipped', targets: [], skippedTargets: [{ workerName: 'prahari-api', reason: 'no changes under watch paths' }, { workerName: 'prahari-web', reason: 'no changes under watch paths' }] });
  });

  it('a promotion deploys the production targets whose configs the staging deployment deployed', async () => {
    const initial = record({ trigger: 'promote', selectedConfigs: ['apps/web/wrangler.jsonc'] });
    const run = flow(initial);
    await run.run();
    expect(run.events.filter((event) => event.endsWith(':build'))).toEqual(['prahari-web:build']);
    expect(run.book.get(initial.id)).toMatchObject({ status: 'succeeded', skippedTargets: [{ workerName: 'prahari-api', reason: 'not deployed by the promoted deployment' }] });
  });

  it('matches watch globs like Workers Builds and diffs trees by hash', async () => {
    expect(watchPathsMatch(undefined, ['anything'])).toBe(true);
    expect(watchPathsMatch([], [])).toBe(true);
    expect(watchPathsMatch(['apps/api/**'], ['apps/api/src/index.ts'])).toBe(true);
    expect(watchPathsMatch(['apps/api/**'], ['apps/apiary/x.ts'])).toBe(false);
    expect(watchPathsMatch(['apps/api'], ['apps/api/wrangler.jsonc'])).toBe(true);
    expect(watchPathsMatch(['*.json'], ['package.json', 'apps/x.json'])).toBe(true);
    expect(watchPathsMatch(['*.json'], ['apps/x.json'])).toBe(false);
    expect(watchPathsMatch(['**/*.sql'], ['apps/api/migrations/0001.sql'])).toBe(true);
    expect(watchPathsMatch(['!docs/**'], ['docs/a.md'])).toBe(false);
    expect(watchPathsMatch(['!docs/**'], ['docs/a.md', 'src/a.ts'])).toBe(true);
    for (const bad of ['', '/abs/**', '../x', 'a/../../b', 'a\\b']) expect(validWatchPath(bad)).toBe(false);
    expect(() => parseDeployTargets([{ ...api, watchPaths: ['../x'] }])).toThrow('watchPaths');
    expect(parseDeployTargets([{ ...api, watchPaths: apiWatch }])[0].watchPaths).toEqual(apiWatch);
    const trees: Record<string, { name: string; mode: string; hash: string; type: 'tree' | 'blob' }[]> = {
      rootA: [{ name: 'apps', mode: '40000', hash: 'appsA', type: 'tree' }, { name: 'pnpm-lock.yaml', mode: '100644', hash: 'lock1', type: 'blob' }, { name: 'docs', mode: '40000', hash: 'docs', type: 'tree' }],
      rootB: [{ name: 'apps', mode: '40000', hash: 'appsB', type: 'tree' }, { name: 'pnpm-lock.yaml', mode: '100644', hash: 'lock2', type: 'blob' }, { name: 'docs', mode: '40000', hash: 'docs', type: 'tree' }],
      appsA: [{ name: 'web', mode: '40000', hash: 'webA', type: 'tree' }],
      appsB: [{ name: 'web', mode: '40000', hash: 'webB', type: 'tree' }, { name: 'api', mode: '40000', hash: 'apiNew', type: 'tree' }],
      webA: [{ name: 'index.ts', mode: '100644', hash: 'i1', type: 'blob' }],
      webB: [{ name: 'index.ts', mode: '100644', hash: 'i2', type: 'blob' }],
      apiNew: [{ name: 'main.ts', mode: '100644', hash: 'm1', type: 'blob' }],
    };
    const readTree = vi.fn(async (hash: string) => trees[hash] ?? null);
    const source = { readTree, log: async ({ ref }: { ref?: string }) => [{ hash: ref!, message: '', treeHash: ref === 'a'.repeat(40) ? 'rootA' : 'rootB' }] } as never;
    expect((await changedPaths(source, 'a'.repeat(40), 'b'.repeat(40)))?.sort()).toEqual(['apps/api/main.ts', 'apps/web/index.ts', 'pnpm-lock.yaml']);
    expect(readTree).not.toHaveBeenCalledWith('docs');
    expect(await changedPaths(source, 'a'.repeat(40), 'b'.repeat(40), 1)).toBeNull();
  });
});

describe('deploy target settings', () => {
  it('validates targets and the gitflare.json deploy block', () => {
    expect(parseDeployTargets([{ workerName: 'prahari-api', configPath: 'apps/api/wrangler.jsonc', d1Migrations: true }, { workerName: 'prahari-web', configPath: 'apps/web/wrangler.jsonc', buildCommand: ' pnpm --filter @prahari/web build ' }])).toEqual([api, web]);
    for (const bad of [[], [{ workerName: 'x', configPath: '../wrangler.jsonc' }], [{ workerName: 'x', configPath: 'apps/x/package.json' }], [{ workerName: 'x', configPath: 'wrangler.toml', buildCommand: 'a\nb' }], [{ workerName: 'x', configPath: 'wrangler.toml' }, { workerName: 'x', configPath: 'a/wrangler.toml' }]]) expect(() => parseDeployTargets(bad)).toThrow(ApiError);
    expect(policyDeployTargets(null)).toBeNull();
    expect(policyDeployTargets('{"testCommand":"npm test"}')).toBeNull();
    expect(policyDeployTargets(JSON.stringify({ deploy: { targets: [{ workerName: 'prahari-api', configPath: 'apps/api/wrangler.jsonc', d1Migrations: true }] } }))).toEqual([api]);
    expect(() => policyDeployTargets('{"deploy":[]}')).toThrow('DEPLOY_POLICY_INVALID');
    expect(() => policyDeployTargets('{')).toThrow('DEPLOY_POLICY_INVALID');
    const staged = { ...api, workerName: 'prahari-api-staging' };
    const both = JSON.stringify({ deploy: { targets: [api], environments: { staging: { targets: [{ ...staged, watchPaths: ['apps/api/**'] }] } } } });
    expect(policyDeployTargets(both, 'staging')).toEqual([{ ...staged, watchPaths: ['apps/api/**'] }]);
    expect(policyDeployTargets(both, 'production')).toEqual([api]);
    expect(policyDeployTargets(JSON.stringify({ deploy: { environments: { staging: { targets: [staged] } } } }), 'production')).toBeNull();
    expect(policyDeployTargets(JSON.stringify({ deploy: { targets: [api] } }), 'staging')).toBeNull();
    expect(() => policyDeployTargets(JSON.stringify({ deploy: { environments: { 'QA env': { targets: [api] } } } }), 'staging')).toThrow('DEPLOY_POLICY_INVALID');
  });

  function context(principal: Principal, book = ledger(), audits: string[] = []): DeployApiContext {
    return {
      repository: { id: 'repo', name: 'prahari', defaultBranch: 'main' } as Repository,
      principal,
      ledger: { state: async () => book.state(), get: async (id) => book.get(id), saveEnvironment: async (environment, value) => book.saveEnvironment(environment, value), create: async (key, fingerprint, value) => book.create(key, fingerprint, value), confirm: async (id, actorId) => book.confirm(id, actorId) },
      authorizeRead: async () => {},
      authorizeDeploy: async () => {},
      canDeploy: async () => true,
      mappedWorkers: async () => ({ accountId, workers: [{ id: 'prahari-api', name: 'prahari-api', environment: 'production' }, { id: 'prahari-web', name: 'prahari-web', environment: 'production' }] }),
      headSha: async () => sha,
      dispatch: async () => 'running',
      failDispatch: async () => {},
      audit: async (action) => { audits.push(action); },
    };
  }
  const post = (body: Record<string, unknown>) => new Request('https://gitflare.test/api/repositories/repo/deployments', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) });
  const settings = { action: 'settings', enabled: true, environment: 'production', rollout: 'immediate', confirmation: 'auto', mode: 'deploy', targets: [api, web] };

  it('saves ordered targets, allows automatic production deploys only for Owners, and audits the change', async () => {
    const book = ledger();
    const audits: string[] = [];
    await expect(deploymentsApi(post(settings), context({ userId: 'deployer', workspaceId: 'w', role: 'Deployer' }, book, audits))).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    const saved = await (await deploymentsApi(post(settings), context(owner, book, audits))).json() as { settings: Record<string, unknown> };
    expect(saved.settings).toMatchObject({ environments: { production: { workerName: 'prahari-api', accountId, trigger: 'auto', mode: 'deploy', targets: [api, web] } } });
    expect(audits).toEqual(['repository.deploy-settings.production.auto.deploy']);
    await expect(deploymentsApi(post({ ...settings, targets: [{ workerName: 'unlinked', configPath: 'wrangler.jsonc' }] }), context(owner, book))).rejects.toMatchObject({ code: 'WORKER_NOT_MAPPED' });
    await expect(deploymentsApi(post({ ...settings, mode: 'later' }), context(owner, book))).rejects.toMatchObject({ code: 'INVALID_DEPLOY_MODE' });
    const [landed] = landedDeployments(book.settings(), 'repo', 'mission', sha, 'b'.repeat(40));
    expect(landed).toMatchObject({ status: 'queued', mode: 'deploy', baseSha: 'b'.repeat(40), targets: [{ workerName: 'prahari-api', status: 'pending' }, { workerName: 'prahari-web', status: 'pending' }] });
    const manual = await (await deploymentsApi(post({ action: 'deploy', commitSha: sha }), context(owner, book))).json() as { deployment: DeploymentRecord };
    expect(manual.deployment.targets?.map((target) => target.workerName)).toEqual(['prahari-api', 'prahari-web']);
    expect(manual.deployment.selectedWorkers).toBeUndefined();
  });

  it('records a chosen subset of targets for a manual deploy and refuses names outside the environment', async () => {
    const book = ledger();
    await deploymentsApi(post({ ...settings, environment: 'staging', confirmation: undefined, targets: [{ ...api, watchPaths: ['apps/api/**'] }, web] }), context(owner, book));
    expect(book.settings()?.environments.staging).toMatchObject({ trigger: 'manual', targets: [{ workerName: 'prahari-api', watchPaths: ['apps/api/**'] }, { workerName: 'prahari-web' }] });
    const subset = await (await deploymentsApi(post({ action: 'deploy', environment: 'staging', commitSha: sha, targets: ['prahari-web'] }), context(owner, book))).json() as { deployment: DeploymentRecord };
    expect(subset.deployment).toMatchObject({ environment: 'staging', selectedWorkers: ['prahari-web'] });
    await expect(deploymentsApi(post({ action: 'deploy', environment: 'staging', commitSha: sha, targets: ['prahari-cron'] }), context(owner, book))).rejects.toMatchObject({ code: 'DEPLOY_TARGET_NOT_CONFIGURED' });
    book.update(subset.deployment.id, ['queued'], { status: 'failed' });
    const all = await (await deploymentsApi(post({ action: 'deploy', environment: 'staging', commitSha: sha, targets: ['prahari-web', 'prahari-api'] }), context(owner, book))).json() as { deployment: DeploymentRecord };
    expect(all.deployment.selectedWorkers).toBeUndefined();
  });

  it('lets Deployers keep production behind confirmation and upload versions only', async () => {
    const response = await deploymentsApi(post({ ...settings, confirmation: 'manual', mode: 'upload-only' }), context({ userId: 'deployer', workspaceId: 'w', role: 'Deployer' }));
    expect(await response.json()).toMatchObject({ settings: { environments: { production: { trigger: 'manual', mode: 'upload-only' } } } });
  });
});
