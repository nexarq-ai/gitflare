import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: DurableObjectState, protected env: unknown) {} }, WorkerEntrypoint: class {}, WorkflowEntrypoint: class {} }));
import type { Repository } from '../src/shared/types';
import type { AppEnv } from '../src/worker/env';
import type { Principal } from '../src/worker/security';
import type { CloudflareCall } from '../src/worker/cloudflare-deploy';
import { ApiError } from '../src/worker/domain';
import { GitflareCoordinator } from '../src/worker/coordinator';
import { deploymentsApi, type DeployApiContext, type DeployEnvironmentSettings, type DeploymentRecord } from '../src/worker/deployments';
import { deployAccessHostnames, routeDestination, type DeployAccessClient } from '../src/worker/deploy-access';
import { ACCESS_SCOPE_MISSING_MESSAGE } from '../src/worker/preview-access';
import type { DetectedSetup } from '../src/worker/deploy-detect';

const accountId = 'a'.repeat(32);
const otherAccount = 'b'.repeat(32);
const scope = 'account-access.write';
const owner: Principal = { userId: 'owner', workspaceId: 'w', role: 'Owner' };
const deployer: Principal = { userId: 'deployer', workspaceId: 'w', role: 'Deployer' };
const taskCredential: Principal = { ...owner, credentialId: 'task-credential' };
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); });

function coordinatorHarness() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  const ctx = {
    storage: {
      getAlarm: vi.fn(async () => null), setAlarm: vi.fn(async () => {}),
      sql: { exec(query: string, ...args: SQLInputValue[]) { const statement = db.prepare(query); const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []); return { toArray: () => rows }; } },
      transactionSync<T>(fn: () => T): T { db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    },
  } as unknown as DurableObjectState;
  return new GitflareCoordinator(ctx, {} as AppEnv);
}

interface Recorded { method: string; path: string; json?: unknown }
type Stored = Record<string, unknown> & { id: string };

function cloudflare(seed: Stored[] = [], subdomain = true) {
  const apps = new Map<string, Stored>(seed.map((app) => [app.id, app]));
  const policies = new Map<string, Stored>();
  const calls: Recorded[] = [];
  let next = 0;
  const call = (async (path: string, init: { method?: string; json?: unknown; allowNotFound?: boolean } = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, path, ...(init.json !== undefined ? { json: init.json } : {}) });
    if (path.endsWith('/workers/subdomain')) return subdomain ? { subdomain: 'acme' } : {};
    if (path.endsWith('/access/apps') && method === 'GET') return [...apps.values()];
    const collection = /\/access\/(apps|policies)$/.exec(path);
    if (collection && method === 'POST') {
      const id = `${collection[1] === 'apps' ? 'app' : 'policy'}-${++next}`;
      (collection[1] === 'apps' ? apps : policies).set(id, { ...(init.json as object), id });
      return { id };
    }
    const item = /\/access\/(apps|policies)\/([^/]+)$/.exec(path);
    if (item) {
      const store = item[1] === 'apps' ? apps : policies;
      const found = store.get(item[2]);
      if (!found) { if (init.allowNotFound) return null; throw new ApiError(404, 'CLOUDFLARE_NOT_FOUND', `Cloudflare rejected ${method} ${path}.`); }
      if (method === 'GET') return found;
      if (method === 'DELETE') { store.delete(item[2]); return { id: item[2] }; }
      store.set(item[2], { ...(init.json as object), id: item[2] });
      return { id: item[2] };
    }
    throw new Error(`unexpected ${method} ${path}`);
  }) as CloudflareCall;
  return { apps, policies, calls, call };
}

const staging: DeployEnvironmentSettings = { enabled: true, workerName: 'shop-staging', accountId, rollout: 'immediate', trigger: 'auto', targets: [{ workerName: 'shop-staging', configPath: 'wrangler.jsonc', d1Migrations: false }, { workerName: 'shop-api-staging', configPath: 'apps/api/wrangler.jsonc', d1Migrations: false }], authorizedBy: owner, updatedAt: '2026-10-15T00:00:00.000Z' };

function live(urls: string[], order = 0): DeploymentRecord {
  const now = new Date().toISOString();
  return { id: `000${order}live-${crypto.randomUUID()}`, attemptId: crypto.randomUUID(), repositoryId: 'repo', workerName: 'shop-staging', accountId, environment: 'staging', rollout: 'immediate', commitSha: 'c'.repeat(40), trigger: 'land', status: 'succeeded', percentage: 100, actorId: 'owner', createdAt: now, updatedAt: now, targets: [{ workerName: 'shop-staging', configPath: 'wrangler.jsonc', d1Migrations: false, status: 'succeeded', percentage: 100, versionId: 'v1', urls }] };
}

function detected(): DetectedSetup {
  const target = (workerName: string, routes: string[], customDomains: string[]) => ({ workerName, configPath: 'wrangler.jsonc', packageDir: '', buildReasons: [], d1Migrations: false, watchPaths: [], dependsOn: [], resources: [], routes, customDomains, workersDev: true, requiredScopes: [] });
  return { commitSha: 'c'.repeat(40), fingerprint: 'f', files: {}, packageManager: null, configs: [], errors: [], problems: [], notes: [], truncated: false, environments: { staging: { warnings: [], targets: [target('shop-staging', ['api.staging.example.com/*'], ['staging.example.com']), target('unrelated', ['other.example.com/*'], [])] } } };
}

function fixture(options: { scopes?: string[]; env?: { CLOUDFLARE_ACCESS_SCOPES?: string }; connectionAccount?: string; seed?: Stored[]; urls?: string[]; subdomain?: boolean; detect?: boolean } = {}) {
  const coordinator = coordinatorHarness();
  coordinator.saveDeployEnvironment('staging', staging);
  coordinator.createDeployment('seed-live-000001', 'seed', live(options.urls ?? ['https://shop-staging.acme.workers.dev', 'https://staging.example.com']));
  const api = cloudflare(options.seed, options.subdomain ?? true);
  const audit: string[] = [];
  let connection: DeployAccessClient = { accountId: options.connectionAccount ?? accountId, scopes: options.scopes ?? ['workers-scripts.edit', scope], call: api.call };
  const run = async (principal: Principal, body?: Record<string, unknown>, key: string = crypto.randomUUID()) => {
    const context: DeployApiContext = {
      repository: { id: 'repo', name: 'shop', defaultBranch: 'main' } as Repository,
      principal,
      ledger: { state: async () => coordinator.deployState(), get: async (id) => coordinator.getDeployment(id), saveEnvironment: async (environment, value) => coordinator.saveDeployEnvironment(environment, value), create: async (k, fingerprint, value) => coordinator.createDeployment(k, fingerprint, value), confirm: async (id, actorId) => coordinator.confirmDeployment(id, actorId) },
      detectSetup: async () => { if (options.detect === false) throw new Error('scan failed'); return detected(); },
      authorizeRead: async () => {},
      authorizeDeploy: async () => {},
      canDeploy: async () => true,
      mappedWorkers: async () => ({ accountId, workers: [] }),
      headSha: async () => null,
      dispatch: async () => 'running',
      failDispatch: async () => {},
      audit: async (action) => { audit.push(action); },
      access: {
        store: { records: async () => coordinator.deployAccess(), receipt: async (k, fingerprint) => coordinator.deployAccessReceipt(k, fingerprint), save: async (k, fingerprint, environment, record, result) => coordinator.saveDeployAccess(k, fingerprint, environment, record, result) },
        client: async () => connection,
        scopes: options.env ?? { CLOUDFLARE_ACCESS_SCOPES: scope },
      },
    };
    const request = new Request('https://gitflare.test/api/repositories/repo/deployments', body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) } : {});
    return (await deploymentsApi(request, context)).json() as Promise<Record<string, any>>;
  };
  return { coordinator, api, audit, run, setConnection: (value: Partial<DeployAccessClient>) => { connection = { ...connection, ...value }; } };
}

const enable = (fields: Record<string, unknown> = {}) => ({ action: 'access', environment: 'staging', enabled: true, domains: ['nexarq.ai'], ...fields });

describe('deploy environment Cloudflare Access', () => {
  it('derives destinations from routes, custom domains, live URLs and workers.dev', () => {
    expect(routeDestination('https://Api.Example.com/*')).toBe('api.example.com');
    expect(routeDestination('*.example.com/admin/*')).toBe('*.example.com/admin');
    expect(routeDestination('not a host')).toBeNull();
    expect(deployAccessHostnames({ workers: ['shop-staging', 'shop-api-staging'], subdomain: 'acme', liveUrls: ['https://shop-staging.acme.workers.dev', 'https://staging.example.com'], routes: ['api.staging.example.com/*'], customDomains: ['staging.example.com'] }))
      .toEqual(['api.staging.example.com', 'staging.example.com', 'shop-api-staging.acme.workers.dev', 'shop-staging.acme.workers.dev']);
  });

  it('creates one application and policy, then updates them in place without duplicates', async () => {
    const f = fixture();
    const created = await f.run(owner, enable({ emails: ['Alex@Example.com'], groupId: 'group-1234-abcd' }));
    expect(created.access).toMatchObject({ status: 'protected', appId: 'app-2', created: true, canChange: true, hostnames: ['api.staging.example.com', 'staging.example.com', 'shop-api-staging.acme.workers.dev', 'shop-staging.acme.workers.dev'], includes: { emails: ['alex@example.com'], domains: ['nexarq.ai'], groupId: 'group-1234-abcd' } });
    const app = f.api.apps.get('app-2')!;
    expect(app).toMatchObject({ name: 'Gitflare deploy: shop/staging', type: 'self_hosted', domain: 'api.staging.example.com', policies: [{ id: 'policy-1', precedence: 1 }] });
    expect((app.destinations as { uri: string }[]).map((item) => item.uri)).not.toContain('other.example.com');
    expect(f.api.policies.get('policy-1')).toMatchObject({ decision: 'allow', include: [{ email: { email: 'alex@example.com' } }, { email_domain: { domain: 'nexarq.ai' } }, { group: { id: 'group-1234-abcd' } }] });

    const updated = await f.run(owner, enable({ domains: ['example.com'] }));
    expect(updated.access).toMatchObject({ status: 'protected', appId: 'app-2', created: true, includes: { emails: [], domains: ['example.com'] } });
    expect(f.api.apps.size).toBe(1);
    expect(f.api.policies.size).toBe(1);
    expect(f.api.calls.filter((call) => call.method === 'PUT').map((call) => call.path)).toEqual([`/accounts/${accountId}/access/policies/policy-1`, `/accounts/${accountId}/access/apps/app-2`]);
    expect(f.audit).toEqual(['repository.deploy-access.staging.enabled', 'repository.deploy-access.staging.updated']);

    const state = await f.run(owner);
    expect(state.environments.staging.access).toMatchObject({ status: 'protected', appId: 'app-2' });
    expect(state.environments.production.access).toMatchObject({ status: 'unprotected', hostnames: [], canChange: true });
  });

  it('replays the same idempotency key without calling Cloudflare again and refuses a reused key', async () => {
    const f = fixture();
    const key = 'deploy-access-key-0001';
    const first = await f.run(owner, enable(), key);
    const count = f.api.calls.length;
    expect(await f.run(owner, enable(), key)).toEqual(first);
    expect(f.api.calls.length).toBe(count);
    await expect(f.run(owner, enable({ domains: ['other.com'] }), key)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses non-Owners, task credentials and an empty allow list', async () => {
    const f = fixture();
    await expect(f.run(deployer, enable())).rejects.toMatchObject({ code: 'OWNER_REQUIRED', detail: expect.stringContaining('Only an Owner') });
    await expect(f.run(taskCredential, enable())).rejects.toMatchObject({ code: 'OWNER_REQUIRED', detail: expect.stringContaining('Task credentials') });
    await expect(f.run(owner, enable({ domains: [] }))).rejects.toMatchObject({ code: 'DEPLOY_ACCESS_EMPTY' });
    expect(f.api.calls).toEqual([]);
    expect((await f.run(deployer)).environments.staging.access).toMatchObject({ status: 'unprotected', canChange: false });
  });

  it('names the missing Access scope and refuses another account', async () => {
    const unrequested = fixture({ env: { CLOUDFLARE_ACCESS_SCOPES: '' } });
    await expect(unrequested.run(owner, enable())).rejects.toMatchObject({ code: 'CLOUDFLARE_ACCESS_SCOPE_MISSING', detail: expect.stringContaining('CLOUDFLARE_ACCESS_SCOPES is empty') });
    const ungranted = fixture({ scopes: ['workers-scripts.edit'] });
    await expect(ungranted.run(owner, enable())).rejects.toMatchObject({ code: 'CLOUDFLARE_ACCESS_SCOPE_MISSING', detail: `${ACCESS_SCOPE_MISSING_MESSAGE}. The Cloudflare connection was not granted ${scope}; an Owner must reconnect Cloudflare. Access protection of staging stays unchanged.` });
    expect(ungranted.api.calls).toEqual([]);
    const elsewhere = fixture({ connectionAccount: otherAccount });
    await expect(elsewhere.run(owner, enable())).rejects.toMatchObject({ code: 'CLOUDFLARE_ACCOUNT_MISMATCH' });
  });

  it('refuses to take over an application Gitflare did not create on the same hostname', async () => {
    const f = fixture({ seed: [{ id: 'foreign', name: 'Team staging', domain: 'staging.example.com', destinations: [{ type: 'public', uri: 'staging.example.com' }] }] });
    await expect(f.run(owner, enable())).rejects.toMatchObject({ code: 'DEPLOY_ACCESS_CONFLICT', detail: expect.stringContaining('Team staging (foreign) already covers staging.example.com') });
    expect(f.api.apps.get('foreign')).toMatchObject({ name: 'Team staging' });
  });

  it('protects zone hostnames through the zone’s Access endpoints when the Access permission is zone-level', async () => {
    const zoneId = 'e'.repeat(32);
    const zoneScopes = { CLOUDFLARE_ACCESS_SCOPES: 'zone-access.write zone-access.read' };
    const f = fixture({ env: zoneScopes, scopes: ['workers-scripts.edit', 'zone-access.write', 'zone-access.read'] });
    const appPolicies = new Map<string, Stored>();
    const lookups: string[] = [];
    const base = f.api.call;
    const call = (async (path: string, init: { method?: string; json?: unknown; allowNotFound?: boolean; query?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      if (path === '/zones') { lookups.push(init.query!.name!); expect(init.query!['account.id']).toBe(accountId); return init.query!.name === 'example.com' ? [{ id: zoneId, name: 'example.com' }] : []; }
      const nested = /\/access\/apps\/([^/]+)\/policies(?:\/([^/]+))?$/.exec(path);
      if (nested) {
        f.api.calls.push({ method, path, ...(init.json !== undefined ? { json: init.json } : {}) });
        if (!nested[2] && method === 'GET') return [...appPolicies.values()];
        if (!nested[2] && method === 'POST') { const id = `zone-policy-${appPolicies.size + 1}`; appPolicies.set(id, { ...(init.json as object), id }); return { id }; }
        if (!appPolicies.has(nested[2]!)) { if (init.allowNotFound) return null; throw new ApiError(404, 'CLOUDFLARE_NOT_FOUND', 'missing'); }
        appPolicies.set(nested[2]!, { ...(init.json as object), id: nested[2]! });
        return { id: nested[2] };
      }
      return base(path, init as never);
    }) as CloudflareCall;
    f.setConnection({ call });
    const created = await f.run(owner, enable());
    expect(created.access).toMatchObject({ status: 'protected', hostnames: ['api.staging.example.com', 'staging.example.com'], created: true });
    expect(created.notes.join(' ')).toContain('shop-api-staging.acme.workers.dev, shop-staging.acme.workers.dev are on workers.dev, not on zone example.com');
    expect(lookups).toEqual(['api.staging.example.com', 'staging.example.com', 'example.com']);
    const zonePaths = f.api.calls.filter((item) => item.path.includes('/access/')).map((item) => `${item.method} ${item.path}`);
    expect(zonePaths.every((item) => item.includes(`/zones/${zoneId}/access/`))).toBe(true);
    expect(zonePaths).toContain(`POST /zones/${zoneId}/access/apps/app-1/policies`);
    expect(f.api.apps.get('app-1')).not.toHaveProperty('policies');
    expect(appPolicies.get('zone-policy-1')).toMatchObject({ decision: 'allow', precedence: 1, include: [{ email_domain: { domain: 'nexarq.ai' } }] });
    expect(f.coordinator.deployAccess()[0]).toMatchObject({ zoneId, zoneName: 'example.com', policyCreated: true });
    expect((await f.run(owner)).environments.staging.access).toMatchObject({ status: 'protected' });
    await f.run(owner, enable({ domains: ['example.com'] }));
    expect(appPolicies.size).toBe(1);
    expect(f.api.calls.filter((item) => item.method === 'PUT').map((item) => item.path)).toEqual([`/zones/${zoneId}/access/apps/app-1`, `/zones/${zoneId}/access/apps/app-1/policies/zone-policy-1`]);
    const removed = await f.run(owner, { action: 'access', environment: 'staging', enabled: false });
    expect(removed.removed).toMatchObject({ appId: 'app-1', deleted: true });
    expect(f.api.calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/zones/${zoneId}/access/apps/app-1` });
  });

  it('refuses zone-level protection for workers.dev only and for hostnames on several zones', async () => {
    const zoneScopes = { CLOUDFLARE_ACCESS_SCOPES: 'zone-access.write zone-access.read' };
    const onlyWorkersDev = fixture({ env: zoneScopes, scopes: ['zone-access.write', 'zone-access.read'], urls: ['https://shop-staging.acme.workers.dev'], detect: false });
    await expect(onlyWorkersDev.run(owner, enable())).rejects.toMatchObject({ code: 'DEPLOY_ACCESS_ZONE_REQUIRED' });
    const split = fixture({ env: zoneScopes, scopes: ['zone-access.write', 'zone-access.read'], urls: ['https://shop.other.test'] });
    const base = split.api.call;
    const zones: Record<string, string> = { 'example.com': 'e'.repeat(32), 'other.test': 'f'.repeat(32) };
    split.setConnection({ call: (async (path: string, init: { query?: Record<string, string> } = {}) => path === '/zones' ? (zones[init.query!.name!] ? [{ id: zones[init.query!.name!], name: init.query!.name }] : []) : base(path, init as never)) as CloudflareCall });
    await expect(split.run(owner, enable())).rejects.toMatchObject({ code: 'DEPLOY_ACCESS_MULTIPLE_ZONES' });
    const refused = fixture({ env: zoneScopes, scopes: ['zone-access.write', 'zone-access.read'] });
    const plain = refused.api.call;
    refused.setConnection({ call: (async (path: string, init: unknown) => { if (path === '/zones') throw new ApiError(403, 'CLOUDFLARE_FORBIDDEN', 'Authentication error [10000]'); return plain(path, init as never); }) as CloudflareCall });
    await expect(refused.run(owner, enable())).rejects.toMatchObject({ code: 'DEPLOY_ACCESS_ZONE_LOOKUP_FAILED', detail: expect.stringContaining('Authentication error [10000]') });
  });

  it('removes only applications Gitflare created and detaches adopted ones', async () => {
    const f = fixture();
    await f.run(owner, enable());
    const removed = await f.run(owner, { action: 'access', environment: 'staging', enabled: false });
    expect(removed).toMatchObject({ access: { status: 'unprotected' }, removed: { appId: 'app-2', deleted: true } });
    expect(f.api.apps.size).toBe(0);
    expect(f.api.policies.size).toBe(0);
    expect(f.audit.at(-1)).toBe('repository.deploy-access.staging.removed');

    const adopted = fixture({ seed: [{ id: 'kept', name: 'Gitflare deploy: shop/staging', domain: 'staging.example.com', policies: [] }] });
    expect((await adopted.run(owner, enable())).access).toMatchObject({ appId: 'kept', created: false });
    const detached = await adopted.run(owner, { action: 'access', environment: 'staging', enabled: false });
    expect(detached.removed).toMatchObject({ appId: 'kept', deleted: false, note: expect.stringContaining('did not create it') });
    expect(adopted.api.apps.has('kept')).toBe(true);
    expect(adopted.api.calls.some((call) => call.method === 'DELETE' && call.path.endsWith('/apps/kept'))).toBe(false);
    expect(adopted.coordinator.deployAccess()).toEqual([]);
  });

  it('reports errors for a deleted or drifted application, a lost scope and new unprotected hostnames', async () => {
    const f = fixture();
    await f.run(owner, enable());
    f.api.apps.set('app-2', { ...f.api.apps.get('app-2')!, destinations: [{ type: 'public', uri: 'staging.example.com' }] });
    expect((await f.run(owner)).environments.staging.access).toMatchObject({ status: 'error', reason: expect.stringContaining('changed outside Gitflare and no longer covers api.staging.example.com') });
    f.api.apps.delete('app-2');
    expect((await f.run(owner)).environments.staging.access).toMatchObject({ status: 'error', reason: expect.stringContaining('no longer exists in Cloudflare') });
    await f.run(owner, enable());
    expect((await f.run(owner)).environments.staging.access).toMatchObject({ status: 'protected' });
    f.setConnection({ scopes: ['workers-scripts.edit'] });
    expect((await f.run(owner)).environments.staging.access).toMatchObject({ status: 'error', reason: expect.stringContaining(ACCESS_SCOPE_MISSING_MESSAGE) });
    f.setConnection({ scopes: [scope], accountId: otherAccount });
    expect((await f.run(owner)).environments.staging.access).toMatchObject({ status: 'error', reason: expect.stringContaining(`is on Cloudflare account ${accountId}`) });
    f.setConnection({ accountId });
    f.coordinator.createDeployment('seed-live-000002', 'seed-2', live(['https://new.example.com'], 1));
    expect((await f.run(owner)).environments.staging.access).toMatchObject({ status: 'error', reason: expect.stringContaining('now also serves new.example.com') });
  });

  it('needs hostnames and a configured environment', async () => {
    const f = fixture();
    await expect(f.run(owner, enable({ environment: 'qa' }))).rejects.toMatchObject({ code: 'DEPLOY_NOT_CONFIGURED' });
    const bare = fixture({ urls: [], subdomain: false, detect: false });
    await expect(bare.run(owner, enable())).rejects.toMatchObject({ code: 'DEPLOY_ACCESS_NO_HOSTNAMES', detail: expect.stringContaining('staging has no hostnames yet') });
    expect(bare.api.calls.some((call) => call.path.includes('/access/'))).toBe(false);
  });
});
