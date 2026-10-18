import { ApiError, assertMutationOrigin, readJson, requireIdempotencyKey } from './domain';
import type { Principal } from './security';
import type { SqlStore } from './store';
import type { CloudflareCall } from './cloudflare-deploy';
import { environmentBlock, parseWranglerConfig } from './deploy-detect';
import { orderedEnvironments, PRODUCTION, validEnvironmentName } from './deploy-environments';
import { SECRETS_STORE_READ_SCOPE, SECRETS_STORE_WRITE_SCOPE } from './secrets-scopes';
import { PREVIEW_SECRET_ENVIRONMENT, SECRET_ACTIONS, SECRET_BINDING_PATTERN, SECRET_NAME_PATTERN, SECRET_VALUE_MAX_BYTES, STORE_ID_PATTERN, type SecretAction, type SecretLinkView, type SecretRequirementView, type SecretValidationStatus } from '../shared/secrets';

export { PREVIEW_SECRET_ENVIRONMENT, SECRET_ACTIONS };
export type SecretLink = SecretLinkView;
export type SecretRequirement = Omit<SecretRequirementView, 'linkId'>;
export interface SecretBindingEntry { binding: string; store_id: string; secret_name: string }
export interface SecretReceipt { fingerprint: string; action: SecretAction; result: Record<string, unknown> }
export interface StoreSecret { id: string; name: string; status?: string; scopes: string[]; comment?: string; modified?: string }

export const SECRET_LINKS_MAX = 200;
export const SECRET_CONSUMERS_MAX = 20;
export const SECRET_VALUE_POLICY = 'Values go straight to Cloudflare Secrets Store on the connected account. Gitflare keeps only the reference (store, secret, binding, environment, consumers, rotation and validation metadata) and never stores, logs or returns a value. Coding-agent sandboxes and mission containers never receive secret values or bindings.';
const WORKERS_SCOPE = 'workers';
const workerNamePattern = /^[a-zA-Z0-9_-]{1,63}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const LINK_FIELDS = ['id', 'environment', 'binding', 'accountId', 'storeId', 'secretId', 'secretName', 'previewAllowed', 'consumers', 'origin', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt', 'rotatedAt', 'rotatedBy', 'rotationCount', 'validation'] as const;

export function referenceOnly(link: SecretLink): SecretLink {
  const picked = Object.fromEntries(LINK_FIELDS.filter((field) => link[field] !== undefined).map((field) => [field, link[field]])) as unknown as SecretLink;
  const { status, checkedAt, detail } = link.validation;
  return { ...picked, consumers: [...link.consumers], validation: { status, checkedAt, ...(detail ? { detail: detail.slice(0, 300) } : {}) } };
}

const linkKey = (environment: string, binding: string) => `secret-link:${environment}:${binding}`;

export class SecretLinkBook {
  constructor(private readonly store: SqlStore) {}

  links(): SecretLink[] { return this.store.list<SecretLink>('secret-link:'); }

  receipt(key: string): SecretReceipt | null { return this.store.get<SecretReceipt>(`secret-request:${key}`) ?? null; }

  save(link: SecretLink, receipt?: { key: string; value: SecretReceipt }): SecretLink {
    const clean = referenceOnly(link);
    const existing = this.store.get<SecretLink>(linkKey(clean.environment, clean.binding));
    if (!existing && this.links().length >= SECRET_LINKS_MAX) throw new ApiError(409, 'SECRET_LINKS_LIMIT', `A repository can link at most ${SECRET_LINKS_MAX} secrets.`);
    this.store.put(linkKey(clean.environment, clean.binding), clean);
    if (receipt) this.store.put(`secret-request:${receipt.key}`, receipt.value);
    return clean;
  }

  remove(environment: string, binding: string, receipt?: { key: string; value: SecretReceipt }): SecretLink | null {
    const existing = this.store.get<SecretLink>(linkKey(environment, binding)) ?? null;
    if (existing) this.store.delete(linkKey(environment, binding));
    if (receipt) this.store.put(`secret-request:${receipt.key}`, receipt.value);
    return existing;
  }

  record(key: string, value: SecretReceipt): void { this.store.put(`secret-request:${key}`, value); }
}

function requirementsFromBlock(block: Record<string, unknown>, environment: string, configPath: string, workerName: string): SecretRequirement[] {
  const found: SecretRequirement[] = [];
  const declared = Array.isArray(block.secrets_store_secrets) ? block.secrets_store_secrets : [];
  for (const item of declared) {
    if (!isRecord(item) || typeof item.binding !== 'string' || !SECRET_BINDING_PATTERN.test(item.binding)) continue;
    const storeId = typeof item.store_id === 'string' ? item.store_id : undefined;
    const secretName = typeof item.secret_name === 'string' ? item.secret_name : undefined;
    found.push({ environment, binding: item.binding, source: 'secrets_store_secrets', configPath, workerName, ...(storeId || secretName ? { declared: { ...(storeId ? { storeId } : {}), ...(secretName ? { secretName } : {}) } } : {}) });
  }
  const required = isRecord(block.secrets) && Array.isArray(block.secrets.required) ? block.secrets.required : [];
  for (const name of required) {
    if (typeof name !== 'string' || !SECRET_BINDING_PATTERN.test(name) || found.some((item) => item.binding === name)) continue;
    found.push({ environment, binding: name, source: 'secrets.required', configPath, workerName });
  }
  return found;
}

export function configSecretRequirements(config: Record<string, unknown>, environment: string, configPath: string, workerName: string): SecretRequirement[] {
  const block = environment === PRODUCTION ? config : environmentBlock(config, environment);
  return block ? requirementsFromBlock(block, environment, configPath, workerName) : [];
}

export function deploySecretRequirements(deploy: Record<string, unknown>, environment: string, configPath: string, workerName: string): SecretRequirement[] {
  return requirementsFromBlock(deploy, environment, configPath, workerName);
}

export interface RequirementTarget { environment: string; workerName: string; configPath: string }

export async function repositorySecretRequirements(targets: RequirementTarget[], read: (path: string) => Promise<string | null>): Promise<{ requirements: SecretRequirement[]; errors: string[] }> {
  const requirements: SecretRequirement[] = [];
  const errors: string[] = [];
  const files = new Map<string, Promise<string | null>>();
  for (const target of targets) {
    if (!target.configPath) continue;
    if (!files.has(target.configPath)) files.set(target.configPath, read(target.configPath).catch(() => null));
    const content = await files.get(target.configPath)!;
    if (content === null) { errors.push(`${target.configPath} could not be read at the default branch head.`); continue; }
    try { requirements.push(...configSecretRequirements(parseWranglerConfig(target.configPath, content), target.environment, target.configPath, target.workerName)); }
    catch { errors.push(`${target.configPath} is not a valid Wrangler configuration.`); }
  }
  return { requirements, errors: [...new Set(errors)] };
}

export function linkFor(links: SecretLink[], environment: string, binding: string, workerName?: string): SecretLink | undefined {
  return links.find((link) => link.environment === environment && link.binding === binding && (!link.consumers.length || (workerName !== undefined && link.consumers.includes(workerName))));
}

export function unmetRequirements(requirements: SecretRequirement[], links: SecretLink[]): SecretRequirement[] {
  return requirements.filter((requirement) => !linkFor(links, requirement.environment, requirement.binding, requirement.workerName));
}

export function missingSecretsReason(environment: string, missing: SecretRequirement[]): string | null {
  const own = missing.filter((item) => item.environment === environment);
  if (!own.length) return null;
  const names = [...new Set(own.map((item) => item.binding))];
  return `${environment} needs ${names.length === 1 ? 'secret' : 'secrets'} ${names.join(', ')} (declared in ${[...new Set(own.map((item) => item.configPath))].join(', ')}). Link ${names.length === 1 ? 'it' : 'them'} to a Secrets Store secret for ${environment} in Settings → Secrets before deploying.`;
}

export function secretBindingEntries(links: SecretLink[], environment: string, workerName: string): SecretBindingEntry[] {
  return links
    .filter((link) => link.environment === environment && (!link.consumers.length || link.consumers.includes(workerName)))
    .map((link) => ({ binding: link.binding, store_id: link.storeId, secret_name: link.secretName }));
}

export function withSecretBindings(deploy: Record<string, unknown>, entries: SecretBindingEntry[]): Record<string, unknown> {
  if (!entries.length) return deploy;
  const linked = new Set(entries.map((entry) => entry.binding));
  const declared = (Array.isArray(deploy.secrets_store_secrets) ? deploy.secrets_store_secrets : []).filter((item) => !(isRecord(item) && typeof item.binding === 'string' && linked.has(item.binding)));
  return { ...deploy, secrets_store_secrets: [...declared, ...entries] };
}

export function secretMetadataBindings(entries: SecretBindingEntry[]): Record<string, unknown>[] {
  return entries.map((entry) => ({ name: entry.binding, type: 'secrets_store_secret', store_id: entry.store_id, secret_name: entry.secret_name }));
}

export function assertSecretsAccount(links: SecretLink[], accountId: string): void {
  const foreign = links.filter((link) => link.accountId !== accountId);
  if (foreign.length) throw new ApiError(409, 'SECRET_ACCOUNT_MISMATCH', `${foreign.map((link) => link.binding).join(', ')} ${foreign.length === 1 ? 'is' : 'are'} linked on Cloudflare account ${foreign[0].accountId}, but this deploy runs on ${accountId}. Link secrets from the deploy account in Settings → Secrets.`);
}

export interface PreviewSecretPlan { env: Record<string, { type: 'secrets_store_secret'; store_id: string; secret_name: string }>; notes: string[] }

export function previewSecretBindings(links: SecretLink[], host: { kind: 'connection' | 'installation'; accountId: string } | null, scopes: string[]): PreviewSecretPlan {
  const allowed = links.filter((link) => link.environment === PREVIEW_SECRET_ENVIRONMENT && link.previewAllowed === true);
  const env: PreviewSecretPlan['env'] = {};
  if (!allowed.length) return { env, notes: [] };
  if (!host || host.kind !== 'connection') return { env, notes: [`Preview secrets ${allowed.map((link) => link.binding).join(', ')} are not bound: this preview runs on the installation’s previews Worker, not on the repository’s Cloudflare account.`] };
  if (!scopes.includes(SECRETS_STORE_WRITE_SCOPE)) return { env, notes: [`Preview secrets ${allowed.map((link) => link.binding).join(', ')} are not bound: the Cloudflare connection was not granted ${SECRETS_STORE_WRITE_SCOPE}.`] };
  const notes: string[] = [];
  for (const link of allowed) {
    if (link.accountId !== host.accountId) { notes.push(`Preview secret ${link.binding} is linked on account ${link.accountId}, not the preview account ${host.accountId}, and is not bound.`); continue; }
    env[link.binding] = { type: 'secrets_store_secret', store_id: link.storeId, secret_name: link.secretName };
    notes.push(`Secret ${link.binding} (secrets_store_secret) → ${link.secretName}, allowed for previews.`);
  }
  return { env, notes };
}

function storeSecret(value: unknown): StoreSecret | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') return null;
  return { id: value.id, name: value.name.slice(0, 255), scopes: Array.isArray(value.scopes) ? value.scopes.filter((scope): scope is string => typeof scope === 'string') : [], ...(typeof value.status === 'string' ? { status: value.status } : {}), ...(typeof value.comment === 'string' ? { comment: value.comment.slice(0, 300) } : {}), ...(typeof value.modified === 'string' ? { modified: value.modified } : {}) };
}

async function pages<T>(call: CloudflareCall, path: string, query: Record<string, string> = {}): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const envelope = await call<{ result?: unknown; result_info?: { total_pages?: number } }>(path, { query: { ...query, page: String(page), per_page: '100' }, envelope: true });
    if (!Array.isArray(envelope?.result)) throw new ApiError(502, 'CLOUDFLARE_INVALID_RESPONSE', 'Cloudflare did not return a Secrets Store list.');
    items.push(...envelope.result as T[]);
    if (!envelope.result.length || (envelope.result_info?.total_pages ?? 1) <= page) break;
  }
  return items;
}

const storesPath = (accountId: string) => `/accounts/${accountId}/secrets_store/stores`;

export async function listSecretStores(call: CloudflareCall, accountId: string): Promise<{ id: string; name: string }[]> {
  return (await pages<unknown>(call, storesPath(accountId))).flatMap((item) => isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string' ? [{ id: item.id, name: item.name.slice(0, 200) }] : []);
}

export async function listStoreSecrets(call: CloudflareCall, accountId: string, storeId: string): Promise<StoreSecret[]> {
  return (await pages<unknown>(call, `${storesPath(accountId)}/${storeId}/secrets`)).map(storeSecret).filter((item): item is StoreSecret => !!item);
}

export async function findStoreSecret(call: CloudflareCall, accountId: string, storeId: string, reference: { secretId?: string; secretName?: string }): Promise<StoreSecret | null> {
  if (reference.secretId) return storeSecret(await call<unknown>(`${storesPath(accountId)}/${storeId}/secrets/${reference.secretId}`, { allowNotFound: true }));
  const matches = await pages<unknown>(call, `${storesPath(accountId)}/${storeId}/secrets`, { search: reference.secretName! });
  return matches.map(storeSecret).find((item) => item?.name === reference.secretName) ?? null;
}

function valueCallFailure(error: unknown, operation: string): never {
  const status = error instanceof ApiError ? error.status : 502;
  const code = error instanceof ApiError && error.code === 'CLOUDFLARE_PERMISSION_DENIED' ? 'CLOUDFLARE_PERMISSION_DENIED' : status === 409 ? 'SECRET_ALREADY_EXISTS' : status === 404 ? 'SECRET_NOT_FOUND' : 'SECRETS_STORE_REJECTED';
  const message = code === 'CLOUDFLARE_PERMISSION_DENIED' ? `Cloudflare refused to ${operation}. The connection needs ${SECRETS_STORE_WRITE_SCOPE} and the account role must allow Secrets Store changes.` : code === 'SECRET_ALREADY_EXISTS' ? 'A secret with this name already exists in the store. Link it, or rotate it from its link.' : code === 'SECRET_NOT_FOUND' ? 'The secret or store no longer exists in Cloudflare.' : `Cloudflare could not ${operation}. Nothing was linked; try again.`;
  throw new ApiError(status === 403 ? 403 : status === 409 ? 409 : status === 404 ? 404 : 502, code, message);
}

export async function createStoreSecret(call: CloudflareCall, accountId: string, storeId: string, name: string, value: string, comment?: string): Promise<StoreSecret> {
  let result: unknown;
  try { result = await call<unknown>(`${storesPath(accountId)}/${storeId}/secrets`, { method: 'POST', json: [{ name, value, scopes: [WORKERS_SCOPE], ...(comment ? { comment } : {}) }] }); }
  catch (error) { valueCallFailure(error, 'create the secret'); }
  const created = storeSecret(Array.isArray(result) ? result[0] : result);
  if (!created) throw new ApiError(502, 'CLOUDFLARE_INVALID_RESPONSE', 'Cloudflare did not return the created secret.');
  return created;
}

export async function rotateStoreSecret(call: CloudflareCall, accountId: string, storeId: string, secretId: string, value: string): Promise<void> {
  try { await call<unknown>(`${storesPath(accountId)}/${storeId}/secrets/${secretId}`, { method: 'PATCH', json: { value } }); }
  catch (error) { valueCallFailure(error, 'rotate the secret'); }
}

export async function createSecretStore(call: CloudflareCall, accountId: string, name: string): Promise<{ id: string; name: string }> {
  const result = await call<unknown>(storesPath(accountId), { method: 'POST', json: { name } });
  const store = Array.isArray(result) ? result[0] : result;
  if (!isRecord(store) || typeof store.id !== 'string') throw new ApiError(502, 'CLOUDFLARE_INVALID_RESPONSE', 'Cloudflare did not return the created store.');
  return { id: store.id, name: typeof store.name === 'string' ? store.name : name };
}

export type SecretsConnection = { connected: true; accountId: string; scopes: string[]; source: 'repository' | 'workspace'; call: CloudflareCall } | { connected: false; reason: string };

export interface SecretLinkStore {
  links(): Promise<SecretLink[]>;
  receipt(key: string): Promise<SecretReceipt | null>;
  save(link: SecretLink, receipt?: { key: string; value: SecretReceipt }): Promise<SecretLink>;
  remove(environment: string, binding: string, receipt?: { key: string; value: SecretReceipt }): Promise<SecretLink | null>;
  record(key: string, value: SecretReceipt): Promise<void>;
}

export interface SecretsApiContext {
  repositoryId: string;
  principal: Principal;
  store: SecretLinkStore;
  authorizeRead(): Promise<void>;
  canManage(): Promise<boolean>;
  environments(): Promise<string[]>;
  requirements(): Promise<{ requirements: SecretRequirement[]; errors: string[] }>;
  connection(): Promise<SecretsConnection>;
  requestedScopes: string[];
  audit(action: string): Promise<void>;
}

function connectionView(connection: SecretsConnection, requestedScopes: string[]) {
  if (!connection.connected) return { connected: false, reason: connection.reason, requiredScopes: requestedScopes };
  const missing = requestedScopes.filter((scope) => !connection.scopes.includes(scope));
  return { connected: true, source: connection.source, accountId: connection.accountId, requiredScopes: requestedScopes, missingScopes: missing, canRead: connection.scopes.includes(SECRETS_STORE_READ_SCOPE) || connection.scopes.includes(SECRETS_STORE_WRITE_SCOPE), canWrite: connection.scopes.includes(SECRETS_STORE_WRITE_SCOPE) };
}

async function snapshot(context: SecretsApiContext) {
  const [links, environments, required, canManage, connection] = await Promise.all([
    context.store.links(), context.environments(),
    context.requirements().catch(() => ({ requirements: [] as SecretRequirement[], errors: ['The Wrangler configuration could not be read.'] })),
    context.canManage(), context.connection().catch((): SecretsConnection => ({ connected: false, reason: 'The Cloudflare connection could not be read.' })),
  ]);
  const names = orderedEnvironments([...environments, ...links.map((link) => link.environment).filter((name) => name !== PREVIEW_SECRET_ENVIRONMENT), ...required.requirements.map((item) => item.environment)]).filter((name) => name !== PREVIEW_SECRET_ENVIRONMENT);
  const requirements: SecretRequirementView[] = required.requirements.map((item) => ({ ...item, linkId: linkFor(links, item.environment, item.binding, item.workerName)?.id ?? null }));
  const missing = Object.fromEntries(names.map((name) => [name, [...new Set(requirements.filter((item) => item.environment === name && !item.linkId).map((item) => item.binding))]]));
  return {
    repositoryId: context.repositoryId, canManage,
    environments: [...names, PREVIEW_SECRET_ENVIRONMENT],
    links: links.map(referenceOnly),
    requirements, missing, requirementErrors: required.errors,
    connection: connectionView(connection, context.requestedScopes),
    valuePolicy: SECRET_VALUE_POLICY,
  };
}

function environmentInput(value: unknown): string {
  if (!validEnvironmentName(value)) throw new ApiError(400, 'INVALID_ENVIRONMENT', 'environment must be production, staging, preview or another lowercase environment name.');
  return value;
}

function bindingInput(value: unknown): string {
  if (typeof value !== 'string' || !SECRET_BINDING_PATTERN.test(value)) throw new ApiError(400, 'INVALID_BINDING', 'binding must be a Worker binding name: letters, digits and underscores, starting with a letter or underscore, at most 64 characters.');
  return value;
}

function storeInput(value: unknown): string {
  if (typeof value !== 'string' || !STORE_ID_PATTERN.test(value)) throw new ApiError(400, 'INVALID_STORE', 'storeId must be a 32-character Secrets Store ID.');
  return value;
}

function secretNameInput(value: unknown): string {
  if (typeof value !== 'string' || !SECRET_NAME_PATTERN.test(value)) throw new ApiError(400, 'INVALID_SECRET_NAME', 'secretName must be 1 to 255 letters, digits, dashes or underscores.');
  return value;
}

function valueInput(value: unknown): string {
  if (typeof value !== 'string' || !value.length) throw new ApiError(400, 'SECRET_VALUE_REQUIRED', 'Enter the secret value.');
  if (new TextEncoder().encode(value).length > SECRET_VALUE_MAX_BYTES) throw new ApiError(400, 'SECRET_VALUE_TOO_LARGE', `A secret value is at most ${SECRET_VALUE_MAX_BYTES} bytes.`);
  return value;
}

function consumersInput(value: unknown, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length > SECRET_CONSUMERS_MAX || !value.every((item) => typeof item === 'string' && workerNamePattern.test(item))) throw new ApiError(400, 'INVALID_CONSUMERS', `consumers must list up to ${SECRET_CONSUMERS_MAX} Worker names; empty binds every Worker the environment deploys.`);
  return [...new Set(value as string[])];
}

function previewInput(value: unknown, environment: string, fallback = false): boolean {
  if (value === undefined) return environment === PREVIEW_SECRET_ENVIRONMENT ? fallback : false;
  if (typeof value !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', 'previewAllowed must be true or false.');
  if (value && environment !== PREVIEW_SECRET_ENVIRONMENT) throw new ApiError(400, 'PREVIEW_ENVIRONMENT_ONLY', `Only secrets linked to the ${PREVIEW_SECRET_ENVIRONMENT} environment can be allowed in Worker Previews. Link a separate test secret there.`);
  return value;
}

function commentInput(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 300 || /[\u0000-\u001f]/.test(value)) throw new ApiError(400, 'INVALID_INPUT', 'comment must be a single line of at most 300 characters.');
  return value;
}

function requireConnection(connection: SecretsConnection, scope: string): Extract<SecretsConnection, { connected: true }> {
  if (!connection.connected) throw new ApiError(409, 'CLOUDFLARE_NOT_CONNECTED', connection.reason);
  const allowed = scope === SECRETS_STORE_READ_SCOPE ? connection.scopes.includes(SECRETS_STORE_READ_SCOPE) || connection.scopes.includes(SECRETS_STORE_WRITE_SCOPE) : connection.scopes.includes(scope);
  if (!allowed) throw new ApiError(403, 'CLOUDFLARE_SCOPE_MISSING', `The ${connection.source} Cloudflare connection was not granted ${scope}. An Owner must reconnect Cloudflare with Secrets Store access turned on (Settings → Secrets → Connect Secrets Store).`);
  return connection;
}

function validation(secret: StoreSecret | null, now: string): SecretLink['validation'] {
  const status: SecretValidationStatus = !secret ? 'not_found' : secret.scopes.includes(WORKERS_SCOPE) ? 'valid' : 'not_workers_scoped';
  return { status, checkedAt: now, ...(status === 'not_found' ? { detail: 'The secret no longer exists in the store.' } : status === 'not_workers_scoped' ? { detail: 'The secret is not scoped to Workers, so Worker bindings are rejected.' } : {}) };
}

async function manage(context: SecretsApiContext): Promise<void> {
  if (context.principal.credentialId || !await context.canManage()) throw new ApiError(403, 'SECRET_MANAGER_REQUIRED', 'Only a workspace Owner, or a member granted secret deploy access to this repository, can change its secrets.');
}

export async function repositorySecretsApi(request: Request, context: SecretsApiContext): Promise<Response> {
  await context.authorizeRead();
  const url = new URL(request.url);
  const headers = { 'Cache-Control': 'no-store' };
  if (request.method === 'GET' && url.pathname.endsWith('/secrets/catalog')) {
    await manage(context);
    const connection = requireConnection(await context.connection(), SECRETS_STORE_READ_SCOPE);
    const storeId = url.searchParams.get('store_id');
    const stores = await listSecretStores(connection.call, connection.accountId);
    const secrets = storeId ? await listStoreSecrets(connection.call, connection.accountId, storeInput(storeId)) : undefined;
    return Response.json({ accountId: connection.accountId, stores, ...(secrets ? { storeId, secrets } : {}) }, { headers });
  }
  if (request.method === 'GET') return Response.json(await snapshot(context), { headers });
  if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST.');
  assertMutationOrigin(request);
  const key = requireIdempotencyKey(request);
  const body = await readJson(request, SECRET_VALUE_MAX_BYTES * 2);
  const action = body.action;
  if (!SECRET_ACTIONS.includes(action as SecretAction)) throw new ApiError(400, 'INVALID_SECRET_ACTION', `action must be one of ${SECRET_ACTIONS.join(', ')}.`);
  await manage(context);
  const value = action === 'create' || action === 'rotate' ? valueInput(body.value) : undefined;
  delete body.value;
  const fingerprint = JSON.stringify([action, body.environment, body.binding, body.storeId, body.secretId, body.secretName, body.previewAllowed, body.consumers, body.comment, body.name, value !== undefined]);
  const previous = await context.store.receipt(key);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was used for a different secret request.');
    return Response.json({ ...previous.result, replayed: true }, { headers });
  }
  const now = new Date().toISOString();
  const receipt = (result: Record<string, unknown>) => ({ key, value: { fingerprint, action: action as SecretAction, result } });
  const userId = context.principal.userId;

  if (action === 'create-store') {
    const name = secretNameInput(body.name);
    const connection = requireConnection(await context.connection(), SECRETS_STORE_WRITE_SCOPE);
    const store = await createSecretStore(connection.call, connection.accountId, name);
    await context.audit(`repository.secret-store.create.${store.id}`);
    const result = { store };
    await context.store.record(key, receipt(result).value);
    return Response.json(result, { headers });
  }

  const environment = environmentInput(body.environment);
  const binding = bindingInput(body.binding);
  const links = await context.store.links();
  const existing = links.find((link) => link.environment === environment && link.binding === binding);

  if (action === 'unlink') {
    if (!existing) throw new ApiError(404, 'SECRET_LINK_NOT_FOUND', `No secret is linked to ${binding} in ${environment}.`);
    await context.store.remove(environment, binding, receipt({ unlinked: { environment, binding } }));
    await context.audit(`repository.secret.unlink.${environment}.${binding}`);
    return Response.json({ unlinked: { environment, binding }, links: (await context.store.links()).map(referenceOnly) }, { headers });
  }

  if (action === 'update') {
    if (!existing) throw new ApiError(404, 'SECRET_LINK_NOT_FOUND', `No secret is linked to ${binding} in ${environment}.`);
    const next: SecretLink = { ...existing, previewAllowed: previewInput(body.previewAllowed, environment, existing.previewAllowed), consumers: consumersInput(body.consumers, existing.consumers), updatedBy: userId, updatedAt: now };
    const saved = await context.store.save(next);
    await context.store.record(key, receipt({ link: saved }).value);
    await context.audit(`repository.secret.update.${environment}.${binding}${saved.previewAllowed ? '.preview-allowed' : ''}`);
    return Response.json({ link: saved }, { headers });
  }

  if (action === 'validate' || action === 'rotate') {
    if (!existing) throw new ApiError(404, 'SECRET_LINK_NOT_FOUND', `No secret is linked to ${binding} in ${environment}.`);
    const connection = requireConnection(await context.connection(), action === 'rotate' ? SECRETS_STORE_WRITE_SCOPE : SECRETS_STORE_READ_SCOPE);
    if (connection.accountId !== existing.accountId) throw new ApiError(409, 'SECRET_ACCOUNT_MISMATCH', `${binding} is linked on Cloudflare account ${existing.accountId}, but the ${connection.source} connection is on ${connection.accountId}.`);
    if (action === 'rotate') await rotateStoreSecret(connection.call, connection.accountId, existing.storeId, existing.secretId, value!);
    const checked = validation(await findStoreSecret(connection.call, connection.accountId, existing.storeId, { secretId: existing.secretId }).catch(() => null), now);
    const next: SecretLink = { ...existing, validation: checked, updatedBy: userId, updatedAt: now, ...(action === 'rotate' ? { rotatedAt: now, rotatedBy: userId, rotationCount: existing.rotationCount + 1 } : {}) };
    const saved = await context.store.save(next, receipt({ link: referenceOnly(next) }));
    await context.audit(`repository.secret.${action}.${environment}.${binding}`);
    return Response.json({ link: saved }, { headers });
  }

  const storeId = storeInput(body.storeId);
  const previewAllowed = previewInput(body.previewAllowed, environment, false);
  const consumers = consumersInput(body.consumers);
  let secret: StoreSecret;
  let connection: Extract<SecretsConnection, { connected: true }>;
  if (action === 'create') {
    const name = secretNameInput(body.secretName);
    connection = requireConnection(await context.connection(), SECRETS_STORE_WRITE_SCOPE);
    secret = await createStoreSecret(connection.call, connection.accountId, storeId, name, value!, commentInput(body.comment));
  } else {
    connection = requireConnection(await context.connection(), SECRETS_STORE_READ_SCOPE);
    const secretId = body.secretId === undefined ? undefined : typeof body.secretId === 'string' && /^[a-f0-9]{32}$/.test(body.secretId) ? body.secretId : (() => { throw new ApiError(400, 'INVALID_SECRET', 'secretId must be a 32-character Secrets Store secret ID.'); })();
    const secretName = secretId ? undefined : secretNameInput(body.secretName);
    const found = await findStoreSecret(connection.call, connection.accountId, storeId, { ...(secretId ? { secretId } : {}), ...(secretName ? { secretName } : {}) });
    if (!found) throw new ApiError(404, 'SECRET_NOT_FOUND', `No secret ${secretId ?? secretName} exists in store ${storeId}.`);
    if (!found.scopes.includes(WORKERS_SCOPE)) throw new ApiError(409, 'SECRET_NOT_WORKERS_SCOPED', `${found.name} is not scoped to Workers. Add the workers scope to the secret in Cloudflare, then link it.`);
    secret = found;
  }
  const link: SecretLink = {
    id: existing?.id ?? crypto.randomUUID(), environment, binding, accountId: connection.accountId, storeId, secretId: secret.id, secretName: secret.name,
    previewAllowed, consumers, origin: action === 'create' ? 'created' : 'linked',
    createdBy: existing?.createdBy ?? userId, createdAt: existing?.createdAt ?? now, updatedBy: userId, updatedAt: now,
    rotationCount: existing?.rotationCount ?? 0, ...(existing?.rotatedAt ? { rotatedAt: existing.rotatedAt, rotatedBy: existing.rotatedBy } : {}),
    validation: validation(secret, now),
  };
  const saved = await context.store.save(link, receipt({ link: referenceOnly(link) }));
  await context.audit(`repository.secret.${action}.${environment}.${binding}${existing ? '.replaced' : ''}`);
  return Response.json({ link: saved }, { headers });
}
