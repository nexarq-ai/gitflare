import { ApiError, assertMutationOrigin, readJson, requireString } from './domain';
import type { AppEnv } from './env';
import { securityClient, type Action, type Principal } from './security';
import { decryptAuth, encryptAuth, randomCapability } from './mfa';
import type { WorkerDeployer } from './deployments';
import { cloudflareDeployClient, workerDeployer, type CloudflareDeployAccess } from './cloudflare-deploy';
import { handleInstallationCredential } from './installation-credential';
import { secretsStoreScopes } from './secrets-scopes';
import { accessScopes } from './preview-access';
import { gitflareInfrastructure, isGitflareResource, type CatalogItem } from '../shared/gitflare-infrastructure';
import { CLOUDFLARE_FEATURES, CLOUDFLARE_PERMISSIONS_DOCS_PATH, describeCloudflareScopes, featureScopes, featureStates, hasScope, parseCloudflareFeatures, type CloudflareFeature, type CloudflarePermissionPlan } from '../shared/cloudflare-permissions';

export interface CloudflareConnection { version: string; encrypted: string; issuer: Principal; account?: Account }
export interface CloudflareOAuthState { id: string; browserHash: string; principal: Principal; expiresAt: number; encrypted: string; repositoryId?: string; grantId?: string }
export type CloudflareStoreOperation = 'get' | 'put' | 'delete' | 'state-put' | 'state-consume' | 'resolve' | 'accounts' | 'account-put' | 'account-remove' | 'account-default';
export interface ConnectedCloudflareAccount { id: string; name: string; slot: string; addedBy: string; addedAt: string }
export interface RepositoryAccountSelection { accountId?: string; environments?: Record<string, string> }
export interface CloudflareAccountsOverview { connected: boolean; defaultAccount: Account | null; accounts: { id: string; name: string; grantId: string | null }[]; repositories: Record<string, RepositoryAccountSelection & { own?: Account | true }>; grants?: string[] }
interface Resolution { record: CloudflareConnection; slot: string; source: CloudflareConnectionSource; selection: 'own' | 'environment' | 'repository' | 'default'; account?: Account }
export interface CloudflareAuthorization { action: Action; resourceType: string; resourceId: string; expectedAccountId?: string }
export interface CloudflareApiOptions { method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'; body?: unknown; authorization?: CloudflareAuthorization; expectedAccountId?: string }
interface Store { connectionStore(p: Principal | null, operation: CloudflareStoreOperation, body: Record<string, unknown>): Promise<unknown>; projectStore(p: Principal, repositoryId: string, operation: 'get' | 'account', body?: Record<string, unknown>): Promise<unknown>; check(p: Principal, action: Action, resourceType?: string, resourceId?: string): Promise<void>; rateLimit(key: string, max?: number, windowMs?: number): Promise<void> }
interface Account { id: string; name: string }
export type CloudflareVault = Vault;
export interface CloudflareIdentity {
  id: string; email: string; name: string;
  // GET /user and the id_token carry no email-verification claim, so nothing sets this until Cloudflare provides one
  emailVerified?: boolean;
}
interface Vault { accessToken: string; refreshToken?: string; expiresAt: number; account?: Account; scopes: string[]; clientId: string }
interface TokenResponse { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; token_type?: unknown }
interface Pending { verifier: string; redirectUri: string; expectedVersion: string | null; repositoryId?: string; grantId?: string; extraScopes?: string[] }
interface Slot { repositoryId?: string; grantId?: string }
export type CloudflareConnectionSource = 'repository' | 'workspace';
const authorizeEndpoint = 'https://dash.cloudflare.com/oauth2/auth';
const tokenEndpoint = 'https://dash.cloudflare.com/oauth2/token';
const revokeEndpoint = 'https://dash.cloudflare.com/oauth2/revoke';
const apiOrigin = 'https://api.cloudflare.com/client/v4';
export const CLOUDFLARE_CONNECT_STATE_COOKIE = '__Host-gitflare-cloudflare-state';
export const CLOUDFLARE_LINK_COOKIE = '__Host-gitflare-cloudflare-link';
export const CLOUDFLARE_SIGNIN_STATE_COOKIE = '__Host-gitflare-signin-state';
export const CLOUDFLARE_CALLBACK_PATH = '/api/cloudflare/callback';
const defaultScopes = 'account-settings.read workers-scripts.metadata_read d1.read d1.write account-analytics.read containers.read';
const defaultIdentityScopes = 'user-details.read';
export const WORKER_USAGE_QUERY = 'query GitflareWorkerUsage($accountTag: string!, $scriptName: string!, $start: Time!, $end: Time!) { viewer { accounts(filter: {accountTag: $accountTag}) { workersInvocationsAdaptive(limit: 100, filter: {scriptName: $scriptName, datetime_geq: $start, datetime_leq: $end}) { dimensions {scriptName} sum {requests errors} quantiles {cpuTimeP50 cpuTimeP99} } } } }';
export const D1_USAGE_QUERY = 'query GitflareD1Usage($accountTag: string!, $databaseId: string!, $start: Date!, $end: Date!) { viewer { accounts(filter: {accountTag: $accountTag}) { d1AnalyticsAdaptiveGroups(limit: 100, filter: {databaseId: $databaseId, date_geq: $start, date_leq: $end}, orderBy: [date_DESC]) { dimensions {date databaseId} sum {readQueries writeQueries rowsRead rowsWritten} } } } }';
function service(env: AppEnv): Store { return securityClient(env) as unknown as Store; }
function configured(env: AppEnv): boolean { return Boolean(env.CLOUDFLARE_CLIENT_ID && env.CLOUDFLARE_CLIENT_SECRET && env.AUTH_ENCRYPTION_KEY); }
function scopeList(value: string): string[] { return [...new Set(value.split(/\s+/).filter(scope=>scope&&scope!=='openid'))]; }
// The OAuth client rejects any unregistered scope (openid included), so deploy and Access scopes stay opt-in; its id_token carries only `sub`
export function connectScopes(env: AppEnv): string[] { return scopeList(`offline_access ${env.CLOUDFLARE_OAUTH_SCOPES??defaultScopes}`); }
// Connect requests without a feature list keep the scopes installations configured before features existed
export function defaultFeatures(env: AppEnv): CloudflareFeature[] { return [...(env.CLOUDFLARE_DEPLOY_SCOPES?['deploy' as const]:[]),...(env.CLOUDFLARE_ACCESS_SCOPES?['access' as const]:[])]; }
export function requestedScopes(env: AppEnv, features: readonly CloudflareFeature[] = defaultFeatures(env)): string[] { return scopeList([...connectScopes(env),...features.flatMap(feature=>featureScopes(env,feature))].join(' ')); }
export function signinScopes(env: AppEnv): string[] { return scopeList(env.CLOUDFLARE_IDENTITY_SCOPES??defaultIdentityScopes); }
export type CloudflareGrantPurpose = 'connect' | 'signin';
function purposeScopes(env: AppEnv, purpose: CloudflareGrantPurpose): string[] { return purpose==='signin'?signinScopes(env):connectScopes(env); }
export function connectPermissionPlan(env: AppEnv, features: readonly CloudflareFeature[] = defaultFeatures(env)): CloudflarePermissionPlan & { features: CloudflareFeature[] } { const scopes=requestedScopes(env,features); return {scopes,features:[...features],permissions:describeCloudflareScopes(scopes,accessScopes(env)),docsUrl:CLOUDFLARE_PERMISSIONS_DOCS_PATH}; }
export const CLOUDFLARE_DEPLOY_SCOPE = 'workers-scripts.edit';
// Grants stored before scope parsing split only on single spaces; normalise on every read
export function grantedScopes(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return [...new Set(parts.flatMap((part) => typeof part === 'string' ? part.split(/[\s,]+/) : []).map((scope) => scope.trim()).filter(Boolean))];
}
export function cloudflareSigninConfigured(env: AppEnv): boolean { return configured(env); }
export function requestCookie(request: Request, name: string): string | undefined { return request.headers.get('Cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(`${name}=`))?.slice(name.length+1); }
function requireConfiguration(env: AppEnv) { if (!configured(env)) throw new ApiError(503, 'CLOUDFLARE_NOT_CONFIGURED', 'Configure this installation’s Cloudflare OAuth client before connecting an account.'); }
function connectionContext(p: Principal, slot: Slot = {}): string { return slot.repositoryId ? `cloudflare-connection:${p.workspaceId}:repository:${slot.repositoryId}` : slot.grantId ? `cloudflare-connection:${p.workspaceId}:grant:${slot.grantId}` : `cloudflare-connection:${p.workspaceId}`; }
function repositoryScope(repositoryId?: string): Record<string, string> { return repositoryId ? { repositoryId } : {}; }
function slotScope(slot: Slot = {}): Record<string, string> { return slot.repositoryId ? { repositoryId: slot.repositoryId } : slot.grantId ? { grantId: slot.grantId } : {}; }
function slotNamed(name: string): Slot { return name.startsWith('repository:') ? { repositoryId: name.slice('repository:'.length) } : name.startsWith('grant:') ? { grantId: name.slice('grant:'.length) } : {}; }
function repositorySlot(repositoryId?: string): Slot { return repositoryId ? { repositoryId } : {}; }
function requireRepositoryId(value: string): string { if (!/^[a-zA-Z0-9-]{1,100}$/.test(value)) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.'); return value; }
function currentIssuer(p: Principal): Principal { return { userId: p.userId, workspaceId: p.workspaceId, role: p.role, ...(p.bootstrap ? {bootstrap:true} : {}) }; }
async function owner(env: AppEnv, p: Principal): Promise<void> { if (p.role !== 'Owner' || p.credentialId) throw new ApiError(403, 'OWNER_REQUIRED', 'Only a workspace owner can manage its Cloudflare connection.'); await service(env).check(p, 'manage'); }
async function sha(value: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))), b=>b.toString(16).padStart(2,'0')).join(''); }
function clientAuthorization(env: AppEnv): string { return `Basic ${btoa(`${encodeURIComponent(env.CLOUDFLARE_CLIENT_ID!)}:${encodeURIComponent(env.CLOUDFLARE_CLIENT_SECRET!)}`)}`; }
async function jsonRequest(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try { response = await fetch(url,{...init,redirect:'manual',signal:AbortSignal.timeout(15000)}); }
  catch { throw new ApiError(502,'CLOUDFLARE_UNAVAILABLE','Cloudflare could not be reached. Try again.'); }
  if (!response.ok) throw new ApiError(response.status === 401 ? 409 : response.status === 403 ? 403 : 502,'CLOUDFLARE_API_REJECTED','Cloudflare rejected this operation. Check the connected account and granted permissions.');
  const text = await response.text(); if (text.length > 2000000) throw new ApiError(502,'CLOUDFLARE_RESPONSE_TOO_LARGE','Cloudflare returned a response too large to display.');
  try { return JSON.parse(text); } catch { throw new ApiError(502,'CLOUDFLARE_INVALID_RESPONSE','Cloudflare returned an invalid response.'); }
}
function authenticatedForm(env: AppEnv, form: URLSearchParams): {headers:Record<string,string>;body:URLSearchParams} {
  const headers:Record<string,string>={'Content-Type':'application/x-www-form-urlencoded'};
  if(env.CLOUDFLARE_CLIENT_AUTH_METHOD==='client_secret_basic') headers.Authorization=clientAuthorization(env);
  else {form.set('client_id',env.CLOUDFLARE_CLIENT_ID!);form.set('client_secret',env.CLOUDFLARE_CLIENT_SECRET!);}
  return {headers,body:form};
}
async function tokenRequest(env: AppEnv, form: URLSearchParams): Promise<TokenResponse> { return await jsonRequest(tokenEndpoint,{method:'POST',...authenticatedForm(env,form)}) as TokenResponse; }
function tokenValues(response: TokenResponse) {
  const expiry = Number(response.expires_in);
  if (typeof response.access_token !== 'string' || !response.access_token || response.access_token.length > 16000 || !Number.isFinite(expiry) || expiry <= 0 || expiry > 31536000 || typeof response.token_type === 'string' && response.token_type.toLowerCase() !== 'bearer') throw new ApiError(502,'CLOUDFLARE_INVALID_TOKEN','Cloudflare returned incomplete authorization credentials.');
  return {accessToken:response.access_token,refreshToken:typeof response.refresh_token==='string'?response.refresh_token:undefined,expiresAt:Date.now()+expiry*1000};
}
export async function sealCloudflareConnection(env: AppEnv, issuer: Principal, vault: Vault): Promise<CloudflareConnection> {
  return {version:crypto.randomUUID(),issuer,encrypted:await encryptAuth(JSON.stringify(vault),env.AUTH_ENCRYPTION_KEY,connectionContext(issuer)),...(vault.account?{account:vault.account}:{})};
}
async function seal(env: AppEnv, p: Principal, vault: Vault, issuer: Principal, slot: Slot): Promise<CloudflareConnection> {
  return {version:crypto.randomUUID(),issuer,encrypted:await encryptAuth(JSON.stringify(vault),env.AUTH_ENCRYPTION_KEY,connectionContext(p,slot)),...(vault.account?{account:vault.account}:{})};
}
async function save(env: AppEnv, p: Principal, vault: Vault, expectedVersion: string | null, issuer = currentIssuer(p), slot: Slot = {}): Promise<CloudflareConnection> {
  const value = await seal(env,p,vault,issuer,slot);
  await service(env).connectionStore(p,'put',{value,expectedVersion,...slotScope(slot)}); return value;
}
async function stored(env: AppEnv, p: Principal, authorization?: CloudflareAuthorization, slot: Slot = {}): Promise<CloudflareConnection | null> {
  return await service(env).connectionStore(p,'get',{...(authorization?{authorization}:{}),...slotScope(slot)}) as CloudflareConnection | null;
}
async function unseal(env: AppEnv, p: Principal, record: CloudflareConnection, slot: Slot = {}): Promise<Vault> { return JSON.parse(await decryptAuth(record.encrypted,env.AUTH_ENCRYPTION_KEY,connectionContext(p,slot))) as Vault; }
async function openConnection(env: AppEnv, p: Principal, record: CloudflareConnection, slot: Slot = {}): Promise<{record:CloudflareConnection;vault:Vault}> {
  let vault = await unseal(env,p,record,slot);
  if (vault.clientId !== env.CLOUDFLARE_CLIENT_ID) throw new ApiError(409,'CONNECTION_REAUTH_REQUIRED','Reconnect after changing this installation’s Cloudflare client.');
  if (vault.expiresAt <= Date.now()+30000) {
    if (!vault.refreshToken) throw new ApiError(409,'CONNECTION_REAUTH_REQUIRED','The Cloudflare authorization expired. Reconnect your account.');
    const values=tokenValues(await tokenRequest(env,new URLSearchParams({grant_type:'refresh_token',refresh_token:vault.refreshToken})));
    vault = {...vault,...values,refreshToken:values.refreshToken??vault.refreshToken};
    const refreshed = await save(env,currentIssuer(record.issuer),vault,record.version,record.issuer,slot);
    return {record:refreshed,vault};
  }
  if (!record.account && vault.account && !slot.repositoryId && !slot.grantId) {
    const recorded = await save(env,currentIssuer(record.issuer),vault,record.version,record.issuer,slot).catch(() => null);
    if (recorded) return {record:recorded,vault};
  }
  return {record,vault};
}
async function load(env: AppEnv, p: Principal, authorization?: CloudflareAuthorization, slot: Slot = {}): Promise<{record:CloudflareConnection;vault:Vault}> {
  requireConfiguration(env);
  const record = await stored(env,p,authorization,slot);
  if (!record) throw new ApiError(409,'CLOUDFLARE_NOT_CONNECTED','Connect a Cloudflare account first.');
  return openConnection(env,p,record,slot);
}
export async function resolveCloudflareConnection(env: AppEnv, p: Principal, authorization?: CloudflareAuthorization, repositoryId?: string, environment?: string): Promise<{record:CloudflareConnection;vault:Vault;source:CloudflareConnectionSource;selection:Resolution['selection']}> {
  requireConfiguration(env);
  const resolved = await service(env).connectionStore(p,'resolve',{...(authorization?{authorization}:{}),...(repositoryId?{repositoryId:requireRepositoryId(repositoryId)}:{}),...(environment?{environment}:{})}) as Resolution | null;
  if (!resolved) throw new ApiError(409,'CLOUDFLARE_NOT_CONNECTED','Connect a Cloudflare account first.');
  const opened = await openConnection(env,p,resolved.record,slotNamed(resolved.slot));
  return {...opened,vault:resolved.account?{...opened.vault,account:resolved.account}:opened.vault,source:resolved.source,selection:resolved.selection};
}
const loadPreferred = resolveCloudflareConnection;
function selectedAccount(vault: Vault, source: CloudflareConnectionSource): Account {
  if (!vault.account) throw new ApiError(409,'ACCOUNT_SELECTION_REQUIRED',`Select the Cloudflare account for this ${source} first.`);
  return vault.account;
}
interface CloudflareEnvelope { success?: boolean; result?: unknown; result_info?: { total_pages?: number; total_count?: number; next_page_token?: string } }
async function apiEnvelope(env: AppEnv, vault: Vault, path: string, options: CloudflareApiOptions = {}): Promise<CloudflareEnvelope> {
  const result = await jsonRequest(`${apiOrigin}${path}`,{method:options.method??'GET',headers:{Authorization:`Bearer ${vault.accessToken}`,...(options.body===undefined?{}:{'Content-Type':'application/json'})},body:options.body===undefined?undefined:JSON.stringify(options.body)}) as {success?:boolean;result?:unknown};
  if (result.success===false) throw new ApiError(502,'CLOUDFLARE_API_REJECTED','Cloudflare could not complete this operation. Check account permissions.');
  return result;
}
async function api(env: AppEnv, vault: Vault, path: string, options: CloudflareApiOptions = {}): Promise<unknown> { return (await apiEnvelope(env, vault, path, options)).result; }
const resourceLists: Record<string, 'all' | 'page' | 'cursor'> = { '/workers/scripts': 'all', '/workers/durable_objects/namespaces': 'page', '/d1/database': 'page', '/workflows': 'page', '/containers/applications': 'cursor' };
async function listResources(env: AppEnv, vault: Vault, path: string): Promise<unknown[]> {
  const mode = resourceLists[path];
  const items: unknown[] = [];
  let cursor = '';
  const seen = new Set<string>();
  for (let page = 1; page <= 50; page++) {
    const query = mode === 'all' ? '' : `?${new URLSearchParams({ per_page: '100', ...(mode === 'page' ? { page: String(page) } : cursor ? { page_token: cursor } : {}) })}`;
    const response = await apiEnvelope(env, vault, `/accounts/${vault.account!.id}${path}${query}`);
    if (!Array.isArray(response.result)) throw new ApiError(502, 'CLOUDFLARE_INVALID_RESPONSE', 'Cloudflare did not return a resource list.');
    items.push(...response.result);
    if (mode === 'all') return items;
    if (mode === 'cursor') {
      cursor = response.result_info?.next_page_token ?? '';
      if (!cursor) return items;
      if (seen.has(cursor)) break;
      seen.add(cursor);
    } else {
      const totalPages = response.result_info?.total_pages;
      const totalCount = response.result_info?.total_count;
      if (totalPages !== undefined ? page >= totalPages : totalCount !== undefined ? items.length >= totalCount : response.result.length < 100) return items;
      if (!response.result.length) break;
    }
  }
  throw new ApiError(502, 'CLOUDFLARE_CATALOG_LIMIT', 'Cloudflare returned an incomplete resource catalog. Narrow the account scope before retrying.');
}
function status(env: AppEnv, vault?: Vault, requested?: CloudflareFeature[]) { return {configured:configured(env),connected:!!vault,permissions:connectPermissionPlan(env,connectFeatures(env,requested,vault?grantedScopes(vault.scopes):[])),features:featureStates(env,vault?grantedScopes(vault.scopes):null),...(vault?{expiresAt:vault.expiresAt,scopes:grantedScopes(vault.scopes),account:vault.account}: {})}; }
function accountsValue(result: unknown): Account[] {
  if (!Array.isArray(result)) throw new ApiError(502,'CLOUDFLARE_INVALID_RESPONSE','Cloudflare did not return an account list.');
  return result.filter(a=>a && typeof a.id==='string' && /^[a-f0-9]{32}$/i.test(a.id) && typeof a.name==='string').map(a=>({id:a.id,name:a.name.slice(0,200)}));
}
function checkAccount(vault: Vault, expectedAccountId?: string) { if(expectedAccountId && vault.account?.id!==expectedAccountId) throw new ApiError(409,'CLOUDFLARE_ACCOUNT_CHANGED','The selected Cloudflare account changed. Update the project resource mapping before continuing.'); }
export async function cloudflareAccount(env: AppEnv,p:Principal,authorization?:CloudflareAuthorization,repositoryId?:string):Promise<Account> { const {vault,source}=await loadPreferred(env,p,authorization,repositoryId); const account=selectedAccount(vault,source); checkAccount(vault,authorization?.expectedAccountId); return account; }
export async function cloudflareApiRequest(env:AppEnv,p:Principal,path:string,options:CloudflareApiOptions={},repositoryId?:string):Promise<unknown> {
  if(!/^\/(?:workers\/|d1\/|workflows(?:\/|$)|containers\/applications(?:\/|$))/.test(path) || /(?:\.\.|%|[?#\\])/.test(path) || !/^\/[A-Za-z0-9_./-]+$/.test(path)) throw new ApiError(400,'INVALID_CLOUDFLARE_PATH','Use a resource path inside the selected Cloudflare account.');
  const {vault,source}=await loadPreferred(env,p,options.authorization,repositoryId); const account=selectedAccount(vault,source);
  checkAccount(vault,options.expectedAccountId??options.authorization?.expectedAccountId);
  if (resourceLists[path] && (!options.method || options.method === 'GET')) return listResources(env, vault, path);
  return api(env,vault,`/accounts/${account.id}${path}`,options);
}
export async function cloudflareAnalyticsRequest(env:AppEnv,p:Principal,body:{query:string;variables:Record<string,unknown>},authorization?:CloudflareAuthorization,repositoryId?:string):Promise<unknown> {
  if (![WORKER_USAGE_QUERY,D1_USAGE_QUERY].includes(body.query)) throw new ApiError(400,'INVALID_ANALYTICS_QUERY','Use the supported project usage queries.');
  const {vault,source}=await loadPreferred(env,p,authorization,repositoryId); const account=selectedAccount(vault,source);
  checkAccount(vault,authorization?.expectedAccountId);
  const response=await jsonRequest(`${apiOrigin}/graphql`,{method:'POST',headers:{Authorization:`Bearer ${vault.accessToken}`,'Content-Type':'application/json'},body:JSON.stringify({query:body.query,variables:{...body.variables,accountTag:account.id}})}) as {data?:unknown;errors?:unknown[]};
  if(response.errors?.length) throw new ApiError(502,'CLOUDFLARE_ANALYTICS_REJECTED','Cloudflare could not return usage for this project. Check analytics permissions.'); return response.data;
}
export async function cloudflareDeployAccess(env: AppEnv, p: Principal, authorization: CloudflareAuthorization, repositoryId?: string, environment?: string): Promise<CloudflareDeployAccess> {
  const {vault,source}=await loadPreferred(env,p,authorization,repositoryId,environment); const account=selectedAccount(vault,source);
  checkAccount(vault,authorization.expectedAccountId);
  return {accessToken:vault.accessToken,accountId:account.id,...(account.name?{accountName:account.name}:{}),scopes:grantedScopes(vault.scopes),source};
}
export function assertDeployScope(scopes: string[]): void {
  if (!hasScope(scopes,CLOUDFLARE_DEPLOY_SCOPE)) throw new ApiError(403,'CLOUDFLARE_SCOPE_MISSING',`The Cloudflare connection was not granted ${CLOUDFLARE_DEPLOY_SCOPE} (Workers Scripts Write). An Owner must reconnect Cloudflare after the installation requests that scope.`);
}
export async function cloudflareWorkerDeployer(env:AppEnv,p:Principal,workerName:string,expectedAccountId:string,fetcher:(request:Request)=>Promise<Response>=request=>fetch(request),repositoryId?:string,environment?:string):Promise<WorkerDeployer> {
  if(!/^[a-zA-Z0-9_-]{1,63}$/.test(workerName)) throw new ApiError(400,'INVALID_WORKER_NAME','Invalid Worker name.');
  const access=await cloudflareDeployAccess(env,p,{action:'deploy',resourceType:'environment',resourceId:workerName,expectedAccountId},repositoryId,environment);
  assertDeployScope(access.scopes);
  return workerDeployer(cloudflareDeployClient(access,fetcher),workerName);
}
export async function cloudflareAuthorizationUrl(env:AppEnv,redirectUri:string,state:string,verifier:string,purpose:CloudflareGrantPurpose='connect',extraScopes:string[]=[]):Promise<string> {
  const challenge=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const url=new URL(authorizeEndpoint);url.search=new URLSearchParams({response_type:'code',client_id:env.CLOUDFLARE_CLIENT_ID!,redirect_uri:redirectUri,state,code_challenge:challenge,code_challenge_method:'S256',scope:[...new Set([...purposeScopes(env,purpose),...extraScopes])].join(' ')}).toString();
  return url.toString();
}
export async function exchangeCloudflareCode(env:AppEnv,code:string,redirectUri:string,verifier:string,purpose:CloudflareGrantPurpose='connect',extraScopes:string[]=[]):Promise<Vault> {
  const response=await tokenRequest(env,new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:redirectUri,code_verifier:verifier}));const values=tokenValues(response);
  return {...values,scopes:typeof response.scope==='string'?grantedScopes(response.scope):[...new Set([...purposeScopes(env,purpose),...extraScopes])],clientId:env.CLOUDFLARE_CLIENT_ID!};
}
export async function cloudflareIdentity(env:AppEnv,vault:Vault):Promise<CloudflareIdentity> {
  let user:unknown;
  try { user=await api(env,vault,'/user'); } catch { throw new ApiError(403,'CLOUDFLARE_IDENTITY_UNAVAILABLE','Cloudflare did not share your user details. Allow User Details Read and try again.'); }
  const value=(user??{}) as {id?:unknown;email?:unknown;first_name?:unknown;last_name?:unknown;suspended?:unknown};
  const email=typeof value.email==='string'?value.email.trim().toLowerCase():'';
  if(typeof value.id!=='string'||!/^[A-Za-z0-9-]{8,64}$/.test(value.id)||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(502,'CLOUDFLARE_IDENTITY_UNAVAILABLE','Cloudflare did not return a usable user identity.');
  if(value.suspended===true) throw new ApiError(403,'CLOUDFLARE_USER_SUSPENDED','This Cloudflare user is suspended.');
  const name=[value.first_name,value.last_name].filter(part=>typeof part==='string'&&part.trim()).join(' ').trim().slice(0,100)||email.split('@')[0].slice(0,100);
  // Owner decision (Oct 17): a Cloudflare account email counts as verified; Cloudflare's /user has no verification flag
  return {id:value.id,email,name,emailVerified:true};
}
export async function cloudflareAccounts(env:AppEnv,vault:Vault):Promise<Account[]> { return accountsValue(await api(env,vault,'/accounts')); }
export async function revokeCloudflareTokens(env:AppEnv,vault:Pick<Vault,'accessToken'|'refreshToken'>):Promise<boolean> {
  if(!env.CLOUDFLARE_CLIENT_ID||!env.CLOUDFLARE_CLIENT_SECRET)return false;
  let revoked=true;
  for(const token of [vault.refreshToken,vault.accessToken].filter(Boolean) as string[]) {
    try {const response=await fetch(revokeEndpoint,{method:'POST',...authenticatedForm(env,new URLSearchParams({token})),redirect:'manual',signal:AbortSignal.timeout(15000)});if(!response.ok)revoked=false;}catch{revoked=false;}
  }
  return revoked;
}
function requestedFeatures(value: unknown): CloudflareFeature[] | undefined { const features=parseCloudflareFeatures(value); if(features===null) throw new ApiError(400,'INVALID_FEATURES',`features must list some of ${CLOUDFLARE_FEATURES.join(', ')}.`); return features; }
export function grantedFeatures(env: AppEnv, scopes: readonly string[]): CloudflareFeature[] { return featureStates(env,scopes).filter(state=>state.granted).map(state=>state.feature); }
export function connectFeatures(env: AppEnv, requested: readonly CloudflareFeature[] | undefined, kept: readonly string[], secrets = false): CloudflareFeature[] {
  const legacySecrets = secretsStoreScopes(env).some(scope=>kept.includes(scope));
  return CLOUDFLARE_FEATURES.filter(feature=>(requested??defaultFeatures(env)).includes(feature)||grantedFeatures(env,kept).includes(feature)||(feature==='secrets'&&(secrets||legacySecrets)));
}
async function start(env:AppEnv,p:Principal,origin:string,repositoryId?:string,options:{secrets?:boolean;features?:CloudflareFeature[];grantId?:string}={}) {
  await owner(env,p); requireConfiguration(env); if(!p.sessionId) throw new ApiError(403,'ACCOUNT_SESSION_REQUIRED','Sign in through the browser before connecting Cloudflare.');
  const uri=new URL(origin); if(uri.protocol!=='https:') throw new ApiError(400,'HTTPS_REQUIRED','Cloudflare account connection requires HTTPS.');
  const state=randomCapability(); const binder=randomCapability(); const verifier=randomCapability(); const id=await sha(state); const expiresAt=Date.now()+600000;
  const slot:Slot=options.grantId?{grantId:options.grantId}:repositorySlot(repositoryId);
  const previous=await stored(env,p,undefined,slot);
  const template=options.grantId?await stored(env,p):previous;
  const kept=template?await unseal(env,p,template,options.grantId?{}:slot).then(vault=>grantedScopes(vault.scopes),()=>[] as string[]):[];
  const features=connectFeatures(env,options.features,kept,options.secrets);
  const base=new Set(connectScopes(env));
  const extraScopes=requestedScopes(env,features).filter(scope=>!base.has(scope));
  const pending:Pending={verifier,redirectUri:`${uri.origin}/api/cloudflare/callback`,expectedVersion:previous?.version??null,...slotScope(slot),...(extraScopes.length?{extraScopes}:{})};
  const record:CloudflareOAuthState={id,browserHash:await sha(binder),principal:p,expiresAt,encrypted:await encryptAuth(JSON.stringify(pending),env.AUTH_ENCRYPTION_KEY,`cloudflare-state:${id}`),...slotScope(slot)};
  await service(env).connectionStore(p,'state-put',{value:record,...slotScope(slot)});
  return {authorizationUrl:await cloudflareAuthorizationUrl(env,pending.redirectUri,state,verifier,'connect',extraScopes),expiresAt,permissions:connectPermissionPlan(env,features),cookie:`${CLOUDFLARE_CONNECT_STATE_COOKIE}=${binder}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`};
}
async function callback(request:Request,env:AppEnv):Promise<Response> {
  requireConfiguration(env);const url=new URL(request.url);const state=requireString(url.searchParams.get('state'),'OAuth state',128,64);
  const binder=requestCookie(request,CLOUDFLARE_CONNECT_STATE_COOKIE);
  if(!binder||!/^[a-f0-9]{64}$/.test(binder)) throw new ApiError(403,'OAUTH_BROWSER_REQUIRED','Restart the Cloudflare connection in the browser where you began.');
  const record=await service(env).connectionStore(null,'state-consume',{id:await sha(state),browserHash:await sha(binder)}) as CloudflareOAuthState;
  const pending=JSON.parse(await decryptAuth(record.encrypted,env.AUTH_ENCRYPTION_KEY,`cloudflare-state:${record.id}`)) as Pending;
  if(pending.redirectUri!==`${url.origin}${url.pathname}`) throw new ApiError(403,'OAUTH_REDIRECT_MISMATCH','The callback does not match the original installation.');
  if(pending.repositoryId!==record.repositoryId||pending.grantId!==record.grantId) throw new ApiError(403,'CLOUDFLARE_STATE_INVALID','The connection request has expired. Start again.');
  if(url.searchParams.has('error')) throw new ApiError(400,'CLOUDFLARE_AUTHORIZATION_DENIED','Cloudflare authorization was cancelled or denied.');
  const code=requireString(url.searchParams.get('code'),'Authorization code',4096);
  const exchanged=await exchangeCloudflareCode(env,code,pending.redirectUri,pending.verifier,'connect',pending.extraScopes);
  const slot:Slot=record.grantId?{grantId:record.grantId}:repositorySlot(record.repositoryId);
  const reachable=await cloudflareAccounts(env,exchanged).catch(()=>[] as Account[]);
  const earlier=pending.expectedVersion?await stored(env,record.principal,undefined,slot).then(found=>found?unseal(env,record.principal,found,slot):undefined).catch(()=>undefined):undefined;
  const chosen=reachable.find(account=>account.id===earlier?.account?.id)??(reachable.length===1?reachable[0]:undefined);
  const vault=chosen?{...exchanged,account:chosen}:exchanged;
  await save(env,record.principal,vault,pending.expectedVersion,undefined,slot);
  if(record.grantId&&chosen){
    const overview=await service(env).connectionStore(record.principal,'accounts',{}) as CloudflareAccountsOverview;
    if(!overview.accounts.some(account=>account.id===chosen.id)) await service(env).connectionStore(record.principal,'account-put',{grantId:record.grantId,account:chosen});
  }
  const destination=record.repositoryId?`/repository/${encodeURIComponent(record.repositoryId)}/cloudflare`:record.grantId?`/settings/cloudflare?connected=${encodeURIComponent(record.grantId)}`:'/settings/cloudflare';
  return new Response(null,{status:303,headers:{Location:`${url.origin}${destination}`,'Set-Cookie':`${CLOUDFLARE_CONNECT_STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
}
async function resourceCatalog(env:AppEnv,vault:Vault,source:CloudflareConnectionSource,includeGitflare=false) {
  const account=selectedAccount(vault,source);
  const kinds = [ ['workers', '/workers/scripts'], ['durableObjects', '/workers/durable_objects/namespaces'], ['databases', '/d1/database'], ['containers', '/containers/applications'], ['workflows', '/workflows'] ] as const;
  const results = await Promise.allSettled(kinds.map(([, path]) => listResources(env, vault, path)));
  const catalogs: Record<string, { id: string; name: string; script?: string; gitflare?: true }[]> = {};
  const availability: Record<string, { available: boolean; reason?: string }> = {};
  results.forEach((result, index) => {
    const [kind] = kinds[index];
    catalogs[kind] = [];
    availability[kind] = { available: result.status === 'fulfilled', ...(result.status === 'rejected' ? { reason: result.reason instanceof ApiError ? result.reason.detail : 'This resource catalog is unavailable. Check the connection permissions and try again.' } : {}) };
    if (result.status === 'fulfilled') catalogs[kind] = result.value.flatMap(value => {
      if (!value || typeof value !== 'object') return [];
      const item = value as Record<string, unknown>;
      const id = kind === 'workflows' ? item.name : item.id ?? item.uuid ?? item.name;
      const name = item.name ?? item.id ?? item.uuid;
      return typeof id === 'string' && typeof name === 'string' ? [{ id, name: name.slice(0, 200), ...(typeof item.script === 'string' ? { script: item.script } : typeof item.script_name === 'string' ? { script: item.script_name } : {}) }] : [];
    });
  });
  const installation = !!env.PREVIEWS_ACCOUNT_ID && env.PREVIEWS_ACCOUNT_ID === account.id;
  let gitflareHidden = 0;
  if (installation) {
    const infrastructure = gitflareInfrastructure(env.GITFLARE_PRIMARY_WORKER, env.PREVIEWS_WORKER_NAME);
    const types: Record<string, CatalogItem['type']> = { workers: 'worker', durableObjects: 'durable_object', databases: 'd1', containers: 'container', workflows: 'workflow' };
    for (const [kind, items] of Object.entries(catalogs)) catalogs[kind] = items.flatMap(item => {
      if (!isGitflareResource({ ...item, type: types[kind]! }, infrastructure)) return [item];
      if (includeGitflare) return [{ ...item, gitflare: true as const }];
      gitflareHidden++;
      return [];
    });
  }
  return { account, ...catalogs, availability, installation, gitflareHidden };
}
async function disconnect(env:AppEnv,p:Principal,repositoryId?:string) {
  const removed=await service(env).connectionStore(p,'delete',repositoryScope(repositoryId)) as CloudflareConnection|null;
  if(!removed)return {connected:false,revoked:true};
  let revoked:boolean;
  try { revoked=await revokeCloudflareTokens(env,await unseal(env,p,removed,repositorySlot(repositoryId))); }catch{revoked=false;}
  return {connected:false,revoked};
}
const GRANT_ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function requireGrantId(value: unknown): string { if(typeof value!=='string'||!GRANT_ID.test(value)) throw new ApiError(404,'CLOUDFLARE_LOGIN_NOT_FOUND','This Cloudflare login could not be found.'); return value; }
function grantSlot(grantId: unknown): Slot { return grantId===undefined||grantId===null?{}:{grantId:requireGrantId(grantId)}; }
function connectedAccounts(env:AppEnv,p:Principal) { return service(env).connectionStore(p,'accounts',{}) as Promise<CloudflareAccountsOverview>; }
async function loginAccounts(env:AppEnv,p:Principal,grantId:unknown) {
  const {vault}=await load(env,p,undefined,grantSlot(grantId));
  const connected=new Set((await connectedAccounts(env,p)).accounts.map(account=>account.id));
  return {accounts:(await cloudflareAccounts(env,vault)).map(account=>({...account,connected:connected.has(account.id)}))};
}
async function putAccount(env:AppEnv,p:Principal,body:Record<string,unknown>) {
  const slot=grantSlot(body.grantId);
  const accountId=requireString(body.accountId,'Cloudflare account',32,32);
  const {vault}=await load(env,p,undefined,slot);
  const account=(await cloudflareAccounts(env,vault)).find(item=>item.id===accountId);
  if(!account) throw new ApiError(403,'ACCOUNT_NOT_GRANTED','This Cloudflare login cannot reach that account. Choose an account it lists.');
  await service(env).connectionStore(p,'account-put',{...slotScope(slot),account});
  return connectedAccounts(env,p);
}
async function removeAccount(env:AppEnv,p:Principal,body:Record<string,unknown>) {
  const accountId=requireString(body.accountId,'Cloudflare account',32,32);
  const removed=await service(env).connectionStore(p,'account-remove',{accountId}) as {connection:CloudflareConnection|null;grantId:string|null};
  let revoked=false;
  if(removed.connection&&removed.grantId) { try { revoked=await revokeCloudflareTokens(env,await unseal(env,p,removed.connection,{grantId:removed.grantId})); } catch { revoked=false; } }
  return {...await connectedAccounts(env,p),loginRemoved:!!removed.connection,revoked};
}
async function defaultAccount(env:AppEnv,p:Principal,body:Record<string,unknown>) {
  const accountId=requireString(body.accountId,'Cloudflare account',32,32);
  const overview=await connectedAccounts(env,p);
  const entry=overview.accounts.find(account=>account.id===accountId);
  if(!entry) throw new ApiError(409,'ACCOUNT_NOT_CONNECTED',`Cloudflare account ${accountId} is not connected to this workspace. An Owner must add it in Settings → Cloudflare first.`);
  const current=await stored(env,p);
  if(!current) throw new ApiError(409,'CLOUDFLARE_NOT_CONNECTED','Connect a Cloudflare account first.');
  const currentVault=await unseal(env,p,current);
  const account={id:entry.id,name:entry.name};
  if(!entry.grantId) {
    await service(env).connectionStore(p,'account-default',{accountId,expectedVersion:current.version,value:await seal(env,p,{...currentVault,account},current.issuer,{})});
    return connectedAccounts(env,p);
  }
  const grant=await stored(env,p,undefined,{grantId:entry.grantId});
  if(!grant) throw new ApiError(409,'CLOUDFLARE_CONNECTION_CHANGED','The Cloudflare connection changed. Refresh and try again.');
  const grantVault=await unseal(env,p,grant,{grantId:entry.grantId});
  await service(env).connectionStore(p,'account-default',{accountId,expectedVersion:current.version,expectedGrantVersion:grant.version,value:await seal(env,p,{...grantVault,account},grant.issuer,{}),grantValue:await seal(env,p,currentVault,current.issuer,{grantId:entry.grantId})});
  return connectedAccounts(env,p);
}
async function disconnectLogin(env:AppEnv,p:Principal,grantId:string) {
  const removed=await service(env).connectionStore(p,'delete',{grantId}) as CloudflareConnection|null;
  let revoked=!removed;
  if(removed) { try { revoked=await revokeCloudflareTokens(env,await unseal(env,p,removed,{grantId})); } catch { revoked=false; } }
  return {...await connectedAccounts(env,p),revoked};
}
async function accountsResponse(request:Request,env:AppEnv,p:Principal,path:string):Promise<Response|null> {
  const origin=new URL(request.url).origin;
  const login=/^\/api\/cloudflare\/logins\/([^/]+)\/(accounts|disconnect)$/.exec(path);
  const json=(value:unknown)=>Response.json(value,{headers:{'Cache-Control':'no-store'}});
  if(path==='/api/cloudflare/logins'&&request.method==='POST') {
    assertMutationOrigin(request);const body=await readJson(request);
    if(!await stored(env,p)) throw new ApiError(409,'CLOUDFLARE_NOT_CONNECTED','Connect Cloudflare first; another login adds accounts to an existing connection.');
    const features=requestedFeatures(body.features);const grantId=crypto.randomUUID();
    const {cookie,...result}=await start(env,p,origin,undefined,{grantId,...(features?{features}:{})});
    return Response.json({...result,grantId},{headers:{'Set-Cookie':cookie,'Cache-Control':'no-store'}});
  }
  if(login&&login[2]==='accounts'&&request.method==='GET') return json(await loginAccounts(env,p,login[1]));
  if(login&&login[2]==='disconnect'&&request.method==='POST') { assertMutationOrigin(request); return json(await disconnectLogin(env,p,requireGrantId(login[1]))); }
  const action=path.slice('/api/cloudflare/'.length);
  if(!['account-put','account-remove','account-default'].includes(action)) return null;
  if(request.method!=='POST') throw new ApiError(405,'METHOD_NOT_ALLOWED','Use POST for Cloudflare account changes.');
  assertMutationOrigin(request);const body=await readJson(request);
  return json(action==='account-put'?await putAccount(env,p,body):action==='account-remove'?await removeAccount(env,p,body):await defaultAccount(env,p,body));
}
async function selectAccount(env:AppEnv,p:Principal,body:Record<string,unknown>,repositoryId?:string) {
  const {record,vault}=await load(env,p,undefined,repositorySlot(repositoryId));
  const accountId=requireString(body.accountId,'Cloudflare account',32,32);
  const account=accountsValue(await api(env,vault,'/accounts')).find(a=>a.id===accountId);
  if(!account) throw new ApiError(403,'ACCOUNT_NOT_GRANTED','Select an account granted by this Cloudflare authorization.');
  await save(env,p,{...vault,account},record.version,record.issuer,repositorySlot(repositoryId));
  return status(env,{...vault,account});
}
async function repositoryStatus(env:AppEnv,p:Principal,repositoryId:string,requested?:CloudflareFeature[]) {
  const own=await stored(env,p,undefined,repositorySlot(repositoryId));
  if(own) return {source:'repository' as const,...status(env,await unseal(env,p,own,repositorySlot(repositoryId)),requested)};
  const workspace=await stored(env,p);
  return {source:workspace?'workspace' as const:'none' as const,...status(env,workspace?await unseal(env,p,workspace):undefined,requested)};
}
async function dispatchRepository(env:AppEnv,p:Principal,action:string,body:Record<string,unknown>,origin:string,repositoryId:string):Promise<unknown> {
  if(action==='status') return repositoryStatus(env,p,repositoryId,requestedFeatures(body.features));
  if(action==='connect') return {browserStartUrl:`${new URL(origin).origin}/repository/${encodeURIComponent(repositoryId)}/cloudflare`,browserAuthorizationRequired:true,permissions:connectPermissionPlan(env)};
  if(action==='disconnect') return disconnect(env,p,repositoryId);
  if(action==='accounts') {const {vault}=await load(env,p,undefined,repositorySlot(repositoryId));return {accounts:accountsValue(await api(env,vault,'/accounts'))};}
  if(action==='select-account') return {source:'repository',...await selectAccount(env,p,body,repositoryId)};
  if(action==='resources') {const {vault,source}=await loadPreferred(env,p,undefined,repositoryId);return {source,...await resourceCatalog(env,vault,source,body.includeGitflare===true)};}
  throw new ApiError(404,'NOT_FOUND','This Cloudflare connection operation is unavailable.');
}
export async function dispatchCloudflare(env:AppEnv,p:Principal,action:string,body:Record<string,unknown>={},origin='',repositoryId?:string):Promise<unknown> {
  await owner(env,p);
  if(repositoryId!==undefined) return dispatchRepository(env,p,action,body,origin,requireRepositoryId(repositoryId));
  if(action==='status') {const record=await stored(env,p);return status(env,record?await unseal(env,p,record):undefined,requestedFeatures(body.features));}
  if(action==='connect') return {browserStartUrl:`${new URL(origin).origin}/settings/cloudflare`,browserAuthorizationRequired:true,permissions:connectPermissionPlan(env)};
  if(action==='disconnect') return disconnect(env,p);
  if(action==='select-account') return selectAccount(env,p,body);
  const {vault}=await load(env,p);
  if(action==='accounts') return {accounts:accountsValue(await api(env,vault,'/accounts'))};
  if(action==='resources') return resourceCatalog(env,vault,'workspace',body.includeGitflare===true);
  throw new ApiError(404,'NOT_FOUND','This Cloudflare connection operation is unavailable.');
}
async function connectionResponse(request:Request,env:AppEnv,p:Principal,action:string,repositoryId?:string):Promise<Response> {
  const origin=new URL(request.url).origin;
  if(request.method==='POST') {
    assertMutationOrigin(request);const body=await readJson(request);
    if(action==='connect'){const features=requestedFeatures(body.features);const {cookie,...result}=await start(env,p,origin,repositoryId,{secrets:body.secrets===true,...(features?{features}:{})});return Response.json(result,{headers:{'Set-Cookie':cookie,'Cache-Control':'no-store'}});}
    if(!['disconnect','select-account'].includes(action))throw new ApiError(405,'METHOD_NOT_ALLOWED','Use a supported Cloudflare connection action.');
    return Response.json(await dispatchCloudflare(env,p,action,body,origin,repositoryId),{headers:{'Cache-Control':'no-store'}});
  }
  if(request.method!=='GET'||!['status','accounts','resources'].includes(action))throw new ApiError(405,'METHOD_NOT_ALLOWED','Use a supported Cloudflare connection action.');
  const query=new URL(request.url).searchParams;
  const includeGitflare=query.get('includeGitflare')==='true';
  const features=query.has('features')?query.get('features')!.split(',').filter(Boolean):undefined;
  return Response.json(await dispatchCloudflare(env,p,action,{...(includeGitflare?{includeGitflare}:{}),...(features?{features}:{})},origin,repositoryId),{headers:{'Cache-Control':'no-store'}});
}
export async function handleCloudflare(request:Request,env:AppEnv,authenticate:(request:Request,env:AppEnv)=>Promise<Principal>):Promise<Response|null> {
  const url=new URL(request.url);const path=url.pathname;if(!path.startsWith('/api/cloudflare'))return null;
  if(path===CLOUDFLARE_CALLBACK_PATH&&request.method==='GET'&&!requestCookie(request,CLOUDFLARE_CONNECT_STATE_COOKIE))return null;
  if(path===CLOUDFLARE_CALLBACK_PATH&&request.method==='GET')return callback(request,env);
  const p=await authenticate(request,env);
  if(path==='/api/cloudflare/connected-accounts') {
    if(request.method!=='GET') throw new ApiError(405,'METHOD_NOT_ALLOWED','Use GET to read connected Cloudflare accounts.');
    if(p.credentialId) throw new ApiError(403,'OWNER_REQUIRED','Task credentials cannot read Cloudflare connections.');
    await service(env).rateLimit(`cloudflare:${p.userId}`,30,60000);
    return Response.json(await connectedAccounts(env,p),{headers:{'Cache-Control':'no-store'}});
  }
  await owner(env,p);await service(env).rateLimit(`cloudflare:${p.userId}`,30,60000);
  const accounts=await accountsResponse(request,env,p,path);
  if(accounts)return accounts;
  const credential=/^\/api\/cloudflare\/installation-credential(?:\/([a-z-]+))?$/.exec(path);
  if(credential)return handleInstallationCredential(request,env,p,credential[1]??'');
  return connectionResponse(request,env,p,path==='/api/cloudflare'?'status':path.slice('/api/cloudflare/'.length));
}
export async function handleRepositoryCloudflare(request:Request,env:AppEnv,p:Principal,repositoryId:string,action='status'):Promise<Response> {
  await owner(env,p);await service(env).rateLimit(`cloudflare:${p.userId}`,30,60000);
  return connectionResponse(request,env,p,action,requireRepositoryId(repositoryId));
}
