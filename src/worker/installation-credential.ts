import { ApiError, assertMutationOrigin, readJson, requireString } from './domain';
import type { AppEnv } from './env';
import { decryptAuth, encryptAuth } from './mfa';
import { cloudflareDeployAccess } from './cloudflare';
import type { CloudflareDeployAccess } from './cloudflare-deploy';
import { WORKERS_SCRIPTS_EDIT_SCOPE } from './preview-host';
import { securityClient, type InstallationConnectionRecord, type InstallationCredentialRecord, type Principal } from './security';
import { workerPreviewsConfig, type Fetcher, type WorkerPreviewsConfig } from './worker-previews';

const API_ORIGIN = 'https://api.cloudflare.com/client/v4';
const CONTEXT = 'installation-cloudflare-credential';
const WORKER_NOT_FOUND = [10007, 10090];
const DEFAULT_WORKER_NAME = 'gitflare-previews';
export const WORKERS_PERMISSION = 'workers_scripts:edit';
export const D1_PERMISSION = 'd1:edit';
const PERMISSION_LABELS: Record<string, string> = { [WORKERS_PERMISSION]: 'Workers Scripts: Edit', [D1_PERMISSION]: 'D1: Edit' };
export const D1_WRITE_SCOPE = 'd1.write';
export const INSTALLATION_CONNECTION_SCOPES = [WORKERS_SCRIPTS_EDIT_SCOPE, D1_WRITE_SCOPE];
const SCOPE_LABELS: Record<string, string> = { [WORKERS_SCRIPTS_EDIT_SCOPE]: 'Workers Scripts: Edit (workers-scripts.edit)', [D1_WRITE_SCOPE]: 'D1: Write (d1.write)' };

type Account = { id: string; name: string };
type Outcome = { ok: boolean; status: number; codes: number[]; messages: string[]; result: unknown; call: string };
export type InstallationCredentialSource = 'connection' | 'installation' | 'environment' | 'none';
export type InstallationTokenSource = Exclude<InstallationCredentialSource, 'connection'>;
export interface ConnectionProblem { code: string; message: string }
export interface InstallationConnectionSummary { workspaceId: string; accountId: string; accountName?: string; workerName: string; scopes: string[]; setBy: string }
export interface InstallationCredentialStatus {
  manageable: boolean;
  edition: 'hosted' | 'self-hosted';
  oauthAvailable: boolean;
  source: InstallationCredentialSource;
  state: 'configured' | 'missing_permission' | 'unavailable' | 'missing';
  problem?: ConnectionProblem;
  connection?: InstallationConnectionSummary;
  tokenSource?: InstallationTokenSource;
  accountId?: string;
  workerName?: string;
  permissions?: string[];
  missing?: { key: string; label: string }[];
  verifiedAt?: string;
  tokenPageUrl?: string;
}
export type SetCredentialResult = { stored: true; createdWorker: boolean; status: InstallationCredentialStatus } | { stored: false; accountSelectionRequired: true; accounts: Account[] };
export type UseConnectionResult = { stored: true; createdWorker: boolean; status: InstallationCredentialStatus };

function security(env: AppEnv) { return securityClient(env); }

export function installationOAuthAvailable(env: AppEnv): boolean {
  return env.EDITION !== 'self-hosted' && !!env.CLOUDFLARE_CLIENT_ID;
}

export function previewsTokenPageUrl(workerName: string, accountId?: string): string {
  const url = new URL('https://dash.cloudflare.com/profile/api-tokens');
  url.searchParams.set('permissionGroupKeys', JSON.stringify([{ key: 'workers_scripts', type: 'edit' }, { key: 'd1', type: 'edit' }]));
  url.searchParams.set('name', workerName);
  if (accountId) url.searchParams.set('accountId', accountId);
  return url.toString();
}

function configuredWorkerName(env: AppEnv): string {
  const name = env.PREVIEWS_WORKER_NAME?.trim() || DEFAULT_WORKER_NAME;
  if (!/^[a-z0-9][a-z0-9-]{0,52}$/.test(name)) throw new ApiError(503, 'PREVIEWS_MISCONFIGURED', 'PREVIEWS_WORKER_NAME is invalid.');
  return name;
}

function configuredAccountId(env: AppEnv): string | undefined {
  const id = env.PREVIEWS_ACCOUNT_ID?.trim();
  if (id && !/^[a-f0-9]{32}$/.test(id)) throw new ApiError(503, 'PREVIEWS_MISCONFIGURED', 'PREVIEWS_ACCOUNT_ID is invalid.');
  return id || undefined;
}

async function cloudflare(token: string, path: string, fetcher: Fetcher, init: { method?: string; json?: unknown } = {}): Promise<Outcome> {
  let response: Response;
  try {
    response = await fetcher(new Request(`${API_ORIGIN}${path}`, { method: init.method ?? 'GET', headers: { Authorization: `Bearer ${token}`, ...(init.json === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: init.json === undefined ? undefined : JSON.stringify(init.json), redirect: 'manual', signal: AbortSignal.timeout(15_000) }));
  } catch { throw new ApiError(502, 'CLOUDFLARE_UNAVAILABLE', 'Cloudflare could not be reached. Try again.'); }
  const envelope = await response.json().catch(() => ({})) as { success?: boolean; errors?: { code?: number; message?: unknown }[]; result?: unknown };
  const errors = envelope.errors ?? [];
  return { ok: response.ok && envelope.success !== false, status: response.status, codes: errors.map((error) => Number(error.code)).filter(Number.isFinite), messages: errors.map((error) => typeof error.message === 'string' ? error.message.split(token).join('[token]').slice(0, 160) : '').filter(Boolean), result: envelope.result, call: `${init.method ?? 'GET'} ${path.split('?')[0]}` };
}

export function describeRefusal(outcome: Pick<Outcome, 'call' | 'status' | 'codes' | 'messages'>): string {
  const detail = outcome.codes.map((code, index) => outcome.messages[index] ? `${code} ${outcome.messages[index]}` : String(code)).join('; ');
  return `${outcome.call} returned HTTP ${outcome.status}${detail ? ` (${detail})` : ''}`;
}

const denied = (outcome: Outcome) => outcome.status === 401 || outcome.status === 403;

function accountList(result: unknown): Account[] {
  return (Array.isArray(result) ? result : []).filter((item) => item && typeof item.id === 'string' && /^[a-f0-9]{32}$/.test(item.id)).map((item) => ({ id: item.id as string, name: typeof item.name === 'string' ? item.name.slice(0, 200) : item.id as string }));
}

function activeToken(outcome: Outcome): boolean {
  return outcome.ok && (outcome.result as { status?: unknown } | undefined)?.status === 'active';
}

export interface Refusals { list: (outcome: Outcome) => ApiError; create: (outcome: Outcome) => ApiError }

const createByHand = (workerName: string) => `Deploy a Worker named ${workerName} once with Wrangler (workers_dev and preview_urls on) or create it in the Cloudflare dashboard, then try again.`;

async function ensurePreviewsWorker(token: string, accountId: string, workerName: string, fetcher: Fetcher, refused: Refusals): Promise<boolean> {
  const workerPath = `/accounts/${accountId}/workers/workers`;
  const previews = await cloudflare(token, `${workerPath}/${workerName}/previews`, fetcher);
  if (previews.ok) return false;
  if (denied(previews)) throw refused.list(previews);
  if (!(previews.status === 404 || WORKER_NOT_FOUND.some((code) => previews.codes.includes(code)))) throw new ApiError(502, 'CLOUDFLARE_VERIFY_FAILED', `Cloudflare could not list previews for ${workerName}: ${describeRefusal(previews)}. Try again.`);
  const created = await cloudflare(token, workerPath, fetcher, { method: 'POST', json: { name: workerName, subdomain: { enabled: true, previews_enabled: true } } });
  if (!created.ok) {
    if (denied(created)) throw refused.create(created);
    throw new ApiError(502, 'CLOUDFLARE_VERIFY_FAILED', `The previews Worker ${workerName} does not exist and Cloudflare could not create it: ${describeRefusal(created)}. ${createByHand(workerName)}`);
  }
  return true;
}

export interface VerifiedCredential { accountId: string; workerName: string; permissions: string[]; missing: string[]; createdWorker: boolean }

export async function verifyPreviewsToken(token: string, input: { accountId?: string; workerName: string }, fetcher: Fetcher): Promise<VerifiedCredential | { accountSelectionRequired: true; accounts: Account[] }> {
  const accountsOutcome = await cloudflare(token, '/accounts?per_page=50', fetcher);
  const accounts = accountsOutcome.ok ? accountList(accountsOutcome.result) : [];
  let accountId = input.accountId;
  if (!accountId) {
    if (accounts.length > 1) return { accountSelectionRequired: true, accounts };
    accountId = accounts[0]?.id;
  }
  const userVerify = await cloudflare(token, '/user/tokens/verify', fetcher);
  const verified = activeToken(userVerify) || (!!accountId && activeToken(await cloudflare(token, `/accounts/${accountId}/tokens/verify`, fetcher)));
  if (!verified) throw new ApiError(400, 'CLOUDFLARE_TOKEN_INVALID', 'Cloudflare did not accept this token as active. Create a new token from the prefilled Cloudflare page and paste it again.');
  if (!accountId) throw new ApiError(400, 'CLOUDFLARE_ACCOUNT_REQUIRED', 'This token cannot see any Cloudflare account. Create it with access to the account that should host previews.');
  if (input.accountId && accountsOutcome.ok && accounts.length && !accounts.some((account) => account.id === accountId)) throw new ApiError(400, 'CLOUDFLARE_ACCOUNT_NOT_GRANTED', `This token does not grant access to account ${accountId}. Create it for that account.`);
  const createdWorker = await ensurePreviewsWorker(token, accountId, input.workerName, fetcher, {
    list: (outcome) => new ApiError(422, 'CLOUDFLARE_PERMISSION_MISSING', `Cloudflare refused this token: ${describeRefusal(outcome)}. Recreate it with Account → Workers Scripts → Edit on account ${accountId} (the prefilled page includes it).`),
    create: (outcome) => new ApiError(422, 'CLOUDFLARE_PERMISSION_MISSING', `The previews Worker ${input.workerName} does not exist and Cloudflare refused to create it: ${describeRefusal(outcome)}. Recreate the token with Account → Workers Scripts → Edit, or create the Worker yourself. ${createByHand(input.workerName)}`),
  });
  const d1 = await cloudflare(token, `/accounts/${accountId}/d1/database?per_page=1`, fetcher);
  if (!d1.ok && !denied(d1)) throw new ApiError(502, 'CLOUDFLARE_VERIFY_FAILED', 'Cloudflare could not list D1 databases. Try again.');
  return { accountId, workerName: input.workerName, permissions: d1.ok ? [WORKERS_PERMISSION, D1_PERMISSION] : [WORKERS_PERMISSION], missing: d1.ok ? [] : [D1_PERMISSION], createdWorker };
}

async function storedRecord(env: AppEnv): Promise<InstallationCredentialRecord | null> {
  if (!env.GITFLARE_SECURITY) return null;
  return security(env).installationCredential();
}

async function openRecord(env: AppEnv, record: InstallationCredentialRecord): Promise<WorkerPreviewsConfig | null> {
  if (!env.AUTH_ENCRYPTION_KEY) return null;
  try {
    const { token } = JSON.parse(await decryptAuth(record.encrypted, env.AUTH_ENCRYPTION_KEY, CONTEXT)) as { token?: unknown };
    return typeof token === 'string' && token ? { accountId: record.accountId, workerName: record.workerName, token } : null;
  } catch { return null; }
}

async function connectionRecord(env: AppEnv): Promise<InstallationConnectionRecord | null> {
  if (!env.GITFLARE_SECURITY) return null;
  return security(env).installationConnection();
}

const referencePrincipal = (record: InstallationConnectionRecord): Principal => ({ userId: record.setBy, workspaceId: record.workspaceId, role: 'Owner' });

function workspaceAccess(env: AppEnv, p: Principal): Promise<CloudflareDeployAccess> {
  return cloudflareDeployAccess(env, p, { action: 'read', resourceType: 'workspace', resourceId: p.workspaceId });
}

function loadProblem(error: unknown, record: InstallationConnectionRecord): ConnectionProblem {
  const code = error instanceof ApiError ? error.code : 'CLOUDFLARE_UNAVAILABLE';
  if (code === 'CLOUDFLARE_NOT_CONNECTED') return { code, message: 'The installation workspace’s Cloudflare connection was disconnected. An Owner must connect Cloudflare again in Settings → Cloudflare.' };
  if (code === 'CONNECTION_REAUTH_REQUIRED' || code === 'CLOUDFLARE_API_REJECTED' || code === 'CLOUDFLARE_INVALID_TOKEN') return { code: 'CLOUDFLARE_CONNECTION_REVOKED', message: 'Cloudflare no longer accepts the installation workspace’s connection (revoked or expired). An Owner must reconnect Cloudflare in Settings → Cloudflare.' };
  if (code === 'ACCOUNT_SELECTION_REQUIRED') return { code, message: `The installation workspace’s Cloudflare connection has no account selected. Select account ${record.accountId} again.` };
  if (code === 'CLOUDFLARE_NOT_CONFIGURED') return { code: 'CLOUDFLARE_OAUTH_UNAVAILABLE', message: 'This installation’s Cloudflare OAuth client is not configured, so the workspace connection cannot be used. Use an API token instead.' };
  return { code, message: 'The installation workspace’s Cloudflare connection could not be loaded. Try again.' };
}

type Inspection = { config: WorkerPreviewsConfig; scopes: string[]; problem?: undefined } | { problem: ConnectionProblem; scopes?: string[] };

async function inspectConnection(env: AppEnv, record: InstallationConnectionRecord, options: { probe?: boolean; fetcher?: Fetcher } = {}): Promise<Inspection> {
  if (!installationOAuthAvailable(env)) return { problem: { code: 'CLOUDFLARE_OAUTH_UNAVAILABLE', message: 'This installation has no Cloudflare OAuth client, so the workspace connection cannot be used. Remove that choice or use an API token instead.' } };
  const principal = referencePrincipal(record);
  if (!await security(env).installationCredentialAdmin(principal).catch(() => false)) return { problem: { code: 'CONNECTION_OWNER_CHANGED', message: 'The Owner who chose this connection is no longer an Owner of the installation workspace. An Owner must choose the connection again.' } };
  let access: CloudflareDeployAccess;
  try { access = await workspaceAccess(env, principal); }
  catch (error) { return { problem: loadProblem(error, record) }; }
  if (access.accountId !== record.accountId) return { problem: { code: 'CLOUDFLARE_ACCOUNT_CHANGED', message: `The installation workspace’s Cloudflare connection now selects account ${access.accountId}, not ${record.accountId}. Select ${record.accountId} again or choose the connection again.` }, scopes: access.scopes };
  const missing = INSTALLATION_CONNECTION_SCOPES.filter((scope) => !access.scopes.includes(scope));
  if (missing.length) return { problem: { code: 'CLOUDFLARE_SCOPE_MISSING', message: `The installation workspace’s Cloudflare connection was not granted ${missing.join(' and ')}. An Owner must reconnect Cloudflare and grant it.` }, scopes: access.scopes };
  const config: WorkerPreviewsConfig = { accountId: access.accountId, workerName: record.workerName, token: access.accessToken, connection: 'installation' };
  if (options.probe) {
    const probe = await cloudflare(access.accessToken, `/accounts/${access.accountId}/workers/workers/${record.workerName}/previews?per_page=1`, options.fetcher ?? ((request) => fetch(request))).catch(() => null);
    if (!probe) return { problem: { code: 'CLOUDFLARE_UNAVAILABLE', message: 'Cloudflare could not be reached to check the previews Worker. Try again.' }, scopes: access.scopes };
    if (!probe.ok && (probe.status === 404 || WORKER_NOT_FOUND.some((code) => probe.codes.includes(code)))) return { problem: { code: 'PREVIEWS_WORKER_MISSING', message: `The previews Worker ${record.workerName} does not exist on account ${record.accountId} (${describeRefusal(probe)}). ${createByHand(record.workerName)}` }, scopes: access.scopes };
    if (!probe.ok && denied(probe)) return { problem: { code: 'CLOUDFLARE_CONNECTION_REFUSED', message: `Cloudflare refused the connection for the previews Worker ${record.workerName}: ${describeRefusal(probe)}. The connection already has workers-scripts.edit, so reconnecting does not help; use an API token for previews instead.` }, scopes: access.scopes };
    if (!probe.ok) return { problem: { code: 'CLOUDFLARE_UNAVAILABLE', message: `Cloudflare could not check the previews Worker: ${describeRefusal(probe)}. Try again.` }, scopes: access.scopes };
  }
  return { config, scopes: access.scopes };
}

export async function resolveWorkerPreviewsConfig(env: AppEnv): Promise<WorkerPreviewsConfig | null> {
  const reference = await connectionRecord(env);
  if (reference) {
    const inspected = await inspectConnection(env, reference);
    if (inspected.problem) throw new ApiError(409, inspected.problem.code, `Worker previews on this installation use the installation workspace’s Cloudflare connection. ${inspected.problem.message}`);
    return inspected.config;
  }
  const record = await storedRecord(env);
  const stored = record ? await openRecord(env, record) : null;
  return stored ?? workerPreviewsConfig(env);
}

function envFallback(env: AppEnv): WorkerPreviewsConfig | null {
  try { return workerPreviewsConfig(env); } catch { return null; }
}

const labelled = (keys: string[], labels: Record<string, string>) => keys.map((key) => ({ key, label: labels[key] ?? key }));

export async function installationCredentialStatus(env: AppEnv, p: Principal, fetcher?: Fetcher): Promise<InstallationCredentialStatus> {
  const manageable = await security(env).installationCredentialAdmin(p);
  const edition = env.EDITION === 'self-hosted' ? 'self-hosted' : 'hosted';
  const oauthAvailable = installationOAuthAvailable(env);
  const record = await storedRecord(env);
  const usable = record ? await openRecord(env, record) : null;
  const fallback = envFallback(env);
  const tokenSource: InstallationTokenSource = usable ? 'installation' : fallback ? 'environment' : 'none';
  const reference = await connectionRecord(env);
  if (reference) {
    const inspected = await inspectConnection(env, reference, { probe: true, ...(fetcher ? { fetcher } : {}) });
    const state = !inspected.problem ? 'configured' : inspected.problem.code === 'CLOUDFLARE_SCOPE_MISSING' ? 'missing_permission' : 'unavailable';
    if (!manageable) return { manageable, edition, oauthAvailable, source: 'connection', state };
    const scopes = inspected.scopes ?? reference.scopes;
    return {
      manageable, edition, oauthAvailable, source: 'connection', state, ...(inspected.problem ? { problem: inspected.problem } : {}),
      accountId: reference.accountId, workerName: reference.workerName, verifiedAt: reference.verifiedAt,
      permissions: INSTALLATION_CONNECTION_SCOPES.filter((scope) => scopes.includes(scope)),
      missing: labelled(inspected.scopes ? INSTALLATION_CONNECTION_SCOPES.filter((scope) => !scopes.includes(scope)) : [], SCOPE_LABELS),
      connection: { workspaceId: reference.workspaceId, accountId: reference.accountId, ...(reference.accountName ? { accountName: reference.accountName } : {}), workerName: reference.workerName, scopes, setBy: reference.setBy },
      tokenSource, tokenPageUrl: previewsTokenPageUrl(reference.workerName, reference.accountId),
    };
  }
  const source: InstallationCredentialSource = tokenSource;
  const missing = usable ? record!.missing : [];
  const state = source === 'none' ? 'missing' : missing.length ? 'missing_permission' : 'configured';
  if (!manageable) return { manageable, edition, oauthAvailable, source, state };
  const workerName = usable?.workerName ?? fallback?.workerName ?? configuredWorkerName(env);
  const accountId = usable?.accountId ?? fallback?.accountId ?? configuredAccountId(env);
  return {
    manageable, edition, oauthAvailable, source, state, workerName, ...(accountId ? { accountId } : {}),
    ...(usable ? { permissions: record!.permissions, verifiedAt: record!.verifiedAt } : {}),
    missing: labelled(missing, PERMISSION_LABELS),
    tokenSource, tokenPageUrl: previewsTokenPageUrl(workerName, accountId),
  };
}

async function requireInstallationOwner(env: AppEnv, p: Principal): Promise<void> {
  if (!await security(env).installationCredentialAdmin(p)) throw new ApiError(403, 'INSTALLATION_OWNER_REQUIRED', 'Only an owner of the installation workspace can change its Cloudflare credential.');
}

function optionalAccount(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  const id = requireString(value, 'Cloudflare account', 32, 32);
  if (!/^[a-f0-9]{32}$/.test(id)) throw new ApiError(400, 'INVALID_INPUT', 'Select a valid Cloudflare account.');
  return id;
}

export async function useInstallationConnection(env: AppEnv, p: Principal, body: Record<string, unknown>, fetcher: Fetcher = (request) => fetch(request)): Promise<UseConnectionResult> {
  await requireInstallationOwner(env, p);
  if (!installationOAuthAvailable(env)) throw new ApiError(409, 'CLOUDFLARE_OAUTH_UNAVAILABLE', 'This installation has no Cloudflare OAuth client. Use an API token instead.');
  const fixedAccount = configuredAccountId(env);
  const requested = optionalAccount(body.accountId);
  if (fixedAccount && requested && requested !== fixedAccount) throw new ApiError(400, 'CLOUDFLARE_ACCOUNT_FIXED', `Previews on this installation use account ${fixedAccount}.`);
  const workerName = body.workerName === undefined || body.workerName === '' ? configuredWorkerName(env) : requireString(body.workerName, 'Previews Worker', 53);
  if (!/^[a-z0-9][a-z0-9-]{0,52}$/.test(workerName)) throw new ApiError(400, 'INVALID_WORKER_NAME', 'Use lowercase letters, digits and hyphens for the previews Worker name.');
  const access = await workspaceAccess(env, p);
  const wanted = requested ?? fixedAccount;
  if (wanted && access.accountId !== wanted) throw new ApiError(409, 'CLOUDFLARE_ACCOUNT_MISMATCH', `This workspace’s Cloudflare connection uses account ${access.accountId}. Select account ${wanted} on the connection first.`);
  const missing = INSTALLATION_CONNECTION_SCOPES.filter((scope) => !access.scopes.includes(scope));
  if (missing.length) throw new ApiError(422, 'CLOUDFLARE_SCOPE_MISSING', `This workspace’s Cloudflare connection was not granted ${missing.join(' and ')}. Reconnect Cloudflare and grant it; if Cloudflare does not offer it, the installation must request it through CLOUDFLARE_DEPLOY_SCOPES.`);
  const createdWorker = await ensurePreviewsWorker(access.accessToken, access.accountId, workerName, fetcher, {
    list: (outcome) => new ApiError(422, 'CLOUDFLARE_CONNECTION_REFUSED', `Cloudflare refused the connection’s request for the previews Worker ${workerName}: ${describeRefusal(outcome)}. The connection already has workers-scripts.edit, so reconnecting does not help; use an API token for previews instead.`),
    create: (outcome) => new ApiError(422, 'PREVIEWS_WORKER_NOT_CREATABLE', `The previews Worker ${workerName} does not exist on account ${access.accountId}, and Cloudflare refused to create it with the connection: ${describeRefusal(outcome)}. ${createByHand(workerName)}`),
  });
  await security(env).changeInstallationConnection(p, {
    version: crypto.randomUUID(), workspaceId: p.workspaceId, accountId: access.accountId, ...(access.accountName ? { accountName: access.accountName } : {}),
    workerName, scopes: access.scopes, verifiedAt: new Date().toISOString(), setBy: p.userId,
  });
  return { stored: true, createdWorker, status: await installationCredentialStatus(env, p, fetcher) };
}

export async function removeInstallationConnection(env: AppEnv, p: Principal): Promise<InstallationCredentialStatus> {
  await security(env).changeInstallationConnection(p, null);
  return installationCredentialStatus(env, p);
}

export async function setInstallationCredential(env: AppEnv, p: Principal, body: Record<string, unknown>, fetcher: Fetcher = (request) => fetch(request)): Promise<SetCredentialResult> {
  await requireInstallationOwner(env, p);
  if (!env.AUTH_ENCRYPTION_KEY) throw new ApiError(503, 'AUTH_ENCRYPTION_REQUIRED', 'This installation has no AUTH_ENCRYPTION_KEY, so it cannot store credentials.');
  const token = requireString(body.token, 'API token', 400, 20);
  if (!/^[A-Za-z0-9_.-]+$/.test(token)) throw new ApiError(400, 'CLOUDFLARE_TOKEN_INVALID', 'Paste the API token exactly as Cloudflare shows it.');
  const fixedAccount = configuredAccountId(env);
  const requested = optionalAccount(body.accountId);
  if (fixedAccount && requested && requested !== fixedAccount) throw new ApiError(400, 'CLOUDFLARE_ACCOUNT_FIXED', `Previews on this installation use account ${fixedAccount}.`);
  const verified = await verifyPreviewsToken(token, { accountId: fixedAccount ?? requested, workerName: configuredWorkerName(env) }, fetcher);
  if ('accountSelectionRequired' in verified) return { stored: false, ...verified };
  const record: InstallationCredentialRecord = {
    version: crypto.randomUUID(),
    encrypted: await encryptAuth(JSON.stringify({ token }), env.AUTH_ENCRYPTION_KEY, CONTEXT),
    accountId: verified.accountId, workerName: verified.workerName, permissions: verified.permissions, missing: verified.missing,
    verifiedAt: new Date().toISOString(), setBy: p.userId,
  };
  await security(env).changeInstallationCredential(p, record);
  return { stored: true, createdWorker: verified.createdWorker, status: await installationCredentialStatus(env, p) };
}

export async function removeInstallationCredential(env: AppEnv, p: Principal): Promise<InstallationCredentialStatus> {
  await security(env).changeInstallationCredential(p, null);
  return installationCredentialStatus(env, p);
}

export async function handleInstallationCredential(request: Request, env: AppEnv, p: Principal, action: string): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  if (request.method === 'GET' && action === '') return Response.json(await installationCredentialStatus(env, p), { headers });
  if (request.method !== 'POST' || !['', 'remove', 'connection', 'connection-remove'].includes(action)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use a supported installation credential action.');
  assertMutationOrigin(request);
  const body = await readJson(request);
  if (action === 'remove') return Response.json(await removeInstallationCredential(env, p), { headers });
  if (action === 'connection') return Response.json(await useInstallationConnection(env, p, body), { headers });
  if (action === 'connection-remove') return Response.json(await removeInstallationConnection(env, p), { headers });
  if (request.headers.has('Authorization') || !p.sessionId || p.bootstrap) throw new ApiError(403, 'BROWSER_REQUIRED', 'Paste the Cloudflare token in Settings → Cloudflare while signed in through the browser. API tokens are never accepted from API or MCP clients.');
  return Response.json(await setInstallationCredential(env, p, body), { headers });
}
