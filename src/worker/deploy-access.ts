import { ApiError } from './domain';
import type { CloudflareCall } from './cloudflare-deploy';
import type { Principal } from './security';
import type { SqlStore } from './store';
import type { DeployEnvironmentSettings } from './deployments';
import { ACCESS_SCOPE_MISSING_MESSAGE, accessMode, accessScopeState, assertAccessScope, workersSubdomain, type AccessScopeEnv } from './preview-access';

export const DEPLOY_ACCESS_PREFIX = 'deploy-access:';
const MAX_EMAILS = 200;
const MAX_DOMAINS = 50;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const domainPattern = new RegExp(`^(?=.{1,253}$)(?:${label}\\.)+[a-z]{2,63}$`);
const destinationPattern = new RegExp(`^(?:\\*\\.)?(?:${label}\\.)+[a-z]{2,63}(?:/[A-Za-z0-9._~*/-]*)?$`);
const groupPattern = /^[A-Za-z0-9-]{8,64}$/;

export type DeployAccessStatus = 'protected' | 'unprotected' | 'error';
export interface DeployAccessIncludes { emails: string[]; domains: string[]; groupId?: string }
export interface DeployAccessRecord {
  environment: string;
  accountId: string;
  appId: string;
  appName: string;
  policyId: string;
  created: boolean;
  policyCreated: boolean;
  zoneId?: string;
  zoneName?: string;
  hostnames: string[];
  includes: DeployAccessIncludes;
  updatedAt: string;
  updatedBy: string;
}
export interface DeployAccessView {
  status: DeployAccessStatus;
  reason?: string;
  appId?: string;
  hostnames: string[];
  includes: DeployAccessIncludes | null;
  created: boolean;
  canChange: boolean;
  updatedAt?: string;
  updatedBy?: string;
}
export interface DeployAccessRemoval { appId: string; deleted: boolean; note?: string }
export interface DeployAccessResult { environment: string; access: DeployAccessView; removed?: DeployAccessRemoval; notes: string[] }
export interface DeployAccessClient { accountId: string; scopes: string[]; call: CloudflareCall }
export interface DeployAccessStore {
  records(): Promise<DeployAccessRecord[]>;
  receipt(key: string, fingerprint: string): Promise<DeployAccessResult | null>;
  save(key: string, fingerprint: string, environment: string, record: DeployAccessRecord | null, result: DeployAccessResult): Promise<DeployAccessResult>;
}
export interface DeployAccessDeps { store: DeployAccessStore; client(environment?: string): Promise<DeployAccessClient>; scopes: AccessScopeEnv }
export interface DeployAccessTarget {
  environment: string;
  settings?: DeployEnvironmentSettings;
  liveUrls: string[];
  detected?: () => Promise<{ routes: string[]; customDomains: string[] } | null>;
}

interface AccessPolicy { id?: string; name?: string }
interface AccessApp { id?: string; name?: string; domain?: string; destinations?: { type?: string; uri?: string }[]; policies?: AccessPolicy[] }

export class DeployAccessBook {
  constructor(private readonly store: SqlStore) {}
  list(): DeployAccessRecord[] { return this.store.list<DeployAccessRecord>(DEPLOY_ACCESS_PREFIX); }
  save(environment: string, record: DeployAccessRecord | null): void {
    if (record) this.store.put(`${DEPLOY_ACCESS_PREFIX}${environment}`, record);
    else this.store.delete(`${DEPLOY_ACCESS_PREFIX}${environment}`);
  }
}

export function deployAccessAppName(repositoryName: string, environment: string): string {
  return `Gitflare deploy: ${repositoryName}/${environment}`;
}

const canChange = (principal: Principal) => principal.role === 'Owner' && !principal.credentialId;

export function assertDeployAccessOwner(principal: Principal): void {
  if (principal.credentialId) throw new ApiError(403, 'OWNER_REQUIRED', 'Task credentials cannot change Cloudflare Access protection of deploy environments.');
  if (principal.role !== 'Owner') throw new ApiError(403, 'OWNER_REQUIRED', 'Only an Owner can change Cloudflare Access protection of deploy environments.');
}

function stringList(value: unknown, field: string, max: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max || !value.every((item) => typeof item === 'string')) throw new ApiError(400, 'INVALID_DEPLOY_ACCESS', `${field} must be a list of at most ${max} strings.`);
  return value as string[];
}

export function parseDeployAccessIncludes(body: Record<string, unknown>): DeployAccessIncludes {
  const emails = [...new Set(stringList(body.emails, 'emails', MAX_EMAILS).map((email) => email.trim().toLowerCase()))];
  const invalidEmail = emails.find((email) => !emailPattern.test(email) || email.length > 254);
  if (invalidEmail) throw new ApiError(400, 'INVALID_DEPLOY_ACCESS', `${invalidEmail} is not an email address.`);
  const domains = [...new Set(stringList(body.domains, 'domains', MAX_DOMAINS).map((domain) => domain.trim().toLowerCase().replace(/^@/, '')))];
  const invalidDomain = domains.find((domain) => !domainPattern.test(domain));
  if (invalidDomain) throw new ApiError(400, 'INVALID_DEPLOY_ACCESS', `${invalidDomain} is not an email domain such as example.com.`);
  const groupId = typeof body.groupId === 'string' && body.groupId.trim() ? body.groupId.trim() : undefined;
  if (body.groupId !== undefined && body.groupId !== null && body.groupId !== '' && (!groupId || !groupPattern.test(groupId))) throw new ApiError(400, 'INVALID_DEPLOY_ACCESS', 'groupId must be the id of an existing Cloudflare Access group.');
  if (!emails.length && !domains.length && !groupId) throw new ApiError(400, 'DEPLOY_ACCESS_EMPTY', 'Cloudflare Access needs at least one email, email domain or Access group to allow.');
  return { emails, domains, ...(groupId ? { groupId } : {}) };
}

function includeRules(includes: DeployAccessIncludes): Record<string, unknown>[] {
  return [
    ...includes.emails.map((email) => ({ email: { email } })),
    ...includes.domains.map((domain) => ({ email_domain: { domain } })),
    ...(includes.groupId ? [{ group: { id: includes.groupId } }] : []),
  ];
}

export function urlHostname(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase() || null; } catch { return null; }
}

export function routeDestination(pattern: string): string | null {
  const bare = pattern.trim().replace(/^https?:\/\//i, '').replace(/\/\*?$/, '');
  const slash = bare.indexOf('/');
  const value = slash === -1 ? bare.toLowerCase() : `${bare.slice(0, slash).toLowerCase()}${bare.slice(slash)}`;
  return destinationPattern.test(value) ? value : null;
}

export function deployAccessHostnames(input: { workers: string[]; subdomain: string | null; liveUrls: string[]; routes: string[]; customDomains: string[] }): string[] {
  const values = [
    ...input.customDomains.map(routeDestination),
    ...input.routes.map(routeDestination),
    ...input.liveUrls.map(urlHostname),
    ...(input.subdomain ? input.workers.map((worker) => `${worker.toLowerCase()}.${input.subdomain}.workers.dev`) : []),
  ].filter((value): value is string => !!value && destinationPattern.test(value));
  const unique = [...new Set(values)];
  const workersDev = (value: string) => value.endsWith('.workers.dev');
  return [...unique.filter((value) => !workersDev(value)).sort(), ...unique.filter(workersDev).sort()];
}

function appDestinations(app: AccessApp): string[] {
  const uris = (app.destinations ?? []).map((item) => item?.uri).filter((uri): uri is string => typeof uri === 'string');
  return (uris.length ? uris : app.domain ? [app.domain] : []).map((uri) => uri.toLowerCase());
}

export interface AccessZone { id: string; name: string }
const zonePattern = /^[a-f0-9]{32}$/;
const isWorkersDev = (destination: string) => destination.split('/')[0]!.endsWith('.workers.dev');

export function accessBase(location: { accountId: string; zoneId?: string }): string {
  return location.zoneId ? `/zones/${location.zoneId}/access` : `/accounts/${location.accountId}/access`;
}

export async function accessZone(call: CloudflareCall, accountId: string, hostnames: string[]): Promise<AccessZone | null> {
  const custom = hostnames.filter((host) => !isWorkersDev(host));
  if (!custom.length) return null;
  const known = new Map<string, AccessZone | null>();
  const found = new Map<string, AccessZone>();
  for (const destination of custom) {
    const labels = destination.split('/')[0]!.replace(/^\*\./, '').split('.');
    let zone: AccessZone | null = null;
    for (let start = 0; start <= labels.length - 2 && !zone; start++) {
      const name = labels.slice(start).join('.');
      if (!known.has(name)) {
        let zones: unknown;
        try { zones = await call<unknown>('/zones', { query: { name, 'account.id': accountId } }); }
        catch (error) { throw new ApiError(409, 'DEPLOY_ACCESS_ZONE_LOOKUP_FAILED', `Gitflare could not look up the zone of ${destination}: ${error instanceof ApiError ? error.detail : 'Cloudflare refused the request'}.`); }
        const match = Array.isArray(zones) ? zones.find((item) => item && typeof item === 'object' && (item as { name?: unknown }).name === name && zonePattern.test(String((item as { id?: unknown }).id))) as { id: string; name: string } | undefined : undefined;
        known.set(name, match ? { id: match.id, name: match.name } : null);
      }
      zone = known.get(name) ?? null;
    }
    if (!zone) throw new ApiError(409, 'DEPLOY_ACCESS_ZONE_NOT_FOUND', `${destination} is not on a zone of Cloudflare account ${accountId}, so Access cannot protect it with zone-level permissions.`);
    found.set(zone.id, zone);
  }
  if (found.size > 1) throw new ApiError(409, 'DEPLOY_ACCESS_MULTIPLE_ZONES', `This environment serves hostnames on ${[...found.values()].map((zone) => zone.name).join(' and ')}. Gitflare protects one zone per environment; move the other hostnames to their own environment or protect them in Zero Trust.`);
  return [...found.values()][0]!;
}

export async function ensureDeployAccess(call: CloudflareCall, accountId: string, input: { name: string; hostnames: string[]; includes: DeployAccessIncludes; previous?: DeployAccessRecord; zoneId?: string }): Promise<Pick<DeployAccessRecord, 'appId' | 'policyId' | 'created' | 'policyCreated'>> {
  const { name, hostnames, zoneId } = input;
  const previous = input.previous && (input.previous.zoneId ?? null) === (zoneId ?? null) ? input.previous : undefined;
  const base = accessBase({ accountId, ...(zoneId ? { zoneId } : {}) });
  const listed = await call<AccessApp[]>(`${base}/apps`, { query: { per_page: '1000' } });
  const apps = Array.isArray(listed) ? listed : [];
  const existing = (previous ? apps.find((app) => app?.id === previous.appId) : undefined) ?? apps.find((app) => app?.name === name);
  const conflict = apps.find((app) => app !== existing && appDestinations(app).some((uri) => hostnames.includes(uri)));
  if (conflict) {
    const host = appDestinations(conflict).find((uri) => hostnames.includes(uri));
    throw new ApiError(409, 'DEPLOY_ACCESS_CONFLICT', `Cloudflare Access application ${conflict.name ?? 'unnamed'} (${conflict.id ?? 'unknown id'}) already covers ${host}. Gitflare does not change Access applications it did not create; remove that hostname from it in Zero Trust, then try again.`);
  }
  const policy = { name, decision: 'allow', include: includeRules(input.includes) };
  if (zoneId) return ensureZoneAccess(call, base, { name, hostnames, policy, ...(existing ? { existing } : {}), ...(previous ? { previous } : {}) });
  const knownPolicy = existing?.policies?.find((item) => typeof item?.id === 'string' && (item.id === previous?.policyId || item.name === name))?.id;
  let policyId: string | undefined;
  let policyCreated = false;
  if (knownPolicy) {
    const updated = await call(`/accounts/${accountId}/access/policies/${knownPolicy}`, { method: 'PUT', json: policy, allowNotFound: true });
    if (updated !== null) { policyId = knownPolicy; policyCreated = previous?.policyId === knownPolicy && previous.policyCreated; }
  }
  if (!policyId) {
    const created = await call<AccessPolicy>(`/accounts/${accountId}/access/policies`, { method: 'POST', json: policy });
    if (typeof created?.id !== 'string') throw new ApiError(502, 'CLOUDFLARE_INVALID_RESPONSE', 'Cloudflare did not return an Access policy.');
    policyId = created.id;
    policyCreated = true;
  }
  const app = { name, type: 'self_hosted', domain: hostnames[0], destinations: hostnames.map((uri) => ({ type: 'public', uri })), app_launcher_visible: false, session_duration: '24h', policies: [{ id: policyId, precedence: 1 }] };
  if (existing?.id) {
    await call(`/accounts/${accountId}/access/apps/${existing.id}`, { method: 'PUT', json: app });
    return { appId: existing.id, policyId, created: previous?.appId === existing.id && previous.created, policyCreated };
  }
  const created = await call<AccessApp>(`/accounts/${accountId}/access/apps`, { method: 'POST', json: app });
  if (typeof created?.id !== 'string') throw new ApiError(502, 'CLOUDFLARE_INVALID_RESPONSE', 'Cloudflare did not return an Access application.');
  return { appId: created.id, policyId, created: true, policyCreated };
}

async function ensureZoneAccess(call: CloudflareCall, base: string, input: { name: string; hostnames: string[]; policy: Record<string, unknown>; existing?: AccessApp; previous?: DeployAccessRecord }): Promise<Pick<DeployAccessRecord, 'appId' | 'policyId' | 'created' | 'policyCreated'>> {
  const { name, hostnames, existing, previous } = input;
  const app = { name, type: 'self_hosted', domain: hostnames[0], destinations: hostnames.map((uri) => ({ type: 'public', uri })), app_launcher_visible: false, session_duration: '24h' };
  let appId: string;
  let created: boolean;
  if (existing?.id) {
    await call(`${base}/apps/${existing.id}`, { method: 'PUT', json: app });
    appId = existing.id; created = previous?.appId === existing.id && previous.created;
  } else {
    const made = await call<AccessApp>(`${base}/apps`, { method: 'POST', json: app });
    if (typeof made?.id !== 'string') throw new ApiError(502, 'CLOUDFLARE_INVALID_RESPONSE', 'Cloudflare did not return an Access application.');
    appId = made.id; created = true;
  }
  const policies = `${base}/apps/${appId}/policies`;
  const zonePolicy = { ...input.policy, precedence: 1 };
  if (previous?.appId === appId && previous.policyId) {
    const updated = await call(`${policies}/${previous.policyId}`, { method: 'PUT', json: zonePolicy, allowNotFound: true });
    if (updated !== null) return { appId, policyId: previous.policyId, created, policyCreated: previous.policyCreated };
  }
  const listed = await call<AccessPolicy[]>(policies);
  const named = (Array.isArray(listed) ? listed : []).find((item) => item?.name === name && typeof item.id === 'string');
  if (named?.id) { await call(`${policies}/${named.id}`, { method: 'PUT', json: zonePolicy }); return { appId, policyId: named.id, created, policyCreated: created }; }
  const made = await call<AccessPolicy>(policies, { method: 'POST', json: zonePolicy });
  if (typeof made?.id !== 'string') throw new ApiError(502, 'CLOUDFLARE_INVALID_RESPONSE', 'Cloudflare did not return an Access policy.');
  return { appId, policyId: made.id, created, policyCreated: true };
}

export async function removeDeployAccess(call: CloudflareCall, record: DeployAccessRecord): Promise<DeployAccessRemoval> {
  const path = `${accessBase(record)}/apps/${record.appId}`;
  const left = (why: string): DeployAccessRemoval => ({ appId: record.appId, deleted: false, note: `${why} Gitflare stopped managing it and left it in Cloudflare; remove it in Zero Trust if it is no longer needed.` });
  if (!record.created) return left(`Gitflare adopted Access application ${record.appName} (${record.appId}) but did not create it.`);
  const app = await call<AccessApp | null>(path, { allowNotFound: true });
  if (!app) return { appId: record.appId, deleted: false, note: `Access application ${record.appId} no longer exists in Cloudflare.` };
  if (app.id !== record.appId || app.name !== record.appName) return left(`Access application ${record.appId} is now named ${app.name ?? 'unnamed'}, not ${record.appName}.`);
  await call(path, { method: 'DELETE', allowNotFound: true });
  if (record.policyCreated && !record.zoneId) await call(`/accounts/${record.accountId}/access/policies/${record.policyId}`, { method: 'DELETE', allowNotFound: true });
  return { appId: record.appId, deleted: true };
}

function baseView(record: DeployAccessRecord, principal: Principal): Omit<DeployAccessView, 'status'> {
  return { appId: record.appId, hostnames: record.hostnames, includes: record.includes, created: record.created, canChange: canChange(principal), updatedAt: record.updatedAt, updatedBy: record.updatedBy };
}

export function unprotectedView(principal: Principal): DeployAccessView {
  return { status: 'unprotected', hostnames: [], includes: null, created: false, canChange: canChange(principal) };
}

export async function deployAccessView(record: DeployAccessRecord | undefined, target: DeployAccessTarget, principal: Principal, scopes: AccessScopeEnv, client: () => Promise<DeployAccessClient>): Promise<DeployAccessView> {
  if (!record) return unprotectedView(principal);
  const view = baseView(record, principal);
  const error = (reason: string): DeployAccessView => ({ status: 'error', reason, ...view });
  let connection: DeployAccessClient;
  try { connection = await client(); }
  catch (failure) { return error(failure instanceof ApiError ? failure.detail : 'The Cloudflare connection could not be read.'); }
  const scope = accessScopeState(scopes, connection.scopes);
  if (!scope.granted) return error(`${ACCESS_SCOPE_MISSING_MESSAGE}. ${scope.requested ? `The Cloudflare connection was not granted ${scope.missing.join(', ')}; an Owner must reconnect Cloudflare.` : 'This installation turned Cloudflare Access off (CLOUDFLARE_ACCESS_SCOPES is empty).'} Gitflare cannot check the Access application.`);
  if (connection.accountId !== record.accountId) return error(`Access protection is on Cloudflare account ${record.accountId}, but the repository's Cloudflare connection is on ${connection.accountId}. Reconnect Cloudflare to ${record.accountId}.`);
  let app: AccessApp | null;
  let zonePolicies: AccessPolicy[] | null = null;
  try {
    app = await connection.call<AccessApp | null>(`${accessBase(record)}/apps/${record.appId}`, { allowNotFound: true });
    if (app && record.zoneId) zonePolicies = await connection.call<AccessPolicy[] | null>(`${accessBase(record)}/apps/${record.appId}/policies`, { allowNotFound: true });
  }
  catch (failure) { return error(failure instanceof ApiError ? failure.detail : 'Cloudflare Access could not be read.'); }
  if (!app) return error(`Access application ${record.appName} (${record.appId}) no longer exists in Cloudflare. Turn protection on again to recreate it, or remove it.`);
  const destinations = appDestinations(app);
  const unprotected = record.hostnames.filter((host) => !destinations.includes(host));
  if (unprotected.length) return error(`Access application ${record.appId} was changed outside Gitflare and no longer covers ${unprotected.join(', ')}. Update protection to restore it.`);
  if (!((record.zoneId ? zonePolicies : app.policies) ?? []).some((policy) => policy?.id === record.policyId)) return error(`Access application ${record.appId} no longer uses Gitflare's allow policy ${record.policyId}. Update protection to restore it.`);
  const uncovered = [...new Set(target.liveUrls.map(urlHostname).filter((host): host is string => !!host && !record.hostnames.includes(host) && !(record.zoneId && isWorkersDev(host))))];
  if (uncovered.length) return error(`${target.environment} now also serves ${uncovered.join(', ')}, which Access does not cover. Update protection to add ${uncovered.length === 1 ? 'it' : 'them'}.`);
  return { status: 'protected', ...view };
}

export async function manageDeployAccess(input: { principal: Principal; repositoryName: string; key: string; body: Record<string, unknown>; target: DeployAccessTarget; deps: DeployAccessDeps; audit?: (action: string) => Promise<void> }): Promise<DeployAccessResult> {
  const { principal, target, deps } = input;
  const { environment } = target;
  assertDeployAccessOwner(principal);
  if (typeof input.body.enabled !== 'boolean') throw new ApiError(400, 'INVALID_DEPLOY_ACCESS', 'enabled must be true (protect or update) or false (remove protection).');
  const enabled = input.body.enabled;
  const includes = enabled ? parseDeployAccessIncludes(input.body) : null;
  const fingerprint = JSON.stringify(['deploy-access', environment, enabled, includes]);
  const replay = await deps.store.receipt(input.key, fingerprint);
  if (replay) return replay;
  const existing = (await deps.store.records()).find((record) => record.environment === environment);
  const unchanged = `Access protection of ${environment}`;
  if (!enabled) {
    if (!existing) return deps.store.save(input.key, fingerprint, environment, null, { environment, access: unprotectedView(principal), notes: [`${environment} was not protected by Gitflare.`] });
    const connection = await deps.client(environment);
    assertAccessScope(deps.scopes, connection.scopes, unchanged);
    if (connection.accountId !== existing.accountId) throw new ApiError(409, 'CLOUDFLARE_ACCOUNT_MISMATCH', `Access protection of ${environment} is on Cloudflare account ${existing.accountId}, but the repository's Cloudflare connection is on ${connection.accountId}. Reconnect Cloudflare to ${existing.accountId} first.`);
    const removed = await removeDeployAccess(connection.call, existing);
    await input.audit?.(`repository.deploy-access.${environment}.removed`);
    return deps.store.save(input.key, fingerprint, environment, null, { environment, access: unprotectedView(principal), removed, notes: removed.note ? [removed.note] : [] });
  }
  const settings = target.settings;
  if (!settings) throw new ApiError(409, 'DEPLOY_NOT_CONFIGURED', `Choose target Workers for ${environment} in deployment settings before protecting it with Cloudflare Access.`);
  const connection = await deps.client(environment);
  assertAccessScope(deps.scopes, connection.scopes, unchanged);
  if (connection.accountId !== settings.accountId) throw new ApiError(409, 'CLOUDFLARE_ACCOUNT_MISMATCH', `${environment} deploys to Cloudflare account ${settings.accountId}, but the repository's Cloudflare connection is on ${connection.accountId}. Reconnect Cloudflare to ${settings.accountId} first.`);
  const notes: string[] = [];
  const subdomain = await workersSubdomain(connection.call, connection.accountId).catch(() => { notes.push(`Account ${connection.accountId} has no workers.dev subdomain, so no workers.dev hostname was added.`); return null; });
  const detected = await (target.detected?.() ?? Promise.resolve(null)).catch(() => { notes.push('The Wrangler routes of this environment could not be read; only live deployment URLs and workers.dev were protected.'); return null; });
  const workers = settings.targets?.length ? settings.targets.map((item) => item.workerName) : [settings.workerName];
  const hostnames = deployAccessHostnames({ workers, subdomain, liveUrls: target.liveUrls, routes: detected?.routes ?? [], customDomains: detected?.customDomains ?? [] });
  if (!hostnames.length) throw new ApiError(409, 'DEPLOY_ACCESS_NO_HOSTNAMES', `${environment} has no hostnames yet: no live deployment URL, Wrangler route or custom domain, and no workers.dev subdomain. Deploy it or add a route first.`);
  const name = deployAccessAppName(input.repositoryName, environment);
  const zoned = accessMode(deps.scopes) === 'zone';
  const zone = zoned ? await accessZone(connection.call, connection.accountId, hostnames) : null;
  if (zoned && !zone) throw new ApiError(409, 'DEPLOY_ACCESS_ZONE_REQUIRED', `${environment} is served only on workers.dev, which is not on a zone. Gitflare's Cloudflare Access permission is zone-level, so add a route or custom domain on one of your zones first.`);
  const protectedHosts = zone ? hostnames.filter((host) => !isWorkersDev(host)) : hostnames;
  const skipped = hostnames.filter((host) => !protectedHosts.includes(host));
  if (skipped.length) notes.push(`${skipped.join(', ')} ${skipped.length === 1 ? 'is' : 'are'} on workers.dev, not on zone ${zone!.name}, so zone-level Access does not cover ${skipped.length === 1 ? 'it' : 'them'}. Turn off workers_dev for ${environment} or protect ${skipped.length === 1 ? 'it' : 'them'} in Zero Trust.`);
  const ensured = await ensureDeployAccess(connection.call, connection.accountId, { name, hostnames: protectedHosts, includes: includes!, ...(existing ? { previous: existing } : {}), ...(zone ? { zoneId: zone.id } : {}) });
  if (!ensured.created) notes.push(`Gitflare adopted the existing Access application ${name} (${ensured.appId}); removing protection will leave it in Cloudflare.`);
  const record: DeployAccessRecord = { environment, accountId: connection.accountId, appId: ensured.appId, appName: name, policyId: ensured.policyId, created: ensured.created, policyCreated: ensured.policyCreated, ...(zone ? { zoneId: zone.id, zoneName: zone.name } : {}), hostnames: protectedHosts, includes: includes!, updatedAt: new Date().toISOString(), updatedBy: principal.userId };
  await input.audit?.(`repository.deploy-access.${environment}.${existing ? 'updated' : 'enabled'}`);
  return deps.store.save(input.key, fingerprint, environment, record, { environment, access: { status: 'protected', ...baseView(record, principal) }, notes });
}
