import type { Repository } from '../shared/types';
import type { GitHubMirrorSnapshot, GitHubMirrorView, MirrorError, MirrorRefStatus, MirrorSyncStatus } from '../shared/github-mirror';
import type { ArtifactsBinding } from './artifacts';
import { ApiError, assertMutationOrigin, readJson, requireIdempotencyKey } from './domain';
import { decryptAuth, encryptAuth } from './mfa';
import { remoteDetails } from './repository-import';
import { advertise, basicAuthorization, transferRefs, ZERO_SHA, type GitRemote, type RefCommand } from './git-transfer';
import { githubAppConfig, githubAppInstallUrl, githubInstallationToken, type GitHubAppEnv } from './github-app';
import type { Action, Principal } from './security';
import type { StepRunner } from './background-work';
import { validGitSha } from './artifacts';

export const GITHUB_ORIGIN = 'https://github.com';
const STORE_KEY = 'github-mirror';
const MAX_PATTERNS = 20;
const SYNC_LEASE_MS = 15 * 60_000;
const ANCESTRY_DEPTH = 1000;
const MAX_SYNC_PASSES = 3;
export const MIRROR_RETRIES = 6;

export interface StoredPatCredential { kind: 'pat'; encrypted: string; setBy: string; setAt: string; authorizedBy: Principal }
export interface StoredAppCredential { kind: 'app'; installationId: number; setBy: string; setAt: string; authorizedBy: Principal }
export type StoredMirrorCredential = StoredPatCredential | StoredAppCredential;
interface StoredSync extends MirrorSyncStatus { lock?: { runId: string; expiresAt: number }; pending?: boolean }
export interface StoredMirror {
  owner: string;
  name: string;
  refPatterns: string[];
  credential: StoredMirrorCredential | null;
  linkedBy: string;
  linkedAt: string;
  updatedAt: string;
  adoptedAt?: string;
  adoptRequestId?: string;
  refs: Record<string, MirrorRefStatus>;
  sync: StoredSync;
}

export type MirrorChange =
  | { kind: 'link'; owner: string; name: string; refPatterns: string[]; actor: string; now: string }
  | { kind: 'credential'; credential: StoredMirrorCredential | null; now: string }
  | { kind: 'unlink' }
  | { kind: 'begin'; runId: string; reason: string; now: number }
  | { kind: 'refs'; runId: string; refs: MirrorRefStatus[]; removed: string[] }
  | { kind: 'end'; runId: string; sync: MirrorSyncStatus }
  | { kind: 'imported'; ref: string; branch: string; now: string }
  | { kind: 'adopted'; refs: MirrorRefStatus[]; requestId: string; now: string };
export interface MirrorChangeResult { mirror: StoredMirror | null; acquired?: boolean; pending?: boolean }
export interface MirrorStore { get<T>(key: string): T | undefined; put<T>(key: string, value: T): void; delete(key: string): void }

export interface MirrorRecords {
  githubMirror(): Promise<StoredMirror | null | undefined>;
  changeGithubMirror(change: MirrorChange): Promise<MirrorChangeResult>;
}

export function applyMirrorChange(store: MirrorStore, change: MirrorChange): MirrorChangeResult {
  const current = store.get<StoredMirror>(STORE_KEY) ?? null;
  const save = (mirror: StoredMirror, extra: Omit<MirrorChangeResult, 'mirror'> = {}): MirrorChangeResult => { store.put(STORE_KEY, mirror); return { mirror, ...extra }; };
  if (change.kind === 'link') {
    const sameTarget = current && current.owner.toLowerCase() === change.owner.toLowerCase() && current.name.toLowerCase() === change.name.toLowerCase();
    if (current && sameTarget) return save({ ...current, owner: change.owner, name: change.name, refPatterns: change.refPatterns, updatedAt: change.now, refs: Object.fromEntries(Object.entries(current.refs).filter(([ref]) => matchesPatterns(ref, change.refPatterns))) });
    return save({ owner: change.owner, name: change.name, refPatterns: change.refPatterns, credential: current?.credential ?? null, linkedBy: change.actor, linkedAt: change.now, updatedAt: change.now, refs: {}, sync: { state: 'idle' } });
  }
  if (change.kind === 'unlink') { store.delete(STORE_KEY); return { mirror: null }; }
  if (!current) return { mirror: null, acquired: false };
  if (change.kind === 'credential') return save({ ...current, credential: change.credential, updatedAt: change.now, sync: { ...current.sync, ...(current.sync.state === 'failed' ? { state: 'idle', error: undefined } : {}) } });
  if (change.kind === 'begin') {
    const lock = current.sync.lock;
    if (lock && lock.expiresAt > change.now && lock.runId !== change.runId) return save({ ...current, sync: { ...current.sync, pending: true } }, { acquired: false });
    return save({ ...current, sync: { ...current.sync, state: 'running', reason: change.reason, lastRunAt: new Date(change.now).toISOString(), lock: { runId: change.runId, expiresAt: change.now + SYNC_LEASE_MS }, pending: false } }, { acquired: true });
  }
  if (change.kind === 'refs') {
    if (current.sync.lock?.runId !== change.runId) return { mirror: current, acquired: false };
    const refs = { ...current.refs };
    for (const ref of change.removed) delete refs[ref];
    for (const status of change.refs) refs[status.ref] = status;
    return save({ ...current, refs }, { acquired: true });
  }
  if (change.kind === 'end') {
    if (current.sync.lock && current.sync.lock.runId !== change.runId) return { mirror: current, pending: false };
    const pending = !!current.sync.pending;
    return save({ ...current, sync: { ...change.sync, lastRunAt: current.sync.lastRunAt, lastSuccessAt: change.sync.lastSuccessAt ?? current.sync.lastSuccessAt } }, { pending });
  }
  if (change.kind === 'imported') {
    const prior = current.refs[change.ref];
    if (!prior) return { mirror: current };
    return save({ ...current, refs: { ...current.refs, [change.ref]: { ...prior, importedBranch: change.branch, updatedAt: change.now } } });
  }
  const refs = { ...current.refs };
  for (const status of change.refs) refs[status.ref] = status;
  return save({ ...current, refs, adoptedAt: change.now, adoptRequestId: change.requestId, updatedAt: change.now });
}

export function defaultRefPatterns(defaultBranch: string): string[] { return [`refs/heads/${defaultBranch}`, 'refs/tags/*']; }

export function githubTarget(ownerValue: unknown, nameValue: unknown): { owner: string; name: string } {
  const owner = typeof ownerValue === 'string' ? ownerValue.trim() : '';
  const name = typeof nameValue === 'string' ? nameValue.trim().replace(/\.git$/i, '') : '';
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) throw new ApiError(400, 'INVALID_GITHUB_REPOSITORY', 'Enter the GitHub owner (user or organization) exactly as it appears in the repository URL.');
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') throw new ApiError(400, 'INVALID_GITHUB_REPOSITORY', 'Enter the GitHub repository name using letters, numbers, dots, hyphens and underscores.');
  return { owner, name };
}

export function parseRefPatterns(value: unknown, defaultBranch: string): string[] {
  if (value === undefined || value === null) return defaultRefPatterns(defaultBranch);
  if (!Array.isArray(value) || !value.length || value.length > MAX_PATTERNS) throw new ApiError(400, 'INVALID_REF_PATTERNS', `List 1 to ${MAX_PATTERNS} ref patterns, such as refs/heads/main or refs/tags/*.`);
  const patterns = value.map(item => typeof item === 'string' ? item.trim() : '');
  for (const pattern of patterns) if (!/^refs\/(heads|tags)\/[A-Za-z0-9._/*-]{1,200}$/.test(pattern) || pattern.includes('..') || pattern.includes('//') || pattern.endsWith('/') || pattern.endsWith('.lock')) throw new ApiError(400, 'INVALID_REF_PATTERNS', `${pattern || 'An empty pattern'} is not a ref pattern. Use refs/heads/<branch> or refs/tags/<tag>, with * as a wildcard.`);
  return [...new Set(patterns)];
}

export function matchesPatterns(ref: string, patterns: string[]): boolean {
  return patterns.some(pattern => new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(ref));
}

export function patToken(value: unknown): string {
  if (typeof value !== 'string' || !/^(github_pat_[A-Za-z0-9_]{20,255}|gh[pousr]_[A-Za-z0-9]{20,255})$/.test(value.trim())) throw new ApiError(400, 'INVALID_GITHUB_TOKEN', 'Paste a GitHub fine-grained personal access token (github_pat_…) exactly as GitHub shows it.');
  return value.trim();
}

function installationId(value: unknown): number {
  const id = typeof value === 'string' && /^\d{1,12}$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new ApiError(400, 'INVALID_GITHUB_INSTALLATION', 'Enter the numeric GitHub App installation ID.');
  return id;
}

export function credentialContext(workspaceId: string, repositoryId: string): string { return `github-mirror:${workspaceId}:${repositoryId}`; }

export function mirrorView(mirror: StoredMirror): GitHubMirrorView {
  const refs = Object.values(mirror.refs).sort((a, b) => a.ref.localeCompare(b.ref));
  const credential = mirror.credential ? { kind: mirror.credential.kind, ...(mirror.credential.kind === 'app' ? { installationId: mirror.credential.installationId } : {}), setBy: mirror.credential.setBy, setAt: mirror.credential.setAt } : null;
  const { lock: _lock, pending: _pending, ...sync } = mirror.sync;
  return { owner: mirror.owner, name: mirror.name, url: `${GITHUB_ORIGIN}/${mirror.owner}/${mirror.name}`, refPatterns: mirror.refPatterns, credential, linkedBy: mirror.linkedBy, linkedAt: mirror.linkedAt, updatedAt: mirror.updatedAt, ...(mirror.adoptedAt ? { adoptedAt: mirror.adoptedAt } : {}), sync, refs, diverged: refs.some(ref => ref.state === 'diverged') };
}

export interface MirrorRemotes {
  gitflare(scope: 'read' | 'write'): Promise<{ remote: GitRemote; release(): Promise<void> }>;
  github(mirror: StoredMirror): Promise<GitRemote>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  fetcher?: typeof fetch;
}

export interface SyncOverride { ref: string; expectedGithubSha: string | null }
export interface SyncFailure { ref: string; reason: string; retryable: boolean }
export interface SyncResult { refs: MirrorRefStatus[]; removed: string[]; pushed: string[]; diverged: string[]; failed: SyncFailure[] }

const RETRYABLE_REJECTION = /stale info|failed to lock|cannot lock|fetch first|unpack failed|no status reported|try again/i;

function filtered(refs: Map<string, string>, patterns: string[]): Map<string, string> {
  return new Map([...refs].filter(([ref]) => matchesPatterns(ref, patterns)));
}

export async function syncMirror(mirror: StoredMirror, remotes: MirrorRemotes, now: string, override?: SyncOverride): Promise<SyncResult> {
  const fetcher = remotes.fetcher ?? fetch;
  const gitflare = await remotes.gitflare('read');
  try {
    const source = await advertise(gitflare.remote, 'git-upload-pack', fetcher);
    const github = await remotes.github(mirror);
    const target = await advertise(github, 'git-receive-pack', fetcher);
    const local = filtered(source.refs, mirror.refPatterns), remote = filtered(target.refs, mirror.refPatterns);
    const result: SyncResult = { refs: [], removed: [], pushed: [], diverged: [], failed: [] };
    const commands: RefCommand[] = [];
    const names = [...new Set([...local.keys(), ...remote.keys(), ...Object.keys(mirror.refs).filter(ref => matchesPatterns(ref, mirror.refPatterns))])].sort();
    for (const ref of names) {
      const localSha = local.get(ref) ?? null, githubSha = remote.get(ref) ?? null, prior = mirror.refs[ref], lease = prior?.lastSyncedSha ?? null;
      const status = (fields: Partial<MirrorRefStatus>): MirrorRefStatus => ({ ref, state: 'pending', gitflareSha: localSha, githubSha, lastSyncedSha: lease, ...(prior?.lastSyncedAt ? { lastSyncedAt: prior.lastSyncedAt } : {}), ...(prior?.importedBranch ? { importedBranch: prior.importedBranch } : {}), updatedAt: now, ...fields });
      if (localSha === githubSha) {
        if (localSha === null) result.removed.push(ref);
        else result.refs.push(status({ state: 'synced', lastSyncedSha: localSha, lastSyncedAt: prior?.lastSyncedSha === localSha && prior.lastSyncedAt ? prior.lastSyncedAt : now, importedBranch: undefined }));
        continue;
      }
      const forced = override?.ref === ref;
      if (forced && override.expectedGithubSha !== githubSha) {
        result.refs.push(status({ state: 'diverged', error: { code: 'GITHUB_CHANGED', message: 'GitHub moved after you reviewed it. Review the new GitHub commit before overwriting.' } }));
        result.diverged.push(ref);
        continue;
      }
      const safe = forced || githubSha === null || githubSha === lease || (localSha !== null && await remotes.isAncestor(githubSha, localSha));
      if (!safe) {
        result.refs.push(status({ state: 'diverged', error: { code: 'MIRROR_DIVERGED', message: localSha === null ? 'GitHub has this ref but Gitflare does not. Import it from GitHub or overwrite GitHub to delete it.' : 'GitHub has commits Gitflare does not. Import them from GitHub into a stream, or overwrite GitHub.' } }));
        result.diverged.push(ref);
        continue;
      }
      commands.push({ ref, oldSha: githubSha ?? ZERO_SHA, newSha: localSha ?? ZERO_SHA });
    }
    const outcomes = await transferRefs({ remote: gitflare.remote, advertised: source }, { remote: github, advertised: target }, commands, fetcher);
    for (const outcome of outcomes) {
      const command = commands.find(item => item.ref === outcome.ref)!;
      const prior = mirror.refs[outcome.ref];
      const localSha = command.newSha === ZERO_SHA ? null : command.newSha, githubSha = command.oldSha === ZERO_SHA ? null : command.oldSha;
      if (outcome.ok) {
        result.pushed.push(outcome.ref);
        if (localSha === null) result.removed.push(outcome.ref);
        else result.refs.push({ ref: outcome.ref, state: 'synced', gitflareSha: localSha, githubSha: localSha, lastSyncedSha: localSha, lastSyncedAt: now, updatedAt: now });
      } else {
        const retryable = RETRYABLE_REJECTION.test(outcome.reason);
        result.failed.push({ ref: outcome.ref, reason: outcome.reason, retryable });
        result.refs.push({ ref: outcome.ref, state: 'failed', gitflareSha: localSha, githubSha, lastSyncedSha: prior?.lastSyncedSha ?? null, ...(prior?.lastSyncedAt ? { lastSyncedAt: prior.lastSyncedAt } : {}), error: { code: 'GITHUB_REJECTED', message: `GitHub rejected the update: ${outcome.reason}` }, updatedAt: now });
      }
    }
    return result;
  } finally { await gitflare.release(); }
}

function importTarget(ref: string, sha: string): string {
  const short = ref.replace(/^refs\/(heads|tags)\//, '').replace(/[^A-Za-z0-9._/-]/g, '-').replace(/\/+/g, '-').slice(0, 80);
  return ref.startsWith('refs/tags/') ? `refs/tags/github-import/${short}-${sha.slice(0, 7)}` : `refs/heads/github-import/${short}-${sha.slice(0, 7)}`;
}

export async function importFromGithub(mirror: StoredMirror, ref: string, remotes: MirrorRemotes): Promise<{ ref: string; branch: string; sha: string }> {
  if (!matchesPatterns(ref, mirror.refPatterns)) throw new ApiError(400, 'REF_NOT_MIRRORED', 'This ref is not one of the mirrored ref patterns.');
  const fetcher = remotes.fetcher ?? fetch;
  const github = await remotes.github(mirror);
  const source = await advertise(github, 'git-upload-pack', fetcher);
  const sha = source.refs.get(ref);
  if (!sha) throw new ApiError(404, 'GITHUB_REF_NOT_FOUND', 'GitHub no longer has this ref.');
  const target = importTarget(ref, sha);
  const gitflare = await remotes.gitflare('write');
  try {
    const destination = await advertise(gitflare.remote, 'git-receive-pack', fetcher);
    const existing = destination.refs.get(target);
    if (existing === sha) return { ref, branch: target, sha };
    if (existing) throw new ApiError(409, 'IMPORT_TARGET_EXISTS', `${target} already exists with different content. Delete it before importing again.`);
    const [outcome] = await transferRefs({ remote: github, advertised: source }, { remote: gitflare.remote, advertised: destination }, [{ ref: target, oldSha: ZERO_SHA, newSha: sha }], fetcher);
    if (!outcome?.ok) throw new ApiError(502, 'MIRROR_IMPORT_FAILED', `Gitflare storage rejected the import: ${outcome && !outcome.ok ? outcome.reason : 'no status'}.`);
    return { ref, branch: target, sha };
  } finally { await gitflare.release(); }
}

export async function adoptFromGithub(mirror: StoredMirror, defaultBranch: string, remotes: MirrorRemotes, now: string): Promise<{ refs: MirrorRefStatus[]; headSha: string }> {
  const fetcher = remotes.fetcher ?? fetch;
  const github = await remotes.github(mirror);
  const source = await advertise(github, 'git-upload-pack', fetcher);
  const remote = filtered(source.refs, mirror.refPatterns);
  const headSha = remote.get(`refs/heads/${defaultBranch}`);
  if (!headSha) throw new ApiError(409, 'ADOPT_NO_DEFAULT_BRANCH', `GitHub has no ${defaultBranch} branch to adopt. Mirror patterns must include the default branch.`);
  const gitflare = await remotes.gitflare('write');
  try {
    const destination = await advertise(gitflare.remote, 'git-receive-pack', fetcher);
    const commands = [...remote].filter(([ref, sha]) => destination.refs.get(ref) !== sha).map(([ref, sha]) => ({ ref, oldSha: destination.refs.get(ref) ?? ZERO_SHA, newSha: sha }));
    const ordered = [...commands.filter(command => command.ref === `refs/heads/${defaultBranch}`), ...commands.filter(command => command.ref !== `refs/heads/${defaultBranch}`)];
    const outcomes = await transferRefs({ remote: github, advertised: source }, { remote: gitflare.remote, advertised: destination }, ordered, fetcher);
    const rejected = outcomes.filter(outcome => !outcome.ok);
    if (rejected.length) throw new ApiError(502, 'MIRROR_ADOPT_FAILED', `Gitflare storage rejected ${rejected.map(outcome => outcome.ref).join(', ').slice(0, 300)}.`);
    return { refs: [...remote].map(([ref, sha]) => ({ ref, state: 'synced', gitflareSha: sha, githubSha: sha, lastSyncedSha: sha, lastSyncedAt: now, updatedAt: now })), headSha };
  } finally { await gitflare.release(); }
}

export interface MirrorEnv extends GitHubAppEnv {
  AUTH_ENCRYPTION_KEY?: string;
  ARTIFACTS?: ArtifactsBinding;
}

export function mirrorRemotes(env: MirrorEnv, repository: Repository, fetcher: typeof fetch = fetch): MirrorRemotes {
  return {
    fetcher,
    async gitflare(scope) {
      if (!env.ARTIFACTS || repository.provider !== 'artifacts') throw new ApiError(409, 'REPOSITORY_NOT_CONNECTED', 'Connect Git storage before mirroring.');
      const source = await env.ARTIFACTS.get(repository.name);
      try {
        const { base } = remoteDetails(await source.info());
        const token = await source.createToken(scope, 900);
        return {
          remote: { url: base, authorization: `Bearer ${token.plaintext}`, label: 'Gitflare storage' },
          release: async () => { try { await source.revokeToken(token.plaintext); } catch { console.warn(JSON.stringify({ event: 'github_mirror_token_revoke_failed', repositoryId: repository.id })); } finally { source[Symbol.dispose]?.(); } },
        };
      } catch (error) { source[Symbol.dispose]?.(); throw error; }
    },
    async github(mirror) {
      if (!mirror.credential) throw new ApiError(412, 'MIRROR_CREDENTIAL_MISSING', 'Add a GitHub credential to the mirror first.');
      const url = `${GITHUB_ORIGIN}/${mirror.owner}/${mirror.name}.git`;
      if (mirror.credential.kind === 'pat') return { url, authorization: basicAuthorization(await decryptAuth(mirror.credential.encrypted, env.AUTH_ENCRYPTION_KEY, credentialContext(mirror.credential.authorizedBy.workspaceId, repository.id))), label: 'GitHub' };
      const config = githubAppConfig(env);
      if (!config) throw new ApiError(503, 'GITHUB_APP_NOT_CONFIGURED', 'This installation has no GitHub App configured. Use a fine-grained personal access token instead.');
      return { url, authorization: basicAuthorization(await githubInstallationToken(config, mirror.credential.installationId, mirror.name, fetcher)), label: 'GitHub' };
    },
    async isAncestor(ancestor, descendant) {
      if (!env.ARTIFACTS) return false;
      try {
        using source = await env.ARTIFACTS.get(repository.name);
        return (await source.log({ ref: descendant, limit: ANCESTRY_DEPTH })).some(commit => commit.hash === ancestor);
      } catch { return false; }
    },
  };
}

export interface MirrorAuthority { check(principal: Principal, action: Action, resourceType?: string, resourceId?: string): Promise<void> }

export interface MirrorRunContext {
  records: MirrorRecords;
  remotes: MirrorRemotes;
  authority: MirrorAuthority;
  repositoryId: string;
}

export interface MirrorRunOutcome { state: 'skipped' | 'queued' | 'synced' | 'diverged' | 'failed' | 'retrying'; pushed: number; diverged: string[]; error?: MirrorError }

function retryableError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status >= 500 && !['AUTH_ENCRYPTION_REQUIRED', 'AUTH_ENCRYPTION_FAILED', 'GITHUB_APP_NOT_CONFIGURED', 'GITHUB_APP_MISCONFIGURED'].includes(error.code) || error.code === 'MIRROR_UNREACHABLE';
}

function mirrorError(error: unknown): MirrorError {
  if (error instanceof ApiError) return { code: error.code, message: error.detail };
  return { code: 'MIRROR_FAILED', message: 'The mirror sync stopped unexpectedly. It will retry.' };
}

async function assertAuthority(context: MirrorRunContext, mirror: StoredMirror): Promise<void> {
  const principal = mirror.credential?.authorizedBy;
  if (!principal) throw new ApiError(412, 'MIRROR_CREDENTIAL_MISSING', 'Add a GitHub credential to the mirror first.');
  try { await context.authority.check(principal, 'manage', 'repository', context.repositoryId); }
  catch { throw new ApiError(403, 'MIRROR_AUTHORITY_REVOKED', 'The Owner who added the GitHub credential no longer manages this repository. An Owner must add the credential again.'); }
}

export async function runMirrorSync(context: MirrorRunContext, options: { runId: string; reason: string; override?: SyncOverride; now?: () => number }): Promise<MirrorRunOutcome> {
  const clock = options.now ?? Date.now;
  let outcome: MirrorRunOutcome = { state: 'skipped', pushed: 0, diverged: [] };
  for (let pass = 0; pass < MAX_SYNC_PASSES; pass++) {
    const begun = await context.records.changeGithubMirror({ kind: 'begin', runId: options.runId, reason: options.reason, now: clock() });
    if (!begun.mirror) return { state: 'skipped', pushed: 0, diverged: [] };
    if (!begun.acquired) return { state: 'queued', pushed: 0, diverged: [] };
    const mirror = begun.mirror;
    const previousAttempt = mirror.sync.attempt ?? 0;
    let sync: MirrorSyncStatus;
    try {
      await assertAuthority(context, mirror);
      const now = new Date(clock()).toISOString();
      const result = await syncMirror(mirror, context.remotes, now, pass === 0 ? options.override : undefined);
      await context.records.changeGithubMirror({ kind: 'refs', runId: options.runId, refs: result.refs, removed: result.removed });
      const retryable = result.failed.filter(failure => failure.retryable);
      if (retryable.length) {
        outcome = { state: 'retrying', pushed: result.pushed.length, diverged: result.diverged, error: { code: 'GITHUB_REJECTED', message: `GitHub rejected ${retryable.map(failure => failure.ref).join(', ')}; retrying.` } };
        sync = { state: 'retrying', attempt: previousAttempt + 1, error: outcome.error };
      } else if (result.failed.length) {
        outcome = { state: 'failed', pushed: result.pushed.length, diverged: result.diverged, error: { code: 'GITHUB_REJECTED', message: `GitHub rejected ${result.failed.map(failure => `${failure.ref} (${failure.reason})`).join(', ').slice(0, 400)}.` } };
        sync = { state: 'failed', error: outcome.error };
      } else {
        outcome = { state: result.diverged.length ? 'diverged' : 'synced', pushed: result.pushed.length, diverged: result.diverged };
        sync = { state: 'idle', lastSuccessAt: now };
      }
    } catch (error) {
      const retry = retryableError(error);
      outcome = { state: retry ? 'retrying' : 'failed', pushed: 0, diverged: [], error: mirrorError(error) };
      sync = retry ? { state: 'retrying', attempt: previousAttempt + 1, error: outcome.error } : { state: 'failed', error: outcome.error };
      console.warn(JSON.stringify({ event: 'github_mirror_sync_failed', repositoryId: context.repositoryId, code: outcome.error!.code, retry }));
    }
    const ended = await context.records.changeGithubMirror({ kind: 'end', runId: options.runId, sync: { ...sync, reason: options.reason } });
    if (outcome.state === 'retrying' || !ended.pending) return outcome;
  }
  return outcome;
}

export interface MirrorParams { kind: 'mirror'; repositoryId: string; workspaceId: string; reason: string; runId: string }
export const mirrorWorkflowId = (runId: string) => `mirror-${runId}`;

export class MirrorRetry extends Error {}

export async function runMirrorWorkflow(context: MirrorRunContext, params: MirrorParams, step: StepRunner): Promise<void> {
  try {
    await step.do('sync GitHub mirror', { retries: { limit: MIRROR_RETRIES, delay: '30 seconds', backoff: 'exponential' }, timeout: '10 minutes' }, async () => {
      const outcome = await runMirrorSync(context, { runId: params.runId, reason: params.reason });
      if (outcome.state === 'retrying') throw new MirrorRetry(outcome.error?.message ?? 'GitHub mirror sync will retry');
      return { state: outcome.state, pushed: outcome.pushed, diverged: outcome.diverged.length };
    });
  } catch {
    const begun = await context.records.changeGithubMirror({ kind: 'begin', runId: params.runId, reason: params.reason, now: Date.now() });
    if (begun.acquired) await context.records.changeGithubMirror({ kind: 'end', runId: params.runId, sync: { state: 'failed', reason: params.reason, error: begun.mirror?.sync.error ?? { code: 'MIRROR_RETRIES_EXHAUSTED', message: 'The mirror sync failed after retries. Choose Sync now to try again.' } } });
  }
}

export type MirrorDispatcher = (params: MirrorParams) => Promise<'running' | 'finished' | 'missing'>;

export async function scheduleMirrorSync(records: MirrorRecords, dispatch: MirrorDispatcher | null, inline: (params: MirrorParams) => Promise<unknown>, params: Omit<MirrorParams, 'kind' | 'runId'>, changedRefs?: string[]): Promise<boolean> {
  const mirror = await records.githubMirror();
  if (!mirror?.credential) return false;
  if (changedRefs && !changedRefs.some(ref => matchesPatterns(ref, mirror.refPatterns))) return false;
  const full: MirrorParams = { kind: 'mirror', ...params, runId: `${params.repositoryId}-${crypto.randomUUID()}` };
  if (dispatch && await dispatch(full) !== 'missing') return true;
  await inline(full);
  return true;
}

export interface MirrorAccess {
  authorize(principal: Principal, action: Action, resourceType?: string, resourceId?: string): Promise<void>;
  checkMany(principal: Principal, action: Action, resources: { resourceType: string; resourceId: string }[]): Promise<boolean[]>;
  rateLimit(key: string, max?: number, windowMs?: number): Promise<void>;
  auditRepositoryChange(principal: Principal, action: string, repositoryId: string): Promise<unknown>;
  installationCredentialAdmin(principal: Principal): Promise<boolean>;
}

export interface MirrorApiContext {
  env: MirrorEnv;
  repository: Repository;
  principal: Principal;
  access: MirrorAccess;
  records: MirrorRecords;
  remotes: MirrorRemotes;
  run: (options: { reason: string; override?: SyncOverride }) => Promise<MirrorRunOutcome>;
  schedule: (reason: string) => Promise<boolean>;
  freshRepository: () => Promise<boolean>;
  recordHead: (sha: string) => Promise<void>;
  fetcher?: typeof fetch;
}

const ACTIONS = ['link', 'credential', 'remove-credential', 'unlink', 'sync', 'overwrite', 'import', 'adopt'] as const;
type MirrorAction = typeof ACTIONS[number];

function durable({ userId, workspaceId, role, bootstrap }: Principal): Principal {
  return { userId, workspaceId, role, ...(bootstrap ? { bootstrap } : {}) };
}

async function snapshot(context: MirrorApiContext, canManage?: boolean): Promise<GitHubMirrorSnapshot> {
  const { principal, access, repository } = context;
  const manage = canManage ?? (principal.role === 'Owner' && !principal.credentialId && (await access.checkMany(principal, 'manage', [{ resourceType: 'repository', resourceId: repository.id }]))[0] === true);
  const config = githubAppConfig(context.env);
  const appAllowed = !!config && manage && await access.installationCredentialAdmin(principal).catch(() => false);
  const mirror = await context.records.githubMirror();
  return { repositoryId: repository.id, canManage: manage, defaultRefPatterns: defaultRefPatterns(repository.defaultBranch), app: { available: appAllowed, ...(appAllowed && githubAppInstallUrl(config) ? { installUrl: githubAppInstallUrl(config) } : {}) }, mirror: mirror ? mirrorView(mirror) : null };
}

async function requireOwner(context: MirrorApiContext): Promise<void> {
  const { principal, access, repository } = context;
  if (principal.role !== 'Owner' || principal.credentialId) throw new ApiError(403, 'OWNER_REQUIRED', 'Only workspace Owners can manage the GitHub mirror.');
  await access.authorize(principal, 'manage', 'repository', repository.id);
}

async function requireMirror(context: MirrorApiContext): Promise<StoredMirror> {
  const mirror = await context.records.githubMirror();
  if (!mirror) throw new ApiError(404, 'MIRROR_NOT_LINKED', 'Link this repository to a GitHub repository first.');
  return mirror;
}

const sha = (value: unknown, field: string): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string' || !validGitSha(value)) throw new ApiError(400, 'INVALID_COMMIT', `${field} must be the 40-character GitHub commit SHA shown in the mirror status, or null.`);
  return value;
};

const mirroredRef = (value: unknown): string => {
  if (typeof value !== 'string' || !/^refs\/(heads|tags)\/\S{1,200}$/.test(value)) throw new ApiError(400, 'INVALID_REF', 'Name the full ref, such as refs/heads/main.');
  return value;
};

export async function handleGithubMirror(request: Request, context: MirrorApiContext, action: string | undefined): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  const { principal, access, repository, records } = context;
  if (request.method === 'GET' && !action) {
    await access.authorize(principal, 'read', 'repository', repository.id);
    return Response.json(await snapshot(context), { headers });
  }
  if (request.method !== 'POST' || !ACTIONS.includes(action as MirrorAction)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use a supported GitHub mirror action.');
  assertMutationOrigin(request);
  const key = requireIdempotencyKey(request);
  const body = await readJson(request, 8192);
  await requireOwner(context);
  const audit = (name: string) => access.auditRepositoryChange(principal, `repository.github-mirror.${name}`, repository.id);
  const now = new Date().toISOString();
  const verb = action as MirrorAction;
  if (verb === 'link') {
    const target = githubTarget(body.owner, body.name);
    const refPatterns = parseRefPatterns(body.refPatterns, repository.defaultBranch);
    const current = await records.githubMirror();
    if (current?.credential && (current.owner.toLowerCase() !== target.owner.toLowerCase() || current.name.toLowerCase() !== target.name.toLowerCase())) {
      if (current.credential.kind === 'pat') throw new ApiError(409, 'MIRROR_CREDENTIAL_BOUND', 'The stored token was verified for the current GitHub repository. Remove the credential before linking a different repository.');
      await advertise(await context.remotes.github({ ...current, ...target }), 'git-receive-pack', context.fetcher);
    }
    await records.changeGithubMirror({ kind: 'link', ...target, refPatterns, actor: principal.userId, now });
    await audit('link');
    return Response.json(await snapshot(context, true), { headers });
  }
  if (verb === 'unlink') {
    await records.changeGithubMirror({ kind: 'unlink' });
    await audit('unlink');
    return Response.json(await snapshot(context, true), { headers });
  }
  const mirror = await requireMirror(context);
  if (verb === 'credential') {
    const kind = body.kind === 'app' ? 'app' : body.kind === 'pat' ? 'pat' : null;
    if (!kind) throw new ApiError(400, 'INVALID_CREDENTIAL_KIND', 'Choose a fine-grained personal access token (pat) or a GitHub App installation (app).');
    let credential: StoredMirrorCredential;
    if (kind === 'pat') {
      if (request.headers.has('Authorization') || !principal.sessionId || principal.bootstrap) throw new ApiError(403, 'BROWSER_REQUIRED', 'Paste the GitHub token in the repository settings while signed in through the browser. Tokens are never accepted from API or MCP clients.');
      const token = patToken(body.token);
      if (!context.env.AUTH_ENCRYPTION_KEY) throw new ApiError(503, 'AUTH_ENCRYPTION_REQUIRED', 'This installation has no AUTH_ENCRYPTION_KEY, so it cannot store credentials.');
      await advertise({ url: `${GITHUB_ORIGIN}/${mirror.owner}/${mirror.name}.git`, authorization: basicAuthorization(token), label: 'GitHub' }, 'git-receive-pack', context.fetcher);
      credential = { kind: 'pat', encrypted: await encryptAuth(token, context.env.AUTH_ENCRYPTION_KEY, credentialContext(principal.workspaceId, repository.id)), setBy: principal.userId, setAt: now, authorizedBy: durable(principal) };
    } else {
      if (!githubAppConfig(context.env)) throw new ApiError(503, 'GITHUB_APP_NOT_CONFIGURED', 'This installation has no GitHub App configured. Use a fine-grained personal access token instead.');
      if (!await access.installationCredentialAdmin(principal)) throw new ApiError(403, 'INSTALLATION_OWNER_REQUIRED', 'The installation GitHub App is reserved for the installation workspace. Use a fine-grained personal access token.');
      credential = { kind: 'app', installationId: installationId(body.installationId), setBy: principal.userId, setAt: now, authorizedBy: durable(principal) };
      await advertise(await context.remotes.github({ ...mirror, credential }), 'git-receive-pack', context.fetcher);
    }
    await records.changeGithubMirror({ kind: 'credential', credential, now });
    await audit(`credential.${kind}`);
    return Response.json(await snapshot(context, true), { headers });
  }
  if (verb === 'remove-credential') {
    await records.changeGithubMirror({ kind: 'credential', credential: null, now });
    await audit('credential.removed');
    return Response.json(await snapshot(context, true), { headers });
  }
  if (!mirror.credential) throw new ApiError(412, 'MIRROR_CREDENTIAL_MISSING', 'Add a GitHub credential to the mirror first.');
  if (verb === 'sync') {
    await access.rateLimit(`github-mirror:${repository.id}`, 60, 3_600_000);
    const scheduled = await context.schedule('manual');
    await audit('sync');
    return Response.json({ ...await snapshot(context, true), scheduled }, { status: 202, headers });
  }
  if (verb === 'overwrite') {
    const ref = mirroredRef(body.ref);
    if (!matchesPatterns(ref, mirror.refPatterns)) throw new ApiError(400, 'REF_NOT_MIRRORED', 'This ref is not one of the mirrored ref patterns.');
    const expectedGithubSha = sha(body.expectedGithubSha, 'expectedGithubSha');
    await audit('overwrite');
    const outcome = await context.run({ reason: 'overwrite', override: { ref, expectedGithubSha } });
    if (outcome.state === 'queued') throw new ApiError(409, 'MIRROR_SYNC_RUNNING', 'A mirror sync is running. Wait for it to finish, then overwrite again.');
    return Response.json({ ...await snapshot(context, true), outcome }, { headers });
  }
  if (verb === 'import') {
    const ref = mirroredRef(body.ref);
    const imported = await importFromGithub(mirror, ref, context.remotes);
    await records.changeGithubMirror({ kind: 'imported', ref, branch: imported.branch, now });
    await audit('import');
    return Response.json({ ...await snapshot(context, true), imported }, { headers });
  }
  if (mirror.adoptRequestId === key) return Response.json(await snapshot(context, true), { headers });
  if (mirror.adoptedAt) throw new ApiError(409, 'MIRROR_ALREADY_ADOPTED', 'This mirror already adopted GitHub. Gitflare is now the source of truth.');
  if (!await context.freshRepository()) throw new ApiError(409, 'ADOPT_REQUIRES_NEW_REPOSITORY', 'Adopt from GitHub only works on an empty repository or one with only its initial setup commit. Use Import from GitHub to bring changes in as a stream.');
  const adopted = await adoptFromGithub(mirror, repository.defaultBranch, context.remotes, now);
  await records.changeGithubMirror({ kind: 'adopted', refs: adopted.refs, requestId: key, now });
  await context.recordHead(adopted.headSha);
  await audit('adopt');
  return Response.json(await snapshot(context, true), { headers });
}
