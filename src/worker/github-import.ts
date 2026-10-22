import type { IssueCloseReason, IssueLabelDefinition, Release, Repository } from '../shared/types';
import type { GitHubImportCanonical, GitHubImportCounts, GitHubImportCredentialKind, GitHubImportError, GitHubImportMode, GitHubImportOptions, GitHubImportPhase, GitHubImportSkip, GitHubImportSnapshot, GitHubImportState, GitHubImportTransition, GitHubImportView, GitHubOrgListing, GitHubOrgRepository } from '../shared/github-import';
import { ApiError, assertMutationOrigin, readJson, requireIdempotencyKey } from './domain';
import { decryptAuth, encryptAuth } from './mfa';
import { GITHUB_AUTHOR_PREFIX, importComments, importIssues, importLabelDefinitions, LABEL_COLOR, LABEL_COLORS, type CommentImport, type ImportOutcome, type IssueImport, type IssueStore } from './issues';
import { RELEASE_LIMIT, RELEASE_NOTES_MAX, releaseTag } from './releases';
import { advertise, transferRefs, ZERO_SHA, type GitRemote } from './git-transfer';
import { GITHUB_ORIGIN, githubTarget, patToken, type StoredMirror } from './github-mirror';
import type { Action, Principal } from './security';
import type { StepRunner } from './background-work';
import { validGitSha } from './artifacts';

export const GITHUB_API = 'https://api.github.com';
const STORE_KEY = 'github-import';
const LEASE_MS = 10 * 60_000;
const SKIP_LIMIT = 200;
const PAGE_SIZE = 100;
const PULL_PAGE_SIZE = 25;
const MAX_WAIT_MS = 65 * 60_000;
const CODE_WAIT_MS = 2 * 3_600_000;
const CODE_POLL_MS = 60_000;
const SLICE_MS = 25_000;
const PULL_OVERLAP_MS = 5 * 60_000;
const REQUEST_MS = 20_000;
const RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
export const TRANSITION_INTERVAL_MS = 55 * 60_000;
export const IMPORT_RETRIES = 5;
export const IMPORT_STEPS_PER_RUN = 400;
export const ORG_IMPORT_MAX = 20;
const ISSUE_BODY_IMPORT_MAX = 20_000;
const COMMENT_IMPORT_MAX = 10_000;
const PROPOSAL_DESCRIPTION_MAX = 8_000;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const ACTIVE: GitHubImportState[] = ['queued', 'running', 'waiting'];

export type StoredImportCredential = { kind: 'token'; encrypted: string; setBy: string; setAt: string } | { kind: 'mirror' };
export interface StoredImport {
  id: string;
  requestId: string;
  owner: string;
  name: string;
  options: GitHubImportOptions;
  mode: GitHubImportMode;
  state: GitHubImportState;
  phase: GitHubImportPhase;
  cursor: string | null;
  since?: string;
  runId: string;
  runStartedAt: string;
  counts: GitHubImportCounts;
  skipped: GitHubImportSkip[];
  preserveNumbers: boolean;
  sourcePrivate: boolean;
  credential: StoredImportCredential | null;
  keepCredential: boolean;
  authorizedBy: Principal;
  requestedBy: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  retryAt?: string;
  error?: GitHubImportError;
  transition: GitHubImportTransition;
  canonical?: GitHubImportCanonical;
  lock?: { runId: string; expiresAt: number };
}

export interface ReleaseImport { githubId: number; release: Release }
export interface ImportBatch {
  labels?: IssueLabelDefinition[];
  issues?: IssueImport[];
  comments?: CommentImport[];
  releases?: ReleaseImport[];
  proposals?: { number: number; missionId: string }[];
  skipped?: GitHubImportSkip[];
}
export type ImportChange =
  | { kind: 'start'; job: StoredImport }
  | { kind: 'begin'; runId: string; now: number }
  | { kind: 'progress'; runId: string; repositoryId: string; batch: ImportBatch; phase: GitHubImportPhase; cursor: string | null; now: string }
  | { kind: 'wait'; runId: string; retryAt: string; reason?: GitHubImportError; now: string }
  | { kind: 'error'; runId: string; error: GitHubImportError; now: string }
  | { kind: 'finish'; runId: string; state: 'completed' | 'failed'; error?: GitHubImportError; now: string }
  | { kind: 'resume'; runId: string; now: string }
  | { kind: 'cancel'; now: string }
  | { kind: 'credential'; credential: StoredImportCredential | null; keep?: boolean; now: string }
  | { kind: 'transition'; enabled: boolean; now: string }
  | { kind: 'pull'; runId: string; now: string }
  | { kind: 'canonical'; canonical: GitHubImportCanonical; now: string };
export interface ImportChangeResult { job: StoredImport | null; acquired?: boolean }
export interface ImportStore extends IssueStore { delete(key: string): void }

export const sourceKey = (owner: string, name: string) => `${owner}/${name}`.toLowerCase();
const pullKey = (source: string, number: number) => `github-pull:${source}:${number}`;
const releaseKey = (source: string, id: number) => `github-release:${source}:${id}`;
const active = (job: StoredImport) => ACTIVE.includes(job.state);
export const emptyCounts = (): GitHubImportCounts => ({ labels: 0, issues: 0, pullRequests: 0, proposals: 0, comments: 0, releases: 0, updated: 0, skipped: 0 });

function addSkips(job: StoredImport, skips: GitHubImportSkip[]): void {
  job.counts.skipped += skips.length;
  job.skipped = [...job.skipped, ...skips].slice(0, SKIP_LIMIT);
}

function issueSkips(kind: GitHubImportSkip['kind'], outcome: ImportOutcome): GitHubImportSkip[] { return outcome.skipped.map(item => ({ kind, ...item })); }

function applyBatch(store: ImportStore, job: StoredImport, repositoryId: string, batch: ImportBatch): void {
  const source = sourceKey(job.owner, job.name);
  if (batch.labels?.length) {
    const outcome = importLabelDefinitions(store, batch.labels);
    job.counts.labels += outcome.created;
    addSkips(job, issueSkips('label', outcome));
  }
  if (batch.issues?.length) {
    for (const item of batch.issues) {
      const kind = item.importedFrom.pullRequest ? 'pull' : 'issue';
      const outcome = importIssues(store, repositoryId, source, [item], job.preserveNumbers);
      if (kind === 'pull') job.counts.pullRequests += outcome.created; else job.counts.issues += outcome.created;
      job.counts.updated += outcome.updated;
      addSkips(job, issueSkips(kind, outcome));
    }
  }
  if (batch.comments?.length) {
    const outcome = importComments(store, source, batch.comments);
    job.counts.comments += outcome.created;
    job.counts.updated += outcome.updated;
    addSkips(job, issueSkips('comment', outcome));
  }
  if (batch.releases?.length) {
    const releases = store.list<Release>('release:');
    for (const { githubId, release } of batch.releases) {
      if (store.get(releaseKey(source, githubId))) continue;
      const existing = releases.find(item => item.tag === release.tag);
      if (existing) { store.put(releaseKey(source, githubId), existing.id); addSkips(job, [{ kind: 'release', ref: release.tag, reason: 'A release for this tag already exists.' }]); continue; }
      if (releases.length >= RELEASE_LIMIT) { addSkips(job, [{ kind: 'release', ref: release.tag, reason: `A repository holds at most ${RELEASE_LIMIT} releases.` }]); continue; }
      store.put(`release:${release.id}`, release);
      store.put(releaseKey(source, githubId), release.id);
      releases.push(release);
      job.counts.releases++;
    }
  }
  for (const proposal of batch.proposals ?? []) {
    if (store.get(pullKey(source, proposal.number))) continue;
    store.put(pullKey(source, proposal.number), proposal.missionId);
    job.counts.proposals++;
  }
  if (batch.skipped?.length) addSkips(job, batch.skipped);
}

export function importedPullMissions(store: IssueStore, source: string, numbers: number[]): Record<number, string> {
  return Object.fromEntries(numbers.flatMap(number => { const id = store.get<string>(pullKey(source, number)); return id ? [[number, id]] : []; }));
}

export function importedReleaseIds(store: IssueStore, source: string, ids: number[]): number[] {
  return ids.filter(id => store.get(releaseKey(source, id)) !== undefined);
}

export function applyImportChange(store: ImportStore, change: ImportChange): ImportChangeResult {
  const current = store.get<StoredImport>(STORE_KEY) ?? null;
  const save = (job: StoredImport, acquired?: boolean): ImportChangeResult => { store.put(STORE_KEY, job); return { job, ...(acquired === undefined ? {} : { acquired }) }; };
  if (change.kind === 'start') {
    if (current && active(current) && current.requestId !== change.job.requestId) throw new ApiError(409, 'GITHUB_IMPORT_RUNNING', 'An import from GitHub is already running for this repository. Wait for it or cancel it first.');
    if (current?.requestId === change.job.requestId) return { job: current };
    const same = current && sourceKey(current.owner, current.name) === sourceKey(change.job.owner, change.job.name);
    const preserveNumbers = same ? current!.preserveNumbers : (store.get<number>('issue-count') ?? 0) === 0;
    return save({ ...change.job, preserveNumbers, ...(same ? { transition: current!.transition, ...(current!.canonical ? { canonical: current!.canonical } : {}) } : {}) });
  }
  if (!current) return { job: null, acquired: false };
  if (change.kind === 'begin') {
    if (!active(current) || current.runId !== change.runId) return { job: current, acquired: false };
    if (current.lock && current.lock.expiresAt > change.now && current.lock.runId !== change.runId) return { job: current, acquired: false };
    return save({ ...current, state: 'running', lock: { runId: change.runId, expiresAt: change.now + LEASE_MS }, retryAt: undefined }, true);
  }
  const owns = 'runId' in change && change.kind !== 'resume' && change.kind !== 'pull' ? current.lock?.runId === change.runId && current.runId === change.runId && active(current) : true;
  if (change.kind === 'progress') {
    if (!owns) return { job: current, acquired: false };
    const job = structuredClone(current);
    applyBatch(store, job, change.repositoryId, change.batch);
    return save({ ...job, phase: change.phase, cursor: change.cursor, updatedAt: change.now, error: undefined }, true);
  }
  if (change.kind === 'wait') {
    if (!owns) return { job: current, acquired: false };
    const { lock: _lock, ...rest } = current;
    return save({ ...rest, state: 'waiting', retryAt: change.retryAt, updatedAt: change.now, ...(change.reason ? { error: change.reason } : { error: undefined }) }, true);
  }
  if (change.kind === 'error') {
    if (!owns) return { job: current, acquired: false };
    return save({ ...current, error: change.error, updatedAt: change.now }, true);
  }
  if (change.kind === 'finish') {
    if (!owns) return { job: current, acquired: false };
    const { lock: _lock, retryAt: _retry, ...rest } = current;
    const pullRun = current.mode === 'pull';
    const credential = change.state === 'completed' && !current.keepCredential && !current.transition.enabled && current.credential?.kind === 'token' ? null : current.credential;
    const transition = pullRun ? { ...current.transition, ...(change.state === 'completed' ? { lastPullAt: current.runStartedAt, lastError: undefined } : { lastError: change.error }) } : current.transition;
    const state = pullRun ? 'completed' : change.state;
    return save({ ...rest, state, credential, transition, updatedAt: change.now, error: pullRun ? undefined : change.error, ...(pullRun ? {} : { completedAt: change.now }) }, true);
  }
  if (change.kind === 'resume') {
    if (current.state === 'completed' || current.state === 'canceled') throw new ApiError(409, 'GITHUB_IMPORT_FINISHED', 'This import already finished. Start a new import to pull changes again.');
    const { lock: _lock, retryAt: _retry, error: _error, ...rest } = current;
    return save({ ...rest, state: 'queued', runId: change.runId, updatedAt: change.now });
  }
  if (change.kind === 'cancel') {
    if (!active(current)) throw new ApiError(409, 'GITHUB_IMPORT_NOT_RUNNING', 'No import from GitHub is running.');
    const { lock: _lock, retryAt: _retry, ...rest } = current;
    return save({ ...rest, state: current.mode === 'pull' ? 'completed' : 'canceled', credential: current.keepCredential ? current.credential : null, updatedAt: change.now, ...(current.mode === 'pull' ? {} : { completedAt: change.now }) });
  }
  if (change.kind === 'credential') return save({ ...current, credential: change.credential, keepCredential: change.keep ?? current.keepCredential, updatedAt: change.now });
  if (change.kind === 'transition') {
    if (change.enabled && current.canonical) throw new ApiError(409, 'GITFLARE_CANONICAL', 'Gitflare is already canonical for this repository. GitHub issues are no longer pulled.');
    return save({ ...current, transition: { ...current.transition, enabled: change.enabled }, ...(!change.enabled && !current.keepCredential && current.credential?.kind === 'token' && !active(current) ? { credential: null } : {}), updatedAt: change.now });
  }
  if (change.kind === 'pull') {
    if (active(current)) throw new ApiError(409, 'GITHUB_IMPORT_RUNNING', 'An import from GitHub is already running for this repository.');
    if (!current.transition.enabled) throw new ApiError(409, 'TRANSITION_OFF', 'Turn on the hourly GitHub issue pull first.');
    const since = new Date(Date.parse(current.transition.lastPullAt ?? current.startedAt) - PULL_OVERLAP_MS).toISOString();
    const { error: _error, retryAt: _retry, lock: _lock, ...rest } = current;
    return save({ ...rest, mode: 'pull', state: 'queued', phase: 'issues', cursor: null, since, runId: change.runId, runStartedAt: change.now, updatedAt: change.now });
  }
  const { lock: _lock, ...rest } = current;
  return save({ ...rest, canonical: change.canonical, transition: { ...current.transition, enabled: false }, ...(active(current) && current.mode === 'pull' ? { state: 'completed' as const } : {}), credential: current.credential?.kind === 'token' ? null : current.credential, keepCredential: false, updatedAt: change.now });
}

export function importView(job: StoredImport): GitHubImportView {
  const credential: GitHubImportCredentialKind = job.credential?.kind ?? 'none';
  return {
    id: job.id, owner: job.owner, name: job.name, url: `${GITHUB_ORIGIN}/${job.owner}/${job.name}`, options: job.options, mode: job.mode, state: job.state, phase: job.phase,
    counts: job.counts, skipped: job.skipped, preserveNumbers: job.preserveNumbers, sourcePrivate: job.sourcePrivate, credential, keepCredential: job.keepCredential,
    requestedBy: job.requestedBy, startedAt: job.startedAt, updatedAt: job.updatedAt, ...(job.completedAt ? { completedAt: job.completedAt } : {}), ...(job.retryAt ? { retryAt: job.retryAt } : {}), ...(job.error ? { error: job.error } : {}),
    transition: job.transition, ...(job.canonical ? { canonical: job.canonical } : {}),
  };
}

export class GitHubRateLimited extends Error {
  constructor(readonly retryAt: number) { super('GitHub rate limit reached'); this.name = 'GitHubRateLimited'; }
}

export interface GitHubPage<T> { data: T; next: string | null }
export interface GitHubClient {
  get<T>(url: string): Promise<GitHubPage<T>>;
  post<T>(url: string, body: Record<string, unknown>): Promise<T>;
}

function nextLink(header: string | null): string | null {
  for (const part of header?.split(',') ?? []) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match && match[1]!.startsWith(`${GITHUB_API}/`)) return match[1]!;
  }
  return null;
}

function rateLimitedUntil(response: Response, now: number): number | null {
  if (response.status !== 403 && response.status !== 429) return null;
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return now + retryAfter * 1000;
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    return Number.isFinite(reset) && reset > 0 ? Math.max(now, reset * 1000) + 1000 : now + 60_000;
  }
  return response.status === 429 ? now + 60_000 : null;
}

export function githubClient(token: string | null, fetcher: typeof fetch = fetch, clock: () => number = Date.now): GitHubClient {
  const request = async (url: string, init: { method: string; body?: string }): Promise<Response> => {
    if (!url.startsWith(`${GITHUB_API}/`)) throw new ApiError(502, 'GITHUB_PROTOCOL', 'GitHub returned a link outside its API.');
    let response: Response;
    try {
      response = await fetcher(url, { method: init.method, headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'gitflare-import', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) }, ...(init.body ? { body: init.body } : {}), redirect: 'manual', signal: AbortSignal.timeout(REQUEST_MS) });
    } catch { throw new ApiError(502, 'GITHUB_UNREACHABLE', 'GitHub could not be reached. The import retries.'); }
    if (response.ok) return response;
    await response.body?.cancel().catch(() => {});
    const limited = rateLimitedUntil(response, clock());
    if (limited !== null) throw new GitHubRateLimited(limited);
    if (response.status >= 300 && response.status < 400) throw new ApiError(409, 'GITHUB_REPOSITORY_MOVED', 'GitHub moved this repository. Enter its new owner and name.');
    if (response.status === 401) throw new ApiError(422, 'GITHUB_TOKEN_REJECTED', 'GitHub rejected the token. Add a new one in the browser.');
    if (response.status === 403) throw new ApiError(403, 'GITHUB_FORBIDDEN', 'GitHub refused access. The token needs read access to issues, pull requests and contents.');
    if (response.status === 404) throw new ApiError(404, 'GITHUB_NOT_FOUND', token ? 'GitHub has no such repository, or the token cannot see it.' : 'GitHub has no such public repository. For a private repository, add a read-only token in the browser.');
    if (response.status === 410) throw new ApiError(410, 'GITHUB_GONE', 'GitHub has this feature turned off for the repository.');
    if (response.status === 422) throw new ApiError(422, 'GITHUB_REJECTED', 'GitHub rejected the request.');
    throw new ApiError(502, 'GITHUB_UNAVAILABLE', `GitHub returned HTTP ${response.status}. The import retries.`);
  };
  const json = async <T>(response: Response): Promise<T> => {
    const text = await response.text();
    if (text.length > RESPONSE_MAX_BYTES) throw new ApiError(502, 'GITHUB_RESPONSE_TOO_LARGE', 'GitHub returned more data than the import accepts.');
    try { return JSON.parse(text) as T; } catch { throw new ApiError(502, 'GITHUB_PROTOCOL', 'GitHub returned a response that is not JSON.'); }
  };
  return {
    async get<T>(url: string) { const response = await request(url, { method: 'GET' }); return { data: await json<T>(response), next: nextLink(response.headers.get('link')) }; },
    async post<T>(url: string, body: Record<string, unknown>) { return json<T>(await request(url, { method: 'POST', body: JSON.stringify(body) })); },
  };
}

export function importedText(value: unknown, max: number): string {
  const text = (typeof value === 'string' ? value : '').replace(/\r\n?/g, '\n').replace(CONTROL, '');
  return text.length <= max ? text : `${text.slice(0, max - 48)}\n\n_Truncated on import from GitHub._`;
}

function importedTitle(value: unknown, fallback: string): string {
  return importedText(value, 1000).replace(/\s+/g, ' ').trim().slice(0, 200).trim() || fallback;
}

export function githubLogin(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(value) ? value : 'ghost';
}

const authorOf = (user: unknown) => githubLogin((user as { login?: unknown } | null)?.login);
const githubUrl = (value: unknown, fallback: string) => typeof value === 'string' && value.startsWith(`${GITHUB_ORIGIN}/`) && !/[\s"'<>\\]/.test(value) ? value : fallback;
const timestamp = (value: unknown, fallback: string) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : fallback;

export function importedLabel(value: unknown): string | null {
  const label = typeof value === 'string' ? value.replace(CONTROL, '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).trim() : '';
  return label || null;
}

function labelDefinition(raw: { name?: unknown; color?: unknown; description?: unknown }): IssueLabelDefinition | null {
  const name = importedLabel(raw.name);
  if (!name) return null;
  const color = typeof raw.color === 'string' && LABEL_COLOR.test(`#${raw.color.toLowerCase()}`) ? `#${raw.color.toLowerCase()}` : LABEL_COLORS[[...name.toLowerCase()].reduce((sum, char) => sum + char.charCodeAt(0), 0) % LABEL_COLORS.length]!;
  return { name, color, description: importedText(raw.description, 400).replace(/\s+/g, ' ').trim().slice(0, 100) };
}

interface RawIssue { number?: unknown; title?: unknown; body?: unknown; state?: unknown; state_reason?: unknown; html_url?: unknown; user?: unknown; labels?: unknown; created_at?: unknown; updated_at?: unknown; closed_at?: unknown; pull_request?: { merged_at?: unknown } | null }
interface RawComment { id?: unknown; body?: unknown; html_url?: unknown; issue_url?: unknown; user?: unknown; created_at?: unknown; updated_at?: unknown }
export interface RawPull { number?: unknown; title?: unknown; body?: unknown; html_url?: unknown; user?: unknown; head?: { sha?: unknown } | null; base?: { ref?: unknown } | null; draft?: unknown }
interface RawRelease { id?: unknown; tag_name?: unknown; name?: unknown; body?: unknown; draft?: unknown; prerelease?: unknown; html_url?: unknown; author?: unknown; created_at?: unknown; published_at?: unknown; assets?: unknown }

const positive = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

function labelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>(), names: string[] = [];
  for (const item of raw) {
    const name = importedLabel(typeof item === 'string' ? item : (item as { name?: unknown } | null)?.name);
    if (name && !seen.has(name.toLowerCase()) && names.length < 10) { seen.add(name.toLowerCase()); names.push(name); }
  }
  return names;
}

export function issueFromGithub(raw: RawIssue, owner: string, name: string, now: string): IssueImport | null {
  const number = positive(raw.number);
  if (!number) return null;
  const login = authorOf(raw.user);
  const created = timestamp(raw.created_at, now), updated = timestamp(raw.updated_at, created);
  const closed = raw.state === 'closed';
  const pull = raw.pull_request ? { merged: typeof raw.pull_request.merged_at === 'string' } : undefined;
  const reason: IssueCloseReason = pull ? (pull.merged ? 'completed' : 'not_planned') : raw.state_reason === 'not_planned' ? 'not_planned' : 'completed';
  return {
    title: importedTitle(raw.title, `GitHub #${number}`), body: importedText(raw.body, ISSUE_BODY_IMPORT_MAX), state: closed ? 'closed' : 'open', ...(closed ? { closedReason: reason, closedAt: timestamp(raw.closed_at, updated) } : {}),
    labels: labelNames(raw.labels), authorId: `${GITHUB_AUTHOR_PREFIX}${login}`, createdAt: created, updatedAt: updated,
    importedFrom: { source: 'github', url: githubUrl(raw.html_url, `${GITHUB_ORIGIN}/${owner}/${name}/issues/${number}`), author: login, number, ...(pull ? { pullRequest: pull } : {}) },
  };
}

export function commentFromGithub(raw: RawComment, owner: string, name: string, now: string): CommentImport | null {
  const id = positive(raw.id);
  const issue = typeof raw.issue_url === 'string' ? Number(/\/issues\/(\d{1,9})$/.exec(raw.issue_url)?.[1]) : NaN;
  if (!id || !Number.isSafeInteger(issue) || issue < 1) return null;
  const login = authorOf(raw.user);
  const created = timestamp(raw.created_at, now);
  const body = importedText(raw.body, COMMENT_IMPORT_MAX);
  return { githubId: id, githubIssue: issue, authorId: `${GITHUB_AUTHOR_PREFIX}${login}`, body: body.trim() ? body : '_Empty comment on GitHub._', createdAt: created, updatedAt: timestamp(raw.updated_at, created), importedFrom: { source: 'github', url: githubUrl(raw.html_url, `${GITHUB_ORIGIN}/${owner}/${name}/issues/${issue}`), author: login } };
}

const markdownText = (value: string) => value.replace(/[\\`*_[\]()<>#|~!]/g, match => `\\${match}`);

export function releaseNotesFromGithub(raw: RawRelease): string {
  const assets = Array.isArray(raw.assets) ? raw.assets.flatMap(asset => {
    const item = asset as { name?: unknown; browser_download_url?: unknown; size?: unknown };
    const url = githubUrl(item.browser_download_url, '');
    const label = importedTitle(item.name, '');
    return url && label ? [`- [${markdownText(label)}](${url})${typeof item.size === 'number' ? ` (${Math.max(1, Math.round(item.size / 1024)).toLocaleString('en-US')} KiB)` : ''}`] : [];
  }).slice(0, 50) : [];
  const suffix = assets.length ? `\n\n### Assets on GitHub\n\n${assets.join('\n')}\n` : '';
  return `${importedText(raw.body, RELEASE_NOTES_MAX - suffix.length - 100)}${suffix}`.slice(0, RELEASE_NOTES_MAX);
}

export interface PullHead { number: number; title: string; description: string; url: string; author: string; headSha: string; baseRef: string }

export function pullFromGithub(raw: RawPull, owner: string, name: string): PullHead | null {
  const number = positive(raw.number);
  const headSha = typeof raw.head?.sha === 'string' && validGitSha(raw.head.sha) ? raw.head.sha : null;
  if (!number || !headSha) return null;
  const url = githubUrl(raw.html_url, `${GITHUB_ORIGIN}/${owner}/${name}/pull/${number}`);
  const author = authorOf(raw.user);
  const body = importedText(raw.body, PROPOSAL_DESCRIPTION_MAX - 300).trim();
  return { number, title: importedTitle(raw.title, `GitHub pull request #${number}`).slice(0, 120), description: `Imported from GitHub pull request #${number} by github:${author}: ${url}${body ? `\n\n${body}` : ''}`, url, author, headSha, baseRef: typeof raw.base?.ref === 'string' ? raw.base.ref.slice(0, 200) : '' };
}

export const pullStream = (number: number) => `github-pr/${number}`;

export interface PullFetchResult { number: number; headSha?: string; reason?: string }

export async function fetchPullHeads(github: GitRemote, gitflare: { remote: GitRemote; release(): Promise<void> }, pulls: PullHead[], fetcher: typeof fetch = fetch): Promise<PullFetchResult[]> {
  try {
    const source = await advertise(github, 'git-upload-pack', fetcher);
    const destination = await advertise(gitflare.remote, 'git-receive-pack', fetcher);
    const results: PullFetchResult[] = [], commands = [];
    for (const pull of pulls) {
      const sha = source.refs.get(`refs/pull/${pull.number}/head`);
      if (!sha) { results.push({ number: pull.number, reason: 'GitHub no longer advertises this pull request head.' }); continue; }
      const ref = `refs/heads/${pullStream(pull.number)}`, existing = destination.refs.get(ref);
      if (existing === sha) { results.push({ number: pull.number, headSha: sha }); continue; }
      commands.push({ ref, oldSha: existing ?? ZERO_SHA, newSha: sha });
    }
    const outcomes = await transferRefs({ remote: github, advertised: source }, { remote: gitflare.remote, advertised: destination }, commands, fetcher);
    for (const command of commands) {
      const outcome = outcomes.find(item => item.ref === command.ref);
      const number = Number(command.ref.slice('refs/heads/github-pr/'.length));
      results.push(outcome?.ok ? { number, headSha: command.newSha } : { number, reason: `Gitflare storage rejected the stream: ${outcome && !outcome.ok ? outcome.reason.slice(0, 200) : 'no status'}.` });
    }
    return results.sort((a, b) => a.number - b.number);
  } finally { await gitflare.release(); }
}

export interface ImportRecords {
  githubImport(): Promise<StoredImport | null>;
  changeGithubImport(change: ImportChange): Promise<ImportChangeResult>;
  importedPulls(source: string, numbers: number[]): Promise<Record<number, string>>;
  importedReleases(source: string, ids: number[]): Promise<number[]>;
}

export interface ImportServices {
  repository(): Promise<Repository | undefined>;
  isPublic(principal: Principal): Promise<boolean>;
  token(job: StoredImport): Promise<string | null>;
  tagCommit(tag: string): Promise<string | null>;
  openProposals(job: StoredImport, pulls: PullHead[], token: string | null): Promise<{ proposals: { number: number; missionId: string }[]; skipped: GitHubImportSkip[] }>;
  check(principal: Principal, action: Action, resourceType: string, resourceId: string): Promise<void>;
}

export interface ImportRunContext {
  repositoryId: string;
  records: ImportRecords;
  services: ImportServices;
  fetcher?: typeof fetch;
  now?: () => number;
}

export type SliceResult = { state: 'done' | 'queued' | 'continue' } | { state: 'wait'; waitMs: number };

function phaseOrder(job: StoredImport): GitHubImportPhase[] {
  if (job.mode === 'pull') return ['issues', 'comments', 'done'];
  const data = job.options.issues || job.options.pullRequests;
  return [...(data ? ['labels', 'issues', 'comments'] as const : []), ...(job.options.pullRequests ? ['pulls'] as const : []), ...(job.options.releases ? ['releases'] as const : []), 'done'];
}

export function firstPhase(job: Pick<StoredImport, 'mode' | 'options'>): GitHubImportPhase { return phaseOrder(job as StoredImport)[0]!; }

function after(job: StoredImport, phase: GitHubImportPhase): GitHubImportPhase {
  const order = phaseOrder(job);
  return order[order.indexOf(phase) + 1] ?? 'done';
}

const repoPath = (job: StoredImport) => `${GITHUB_API}/repos/${encodeURIComponent(job.owner)}/${encodeURIComponent(job.name)}`;

function firstUrl(job: StoredImport): string {
  const base = repoPath(job), since = job.mode === 'pull' && job.since ? `&since=${encodeURIComponent(job.since)}` : '';
  if (job.phase === 'labels') return `${base}/labels?per_page=${PAGE_SIZE}`;
  if (job.phase === 'issues') return `${base}/issues?state=all&sort=${job.mode === 'pull' ? 'updated' : 'created'}&direction=asc&per_page=${PAGE_SIZE}${since}`;
  if (job.phase === 'comments') return `${base}/issues/comments?sort=created&direction=asc&per_page=${PAGE_SIZE}${since}`;
  if (job.phase === 'pulls') return `${base}/pulls?state=open&sort=created&direction=asc&per_page=${PULL_PAGE_SIZE}`;
  return `${base}/releases?per_page=${PAGE_SIZE}`;
}

interface PageStep { batch: ImportBatch; phase: GitHubImportPhase; cursor: string | null; waitMs?: number }

async function codeReady(job: StoredImport, services: ImportServices, now: number): Promise<{ ready: boolean; waitMs?: number }> {
  const repository = await services.repository();
  if (repository?.headSha) return { ready: true };
  if (repository?.urlImport?.status === 'importing' && now - Date.parse(job.startedAt) < CODE_WAIT_MS) return { ready: false, waitMs: CODE_POLL_MS };
  return { ready: false };
}

async function processPage(context: ImportRunContext, job: StoredImport, client: GitHubClient, token: string | null, clock: () => number): Promise<PageStep> {
  const now = new Date(clock()).toISOString();
  const nextPhase = (batch: ImportBatch = {}): PageStep => ({ batch, phase: after(job, job.phase), cursor: null });
  if (job.phase === 'pulls' || job.phase === 'releases') {
    const code = await codeReady(job, context.services, clock());
    if (!code.ready && code.waitMs) return { batch: {}, phase: job.phase, cursor: job.cursor, waitMs: code.waitMs };
    if (!code.ready) return nextPhase({ skipped: [{ kind: job.phase === 'pulls' ? 'pull' : 'release', ref: job.phase === 'pulls' ? 'Open pull requests' : 'Releases', reason: 'The repository has no code yet. Import the code from GitHub first, then import again.' }] });
  }
  let page: GitHubPage<unknown>;
  try { page = await client.get<unknown>(job.cursor ?? firstUrl(job)); }
  catch (error) { if (error instanceof ApiError && error.code === 'GITHUB_GONE') return nextPhase(); throw error; }
  if (!Array.isArray(page.data)) throw new ApiError(502, 'GITHUB_PROTOCOL', 'GitHub returned an unexpected page.');
  const items = page.data as Record<string, unknown>[];
  const advance = (batch: ImportBatch): PageStep => page.next ? { batch, phase: job.phase, cursor: page.next } : nextPhase(batch);
  if (job.phase === 'labels') return advance({ labels: items.flatMap(item => { const label = labelDefinition(item); return label ? [label] : []; }) });
  if (job.phase === 'issues') {
    const issues = items.flatMap(item => {
      const pull = !!item.pull_request;
      if (pull ? !job.options.pullRequests || item.state !== 'closed' : !job.options.issues) return [];
      const issue = issueFromGithub(item as RawIssue, job.owner, job.name, now);
      return issue ? [issue] : [];
    });
    return advance({ issues });
  }
  if (job.phase === 'comments') return advance({ comments: items.flatMap(item => { const comment = commentFromGithub(item as RawComment, job.owner, job.name, now); return comment ? [comment] : []; }) });
  if (job.phase === 'pulls') {
    const pulls = items.flatMap(item => { const pull = pullFromGithub(item as RawPull, job.owner, job.name); return pull ? [pull] : []; });
    const mapped = await context.records.importedPulls(sourceKey(job.owner, job.name), pulls.map(pull => pull.number));
    const fresh = pulls.filter(pull => !mapped[pull.number]);
    const opened = fresh.length ? await context.services.openProposals(job, fresh, token) : { proposals: [], skipped: [] };
    return advance({ proposals: opened.proposals, skipped: opened.skipped });
  }
  const raws = items as RawRelease[];
  const known = new Set(await context.records.importedReleases(sourceKey(job.owner, job.name), raws.flatMap(raw => positive(raw.id) ?? [])));
  const releases: ReleaseImport[] = [], skipped: GitHubImportSkip[] = [];
  for (const raw of raws) {
    const id = positive(raw.id);
    if (!id || raw.draft === true || known.has(id)) continue;
    let tag: string;
    try { tag = releaseTag(raw.tag_name); } catch { skipped.push({ kind: 'release', ref: importedTitle(raw.tag_name, `release ${id}`).slice(0, 100), reason: 'The tag name is not valid in Gitflare.' }); continue; }
    const targetSha = await context.services.tagCommit(tag);
    if (!targetSha) { skipped.push({ kind: 'release', ref: tag, reason: 'The tag is not in this repository. Import or push the tags first.' }); continue; }
    const login = authorOf(raw.author), created = timestamp(raw.created_at, now), published = timestamp(raw.published_at, created);
    releases.push({ githubId: id, release: { id: crypto.randomUUID(), repositoryId: context.repositoryId, tag, name: importedTitle(raw.name, tag).slice(0, 120), notes: releaseNotesFromGithub(raw), targetSha, draft: false, prerelease: raw.prerelease === true, authorId: `${GITHUB_AUTHOR_PREFIX}${login}`, createdAt: created, updatedAt: published, publishedAt: published, importedFrom: { source: 'github', url: githubUrl(raw.html_url, `${GITHUB_ORIGIN}/${job.owner}/${job.name}/releases/tag/${encodeURIComponent(tag)}`), author: login } } });
  }
  return advance({ releases, skipped });
}

function importError(error: unknown): GitHubImportError {
  if (error instanceof ApiError) return { code: error.code, message: error.detail };
  return { code: 'GITHUB_IMPORT_FAILED', message: 'The import stopped unexpectedly. It retries.' };
}

function retryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status >= 500 && !['AUTH_ENCRYPTION_REQUIRED', 'AUTH_ENCRYPTION_FAILED', 'GITHUB_APP_NOT_CONFIGURED', 'GITHUB_APP_MISCONFIGURED', 'GITHUB_RESPONSE_TOO_LARGE', 'GITHUB_PROTOCOL'].includes(error.code);
}

export async function runImportSlice(context: ImportRunContext, runId: string, budgetMs = SLICE_MS): Promise<SliceResult> {
  const clock = context.now ?? Date.now;
  const iso = () => new Date(clock()).toISOString();
  const begun = await context.records.changeGithubImport({ kind: 'begin', runId, now: clock() });
  if (!begun.job) return { state: 'done' };
  if (!begun.acquired) return { state: active(begun.job) && begun.job.runId === runId ? 'queued' : 'done' };
  let job = begun.job;
  const deadline = clock() + budgetMs;
  try {
    try { await context.services.check(job.authorizedBy, 'manage', 'repository', context.repositoryId); }
    catch { throw new ApiError(403, 'GITHUB_IMPORT_AUTHORITY_REVOKED', 'The Owner who started this import no longer manages the repository. An Owner must start it again.'); }
    if (job.sourcePrivate && await context.services.isPublic(job.authorizedBy)) throw new ApiError(409, 'PRIVATE_SOURCE_PUBLIC_TARGET', 'This repository is public, so content from a private GitHub repository is not imported into it.');
    const token = await context.services.token(job);
    const client = githubClient(token, context.fetcher, clock);
    while (job.phase !== 'done' && clock() < deadline) {
      const step = await processPage(context, job, client, token, clock);
      if (step.waitMs) {
        await context.records.changeGithubImport({ kind: 'wait', runId, retryAt: new Date(clock() + step.waitMs).toISOString(), reason: { code: 'WAITING_FOR_CODE', message: 'Waiting for the code import to finish.' }, now: iso() });
        return { state: 'wait', waitMs: step.waitMs };
      }
      const result = await context.records.changeGithubImport({ kind: 'progress', runId, repositoryId: context.repositoryId, batch: step.batch, phase: step.phase, cursor: step.cursor, now: iso() });
      if (!result.acquired || !result.job) return { state: 'done' };
      job = result.job;
    }
    if (job.phase !== 'done') return { state: 'continue' };
    await context.records.changeGithubImport({ kind: 'finish', runId, state: 'completed', now: iso() });
    return { state: 'done' };
  } catch (error) {
    if (error instanceof GitHubRateLimited) {
      const waitMs = Math.min(MAX_WAIT_MS, Math.max(1000, error.retryAt - clock()));
      await context.records.changeGithubImport({ kind: 'wait', runId, retryAt: new Date(clock() + waitMs).toISOString(), reason: { code: 'GITHUB_RATE_LIMITED', message: 'GitHub’s rate limit was reached. The import continues when it resets.' }, now: iso() });
      return { state: 'wait', waitMs };
    }
    const failure = importError(error);
    if (retryable(error)) {
      await context.records.changeGithubImport({ kind: 'error', runId, error: failure, now: iso() });
      throw error;
    }
    console.warn(JSON.stringify({ event: 'github_import_failed', repositoryId: context.repositoryId, code: failure.code }));
    await context.records.changeGithubImport({ kind: 'finish', runId, state: 'failed', error: failure, now: iso() });
    return { state: 'done' };
  }
}

export interface ImportParams { kind: 'github-import'; repositoryId: string; workspaceId: string; runId: string; generation: number }
export const importWorkflowId = (params: Pick<ImportParams, 'runId' | 'generation'>) => `github-import-${params.runId}-${params.generation}`;

export async function runImportWorkflow(context: ImportRunContext, params: ImportParams, step: StepRunner, redispatch: (params: ImportParams) => Promise<unknown>): Promise<void> {
  for (let index = 0; index < IMPORT_STEPS_PER_RUN; index++) {
    let result: SliceResult;
    try {
      result = await step.do(`import from GitHub ${index}`, { retries: { limit: IMPORT_RETRIES, delay: '30 seconds', backoff: 'exponential' }, timeout: '15 minutes' }, () => runImportSlice(context, params.runId));
    } catch {
      const job = await context.records.githubImport();
      await context.records.changeGithubImport({ kind: 'finish', runId: params.runId, state: 'failed', error: job?.error ?? { code: 'GITHUB_IMPORT_RETRIES_EXHAUSTED', message: 'The import failed after retries. Choose Resume to continue where it stopped.' }, now: new Date().toISOString() });
      return;
    }
    if (result.state === 'done' || result.state === 'queued') return;
    if (result.state === 'wait') {
      if (!step.sleep) return;
      await step.sleep(`wait for GitHub ${index}`, result.waitMs);
    }
  }
  await step.do('continue import in a new run', { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '1 minute' }, async () => { await redispatch({ ...params, generation: params.generation + 1 }); return true; });
}

export async function runImportInline(context: ImportRunContext, runId: string, slices = 20): Promise<SliceResult> {
  let result: SliceResult = { state: 'done' };
  for (let index = 0; index < slices; index++) {
    try { result = await runImportSlice(context, runId); } catch { return { state: 'continue' }; }
    if (result.state !== 'continue') return result;
  }
  return result;
}

export interface ImportAccess {
  authorize(principal: Principal, action: Action, resourceType?: string, resourceId?: string): Promise<void>;
  checkMany(principal: Principal, action: Action, resources: { resourceType: string; resourceId: string }[]): Promise<boolean[]>;
  rateLimit(key: string, max?: number, windowMs?: number): Promise<void>;
  auditRepositoryChange(principal: Principal, action: string, repositoryId: string): Promise<unknown>;
}

export interface ImportApiContext {
  repository: Repository;
  principal: Principal;
  access: ImportAccess;
  records: ImportRecords;
  encryptionKey?: string;
  mirror(): Promise<StoredMirror | null>;
  mirrorToken(mirror: StoredMirror): Promise<string>;
  isPublic(): Promise<boolean>;
  dispatch(job: StoredImport): Promise<void>;
  register(enabled: boolean): Promise<void>;
  homeUrl: string;
  fetcher?: typeof fetch;
  now?: () => number;
}

const ACTIONS = ['start', 'resume', 'cancel', 'credential', 'remove-credential', 'transition', 'pull', 'canonical'] as const;
type ImportAction = typeof ACTIONS[number];

export const credentialContext = (workspaceId: string, repositoryId: string) => `github-import:${workspaceId}:${repositoryId}`;

function durable({ userId, workspaceId, role, bootstrap }: Principal): Principal {
  return { userId, workspaceId, role, ...(bootstrap ? { bootstrap } : {}) };
}

export function browserOnlyToken(request: Request, principal: Principal, value: unknown): string {
  if (request.headers.has('Authorization') || !principal.sessionId || principal.bootstrap) throw new ApiError(403, 'BROWSER_REQUIRED', 'Paste the GitHub token in Gitflare while signed in through the browser. Tokens are never accepted from API or MCP clients.');
  return patToken(value);
}

async function requireOwner(context: ImportApiContext): Promise<void> {
  const { principal, access, repository } = context;
  if (principal.role !== 'Owner' || principal.credentialId) throw new ApiError(403, 'OWNER_REQUIRED', 'Only workspace Owners can import from GitHub.');
  await access.authorize(principal, 'manage', 'repository', repository.id);
}

async function snapshot(context: ImportApiContext, canManage?: boolean): Promise<GitHubImportSnapshot> {
  const { principal, access, repository } = context;
  const manage = canManage ?? (principal.role === 'Owner' && !principal.credentialId && (await access.checkMany(principal, 'manage', [{ resourceType: 'repository', resourceId: repository.id }]))[0] === true);
  const [job, mirror] = await Promise.all([context.records.githubImport(), context.mirror()]);
  return { repositoryId: repository.id, canManage: manage, job: job ? importView(job) : null, mirror: mirror ? { owner: mirror.owner, name: mirror.name, credential: !!mirror.credential } : null };
}

function options(body: Record<string, unknown>): GitHubImportOptions {
  const flag = (value: unknown, fallback: boolean) => { if (value !== undefined && typeof value !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', 'Import options must be true or false.'); return value ?? fallback; };
  const chosen = { issues: flag(body.issues, true), pullRequests: flag(body.pullRequests, true), releases: flag(body.releases, true) };
  if (!chosen.issues && !chosen.pullRequests && !chosen.releases) throw new ApiError(400, 'INVALID_INPUT', 'Choose issues, pull requests or releases to import.');
  return chosen;
}

export interface GitHubSource { private: boolean; hasIssues: boolean; fullName: string }

export async function inspectGithubRepository(owner: string, name: string, token: string | null, fetcher?: typeof fetch, clock?: () => number): Promise<GitHubSource> {
  try {
    const { data } = await githubClient(token, fetcher, clock).get<{ private?: unknown; has_issues?: unknown; full_name?: unknown }>(`${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
    return { private: data.private === true, hasIssues: data.has_issues !== false, fullName: typeof data.full_name === 'string' ? data.full_name : `${owner}/${name}` };
  } catch (error) {
    if (error instanceof GitHubRateLimited) throw new ApiError(429, 'GITHUB_RATE_LIMITED', `GitHub’s rate limit is reached until ${new Date(error.retryAt).toISOString()}. Try again then, or add a token in the browser for a higher limit.`);
    throw error;
  }
}

async function resolveCredential(request: Request, context: ImportApiContext, body: Record<string, unknown>, target: { owner: string; name: string }, current: StoredImport | null, now: string): Promise<{ credential: StoredImportCredential | null; token: string | null }> {
  const kind = body.credential ?? (body.token ? 'token' : 'none');
  if (kind === 'none') return { credential: null, token: null };
  if (kind === 'token') {
    const token = browserOnlyToken(request, context.principal, body.token);
    if (!context.encryptionKey) throw new ApiError(503, 'AUTH_ENCRYPTION_REQUIRED', 'This installation has no AUTH_ENCRYPTION_KEY, so it cannot store credentials.');
    return { token, credential: { kind: 'token', encrypted: await encryptAuth(token, context.encryptionKey, credentialContext(context.principal.workspaceId, context.repository.id)), setBy: context.principal.userId, setAt: now } };
  }
  if (kind === 'stored') {
    if (current?.credential?.kind !== 'token' || sourceKey(current.owner, current.name) !== sourceKey(target.owner, target.name)) throw new ApiError(412, 'GITHUB_TOKEN_MISSING', 'No GitHub token is stored for this repository. Add one in the browser.');
    return { credential: current.credential, token: await decryptAuth(current.credential.encrypted, context.encryptionKey, credentialContext(context.principal.workspaceId, context.repository.id)) };
  }
  if (kind === 'mirror') {
    const mirror = await context.mirror();
    if (!mirror?.credential || sourceKey(mirror.owner, mirror.name) !== sourceKey(target.owner, target.name)) throw new ApiError(412, 'MIRROR_CREDENTIAL_MISSING', 'The GitHub mirror of this repository has no credential for that GitHub repository.');
    return { credential: { kind: 'mirror' }, token: await context.mirrorToken(mirror) };
  }
  throw new ApiError(400, 'INVALID_CREDENTIAL_KIND', 'Choose none, token, stored or mirror as the credential.');
}

export function newImportJob(fields: { requestId: string; owner: string; name: string; options: GitHubImportOptions; credential: StoredImportCredential | null; keepCredential: boolean; sourcePrivate: boolean; principal: Principal; now: string }): StoredImport {
  const job: StoredImport = {
    id: crypto.randomUUID(), requestId: fields.requestId, owner: fields.owner, name: fields.name, options: fields.options, mode: 'full', state: 'queued', phase: 'done', cursor: null,
    runId: crypto.randomUUID(), runStartedAt: fields.now, counts: emptyCounts(), skipped: [], preserveNumbers: false, sourcePrivate: fields.sourcePrivate,
    credential: fields.credential, keepCredential: fields.keepCredential, authorizedBy: durable(fields.principal), requestedBy: fields.principal.userId, startedAt: fields.now, updatedAt: fields.now, transition: { enabled: false },
  };
  return { ...job, phase: firstPhase(job) };
}

export async function handleGithubImport(request: Request, context: ImportApiContext, action: string | undefined): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  const { principal, access, repository, records } = context;
  if (request.method === 'GET' && !action) {
    await access.authorize(principal, 'read', 'repository', repository.id);
    return Response.json(await snapshot(context), { headers });
  }
  if (request.method !== 'POST' || !ACTIONS.includes(action as ImportAction)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use a supported GitHub import action.');
  assertMutationOrigin(request);
  const key = requireIdempotencyKey(request);
  const body = await readJson(request, 8192);
  await requireOwner(context);
  const audit = (name: string) => access.auditRepositoryChange(principal, `repository.github-import.${name}`, repository.id);
  const now = new Date((context.now ?? Date.now)()).toISOString();
  const current = await records.githubImport();
  const verb = action as ImportAction;
  if (verb === 'start') {
    if (current?.requestId === key) return Response.json(await snapshot(context, true), { status: 202, headers });
    if (current && active(current)) throw new ApiError(409, 'GITHUB_IMPORT_RUNNING', 'An import from GitHub is already running for this repository. Wait for it or cancel it first.');
    const target = githubTarget(body.owner, body.name);
    const chosen = options(body);
    if (body.keepCredential !== undefined && typeof body.keepCredential !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', 'keepCredential must be true or false.');
    await access.rateLimit(`github-import:${principal.userId}`, 20, 3_600_000);
    const { credential, token } = await resolveCredential(request, context, body, target, current, now);
    const source = await inspectGithubRepository(target.owner, target.name, token, context.fetcher, context.now);
    if (source.private && await context.isPublic()) throw new ApiError(409, 'PRIVATE_SOURCE_PUBLIC_TARGET', 'This Gitflare repository is public. Import a private GitHub repository only into a private repository.');
    const job = newImportJob({ requestId: key, ...target, options: chosen, credential, keepCredential: body.keepCredential === true, sourcePrivate: source.private, principal, now });
    const started = await records.changeGithubImport({ kind: 'start', job });
    await context.register(true);
    await context.dispatch(started.job!);
    await audit('start');
    return Response.json(await snapshot(context, true), { status: 202, headers });
  }
  if (!current) throw new ApiError(404, 'GITHUB_IMPORT_NOT_FOUND', 'Import from GitHub first.');
  if (verb === 'resume') {
    if (current.state === 'queued' && current.runId === key) return Response.json(await snapshot(context, true), { status: 202, headers });
    const resumed = await records.changeGithubImport({ kind: 'resume', runId: key, now });
    await context.register(true);
    await context.dispatch(resumed.job!);
    await audit('resume');
    return Response.json(await snapshot(context, true), { status: 202, headers });
  }
  if (verb === 'cancel') {
    await records.changeGithubImport({ kind: 'cancel', now });
    if (!current.transition.enabled) await context.register(false);
    await audit('cancel');
    return Response.json(await snapshot(context, true), { headers });
  }
  if (verb === 'credential') {
    const token = browserOnlyToken(request, principal, body.token);
    if (!context.encryptionKey) throw new ApiError(503, 'AUTH_ENCRYPTION_REQUIRED', 'This installation has no AUTH_ENCRYPTION_KEY, so it cannot store credentials.');
    await inspectGithubRepository(current.owner, current.name, token, context.fetcher, context.now);
    await records.changeGithubImport({ kind: 'credential', credential: { kind: 'token', encrypted: await encryptAuth(token, context.encryptionKey, credentialContext(principal.workspaceId, repository.id)), setBy: principal.userId, setAt: now }, keep: true, now });
    await audit('credential');
    return Response.json(await snapshot(context, true), { headers });
  }
  if (verb === 'remove-credential') {
    await records.changeGithubImport({ kind: 'credential', credential: null, keep: false, now });
    await audit('credential.removed');
    return Response.json(await snapshot(context, true), { headers });
  }
  if (verb === 'transition') {
    if (typeof body.enabled !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', 'enabled must be true or false.');
    if (body.enabled && current.state !== 'completed') throw new ApiError(409, 'GITHUB_IMPORT_NOT_COMPLETE', 'Finish the import before pulling GitHub issues hourly.');
    if (body.enabled && current.sourcePrivate && !current.credential) throw new ApiError(412, 'GITHUB_TOKEN_MISSING', 'A private GitHub repository needs a stored token or the mirror credential. Add a token in the browser.');
    await records.changeGithubImport({ kind: 'transition', enabled: body.enabled, now });
    await context.register(body.enabled);
    await audit(body.enabled ? 'transition.on' : 'transition.off');
    return Response.json(await snapshot(context, true), { headers });
  }
  if (verb === 'pull') {
    if (current.runId === key) return Response.json(await snapshot(context, true), { status: 202, headers });
    await access.rateLimit(`github-import-pull:${repository.id}`, 30, 3_600_000);
    const pulled = await records.changeGithubImport({ kind: 'pull', runId: key, now });
    await context.dispatch(pulled.job!);
    await audit('pull');
    return Response.json(await snapshot(context, true), { status: 202, headers });
  }
  if (current.canonical) return Response.json(await snapshot(context, true), { headers });
  if (body.notify !== undefined && typeof body.notify !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', 'notify must be true or false.');
  const canonical: GitHubImportCanonical = { at: now, by: principal.userId };
  if (body.notify === true) {
    const mirror = await context.mirror();
    const token = current.credential?.kind === 'token' ? await decryptAuth(current.credential.encrypted, context.encryptionKey, credentialContext(principal.workspaceId, repository.id))
      : mirror?.credential && sourceKey(mirror.owner, mirror.name) === sourceKey(current.owner, current.name) ? await context.mirrorToken(mirror) : null;
    if (!token) throw new ApiError(412, 'GITHUB_TOKEN_MISSING', 'Opening a notice on GitHub needs a token with Issues write access. Add one in the browser, or switch without the notice.');
    try {
      const issue = await githubClient(token, context.fetcher, context.now).post<{ html_url?: unknown }>(`${repoPath(current)}/issues`, { title: 'This project has moved to Gitflare', body: `Development continues at ${context.homeUrl}. Open new issues and proposals there.\n\nIssues and comments here are no longer copied to Gitflare.` });
      const url = githubUrl(issue.html_url, '');
      if (url) canonical.noticeUrl = url;
    } catch (error) { canonical.noticeError = importError(error).message; }
  }
  await records.changeGithubImport({ kind: 'canonical', canonical, now });
  await context.register(false);
  await audit('canonical');
  return Response.json(await snapshot(context, true), { headers });
}

export function orgRepository(raw: Record<string, unknown>): GitHubOrgRepository | null {
  const name = typeof raw.name === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(raw.name) ? raw.name : null;
  if (!name) return null;
  return {
    name, fullName: typeof raw.full_name === 'string' ? raw.full_name.slice(0, 200) : name, description: importedTitle(raw.description, ''), private: raw.private === true, archived: raw.archived === true, fork: raw.fork === true,
    defaultBranch: typeof raw.default_branch === 'string' ? raw.default_branch.slice(0, 200) : 'main', openIssues: typeof raw.open_issues_count === 'number' ? raw.open_issues_count : 0,
    pushedAt: typeof raw.pushed_at === 'string' ? timestamp(raw.pushed_at, '') || null : null, url: githubUrl(raw.html_url, `${GITHUB_ORIGIN}/${name}`),
  };
}

export async function listGithubRepositories(owner: string, page: number, token: string | null, fetcher?: typeof fetch, clock?: () => number): Promise<GitHubOrgListing> {
  const client = githubClient(token, fetcher, clock);
  const query = `per_page=100&page=${page}&sort=full_name`;
  let result: GitHubPage<unknown>;
  try {
    try { result = await client.get(`${GITHUB_API}/orgs/${encodeURIComponent(owner)}/repos?type=all&${query}`); }
    catch (error) { if (!(error instanceof ApiError) || error.code !== 'GITHUB_NOT_FOUND') throw error; result = await client.get(`${GITHUB_API}/users/${encodeURIComponent(owner)}/repos?type=owner&${query}`); }
  } catch (error) {
    if (error instanceof GitHubRateLimited) throw new ApiError(429, 'GITHUB_RATE_LIMITED', `GitHub’s rate limit is reached until ${new Date(error.retryAt).toISOString()}. Try again then, or add a token in the browser.`);
    if (error instanceof ApiError && error.code === 'GITHUB_NOT_FOUND') throw new ApiError(404, 'GITHUB_NOT_FOUND', 'GitHub has no such organization or user.');
    throw error;
  }
  if (!Array.isArray(result.data)) throw new ApiError(502, 'GITHUB_PROTOCOL', 'GitHub returned an unexpected page.');
  return { owner, repositories: (result.data as Record<string, unknown>[]).flatMap(item => { const repository = orgRepository(item); return repository ? [repository] : []; }), nextPage: result.next ? page + 1 : null };
}

export interface OrgImportRecord { id: string; requestId: string; owner: string; createdAt: string; createdBy: string; options: GitHubImportOptions; repositories: { name: string; repositoryId: string | null; error?: GitHubImportError }[] }
export interface ImportRegistryEntry { repositoryId: string; workspaceId: string }
export const ORG_IMPORTS_KEPT = 50;
export const IMPORT_REGISTRY = 'github-import-registry';
export const GITHUB_IMPORT_CRON = '0 * * * *';
