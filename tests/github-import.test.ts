import { afterEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Issue, IssueComment, Release, Repository } from '../src/shared/types';
import type { GitHubImportSnapshot } from '../src/shared/github-import';
import type { StepRunner } from '../src/worker/background-work';
import type { Principal } from '../src/worker/security';
import { ApiError } from '../src/worker/domain';
import { applyImportChange, fetchPullHeads, githubClient, GitHubRateLimited, handleGithubImport, importedPullMissions, importedReleaseIds, importView, newImportJob, pullStream, runImportSlice, runImportWorkflow, type ImportApiContext, type ImportChange, type ImportRecords, type ImportRunContext, type ImportServices, type ImportStore, type StoredImport } from '../src/worker/github-import';
import { ISSUE_LIMIT, issuePeopleIds, listIssues, readIssue, type IssueStore } from '../src/worker/issues';
import { handleMcp } from '../src/worker/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {}, WorkflowEntrypoint: class {} }));

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true }); });

const API = 'https://api.github.com/repos/acme/app';
const PAT = `github_pat_${'Q7'.repeat(20)}`;
const owner: Principal = { userId: 'owner-1', workspaceId: 'w1', role: 'Owner', sessionId: 'session-1' };
const now = '2026-10-20T10:00:00.000Z';

function memoryStore(): ImportStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get: <T>(key: string) => values.has(key) ? structuredClone(values.get(key)) as T : undefined,
    put: (key, value) => { values.set(key, structuredClone(value)); },
    delete: (key) => { values.delete(key); },
    list: <T>(prefix: string) => [...values.keys()].filter(key => key.startsWith(prefix)).sort().map(key => structuredClone(values.get(key)) as T),
  };
}

function records(store = memoryStore()): ImportRecords & { store: ReturnType<typeof memoryStore>; changes: ImportChange[] } {
  const changes: ImportChange[] = [];
  return {
    store, changes,
    githubImport: async () => store.get<StoredImport>('github-import') ?? null,
    changeGithubImport: async (change) => { changes.push(change); return structuredClone(applyImportChange(store, structuredClone(change))); },
    importedPulls: async (source, numbers) => importedPullMissions(store, source, numbers),
    importedReleases: async (source, ids) => importedReleaseIds(store, source, ids),
  };
}

type Route = (url: URL, init?: RequestInit) => Response | undefined;
interface FakeGithub { issues: Record<string, unknown>[]; comments: Record<string, unknown>[]; labels: Record<string, unknown>[]; pulls: Record<string, unknown>[]; releases: Record<string, unknown>[]; repo: Record<string, unknown>; requireToken?: boolean }

function paged(url: URL, items: unknown[]): Response {
  const perPage = Number(url.searchParams.get('per_page') ?? 30), page = Number(url.searchParams.get('page') ?? 1);
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const headers = new Headers({ 'content-type': 'application/json' });
  if (page * perPage < items.length) { const next = new URL(url); next.searchParams.set('page', String(page + 1)); headers.set('link', `<${next}>; rel="next", <https://api.github.com/x?page=99>; rel="last"`); }
  return new Response(JSON.stringify(slice), { headers });
}

function fakeGithub(data: FakeGithub, seen: { url: string; authorization: string | null; method: string }[] = [], override?: Route): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    seen.push({ url: url.toString(), authorization: headers.get('authorization'), method: init?.method ?? 'GET' });
    const custom = override?.(url, init);
    if (custom) return custom;
    if (data.requireToken && headers.get('authorization') !== `Bearer ${PAT}`) return new Response('{"message":"Not Found"}', { status: 404 });
    const path = url.pathname.replace('/repos/acme/app', '');
    if (url.pathname === '/repos/acme/app') return Response.json(data.repo);
    if (path === '/labels') return paged(url, data.labels);
    if (path === '/issues' && init?.method === 'POST') return Response.json({ html_url: 'https://github.com/acme/app/issues/999' }, { status: 201 });
    if (path === '/issues') {
      const since = url.searchParams.get('since');
      return paged(url, since ? data.issues.filter(issue => String(issue.updated_at) >= since) : data.issues);
    }
    if (path === '/issues/comments') {
      const since = url.searchParams.get('since');
      return paged(url, since ? data.comments.filter(comment => String(comment.updated_at) >= since) : data.comments);
    }
    if (path === '/pulls') return paged(url, data.pulls);
    if (path === '/releases') return paged(url, data.releases);
    return new Response('{"message":"Not Found"}', { status: 404 });
  }) as typeof fetch;
}

const user = (login: string) => ({ login });
function issue(number: number, fields: Record<string, unknown> = {}) {
  return { number, title: `Issue ${number}`, body: `Body ${number}`, state: 'open', html_url: `https://github.com/acme/app/issues/${number}`, user: user('octo'), labels: [], created_at: `2026-01-01T00:00:${String(number % 60).padStart(2, '0')}Z`, updated_at: '2026-01-02T00:00:00Z', ...fields };
}
function comment(id: number, issueNumber: number, body = `Comment ${id}`, fields: Record<string, unknown> = {}) {
  return { id, body, issue_url: `${API}/issues/${issueNumber}`, html_url: `https://github.com/acme/app/issues/${issueNumber}#issuecomment-${id}`, user: user('reviewer'), created_at: '2026-01-03T00:00:00Z', updated_at: '2026-01-03T00:00:00Z', ...fields };
}

function baseData(): FakeGithub {
  return {
    repo: { private: false, has_issues: true, full_name: 'acme/app' },
    labels: [{ name: 'bug', color: 'D73A4A', description: 'Something is broken' }, { name: 'needs, triage', color: 'zzz', description: '' }],
    issues: [
      issue(1, { labels: [{ name: 'bug' }], title: 'Crash\u0000 on start', body: '<script>alert(1)</script> **bold**\r\nline' }),
      issue(2, { state: 'closed', state_reason: 'not_planned', closed_at: '2026-01-05T00:00:00Z' }),
      issue(3, { pull_request: { merged_at: '2026-01-04T00:00:00Z' }, state: 'closed', title: 'Merged PR' }),
      issue(4, { pull_request: { merged_at: null }, state: 'open', title: 'Open PR' }),
      issue(5, { user: user('dependabot[bot]') }),
    ],
    comments: [comment(11, 1, 'first'), comment(12, 1, 'second'), comment(13, 2), comment(14, 4, 'on open PR'), comment(15, 1, 'third')],
    pulls: [{ number: 4, title: 'Open PR', body: 'Please merge', html_url: 'https://github.com/acme/app/pull/4', user: user('contrib'), head: { sha: 'a'.repeat(40) }, base: { ref: 'main' } }],
    releases: [
      { id: 101, tag_name: 'v1.0.0', name: 'One', body: 'Notes', draft: false, prerelease: false, html_url: 'https://github.com/acme/app/releases/tag/v1.0.0', author: user('octo'), created_at: '2026-01-06T00:00:00Z', published_at: '2026-01-06T00:00:00Z', assets: [{ name: 'app[1].zip', browser_download_url: 'https://github.com/acme/app/releases/download/v1.0.0/app.zip', size: 4096 }] },
      { id: 102, tag_name: 'v2.0.0', name: 'Missing tag', body: '', draft: false },
      { id: 103, tag_name: 'v3', name: 'Draft', draft: true },
    ],
  };
}

function services(overrides: Partial<ImportServices> = {}): ImportServices & { opened: number[][] } {
  const opened: number[][] = [];
  return {
    opened,
    repository: async () => ({ id: 'repo-1', workspaceId: 'w1', name: 'app', description: '', defaultBranch: 'main', provider: 'artifacts', headSha: 'f'.repeat(40), createdAt: now, updatedAt: now }),
    isPublic: async () => false,
    token: async (job) => job.credential ? PAT : null,
    tagCommit: async (tag) => tag === 'v1.0.0' ? 'c'.repeat(40) : null,
    openProposals: async (_job, pulls) => { opened.push(pulls.map(pull => pull.number)); return { proposals: pulls.map(pull => ({ number: pull.number, missionId: `mission-${pull.number}` })), skipped: [] }; },
    check: async () => {},
    ...overrides,
  };
}

async function started(store: ImportRecords, options = { issues: true, pullRequests: true, releases: true }, fields: Partial<Parameters<typeof newImportJob>[0]> = {}) {
  const job = newImportJob({ requestId: `start-${Math.random().toString(36).slice(2)}-key`, owner: 'acme', name: 'app', options, credential: null, keepCredential: false, sourcePrivate: false, principal: owner, now, ...fields });
  return (await store.changeGithubImport({ kind: 'start', job })).job!;
}

async function drain(context: ImportRunContext, runId: string, limit = 50) {
  const results = [];
  for (let index = 0; index < limit; index++) {
    const result = await runImportSlice(context, runId, 60_000);
    results.push(result);
    if (result.state !== 'continue') break;
  }
  return results;
}

const issuesOf = (store: IssueStore) => store.list<Issue>('issue:');
const commentsOf = (store: IssueStore, number: number) => readIssue(store, number)!.comments as (IssueComment & { importedFrom?: { author: string } })[];

describe('GitHub import job', () => {
  it('imports labels, issues, comments, pull requests and releases with preserved numbers, placeholders and sanitized text', async () => {
    const data = baseData(), seen: { url: string; authorization: string | null; method: string }[] = [];
    const store = records();
    const job = await started(store);
    const svc = services();
    const context: ImportRunContext = { repositoryId: 'repo-1', records: store, services: svc, fetcher: fakeGithub(data, seen), now: () => Date.parse(now) };
    expect((await drain(context, job.runId)).at(-1)).toEqual({ state: 'done' });
    const final = (await store.githubImport())!;
    expect(final).toMatchObject({ state: 'completed', phase: 'done', preserveNumbers: true, credential: null });
    expect(final.counts).toMatchObject({ labels: 2, issues: 3, pullRequests: 1, proposals: 1, comments: 4, releases: 1 });
    expect(final.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'comment', ref: '#4 comment 14' }),
      expect.objectContaining({ kind: 'release', ref: 'v2.0.0', reason: expect.stringContaining('not in this repository') }),
    ]));
    const issues = issuesOf(store.store);
    expect(issues.map(item => item.number)).toEqual([1, 2, 3, 5]);
    const first = issues[0]!;
    expect(first).toMatchObject({ title: 'Crash on start', body: '<script>alert(1)</script> **bold**\nline', authorId: 'github:octo', labels: ['bug'], importedFrom: { source: 'github', author: 'octo', number: 1, url: 'https://github.com/acme/app/issues/1' } });
    expect(issues[1]).toMatchObject({ state: 'closed', closedReason: 'not_planned' });
    expect(issues[2]).toMatchObject({ state: 'closed', closedReason: 'completed', importedFrom: { pullRequest: { merged: true } } });
    expect(issues[3]!.authorId).toBe('github:dependabot[bot]');
    expect(commentsOf(store.store, 1).map(item => item.body)).toEqual(['first', 'second', 'third']);
    expect(commentsOf(store.store, 1)[0]!.authorId).toBe('github:reviewer');
    expect(issuePeopleIds(readIssue(store.store, 1)!)).toEqual([]);
    expect(store.store.get('issue-label-definitions')).toEqual([{ name: 'bug', color: '#d73a4a', description: 'Something is broken' }, { name: 'needs triage', color: expect.stringMatching(/^#[0-9a-f]{6}$/), description: '' }]);
    const [release] = store.store.list<Release>('release:');
    expect(release).toMatchObject({ tag: 'v1.0.0', targetSha: 'c'.repeat(40), draft: false, authorId: 'github:octo', importedFrom: { url: 'https://github.com/acme/app/releases/tag/v1.0.0' } });
    expect(release!.notes).toContain('[app\\[1\\].zip](https://github.com/acme/app/releases/download/v1.0.0/app.zip) (4 KiB)');
    expect(svc.opened).toEqual([[4]]);
    expect(seen.every(request => request.authorization === null)).toBe(true);
    expect(seen.some(request => request.url.includes('/issues?state=all&sort=created'))).toBe(true);
  });

  it('pages through every result with the Link header', async () => {
    const data = baseData();
    data.issues = Array.from({ length: 250 }, (_, index) => issue(index + 1));
    data.comments = Array.from({ length: 230 }, (_, index) => comment(1000 + index, (index % 250) + 1));
    data.labels = []; data.pulls = []; data.releases = [];
    const store = records();
    const job = await started(store);
    const seen: { url: string; authorization: string | null; method: string }[] = [];
    await drain({ repositoryId: 'repo-1', records: store, services: services(), fetcher: fakeGithub(data, seen), now: () => Date.parse(now) }, job.runId);
    expect((await store.githubImport())!.counts).toMatchObject({ issues: 250, comments: 230 });
    expect(seen.filter(request => request.url.includes('/issues?')).length).toBe(3);
    expect(seen.filter(request => request.url.includes('/issues/comments?')).length).toBe(3);
    expect(listIssues(store.store, { state: 'all' }).total).toBe(250);
    expect(listIssues(store.store, { state: 'all', offset: 200 }).items.map(item => item.number).slice(0, 2)).toEqual([50, 49]);
  });

  it('waits for GitHub rate limits and resumes from the saved page', async () => {
    const data = baseData();
    data.issues = Array.from({ length: 150 }, (_, index) => issue(index + 1));
    let primary = false, secondary = false;
    const clock = { now: Date.parse(now) };
    const fetcher = fakeGithub(data, [], (url) => {
      if (url.pathname.endsWith('/issues') && url.searchParams.get('page') === '2' && !primary) { primary = true; return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(clock.now / 1000) + 120) } }); }
      if (url.pathname.endsWith('/issues/comments') && !secondary) { secondary = true; return new Response('{}', { status: 429, headers: { 'retry-after': '30' } }); }
      return undefined;
    });
    const store = records();
    const job = await started(store);
    const context: ImportRunContext = { repositoryId: 'repo-1', records: store, services: services(), fetcher, now: () => clock.now };
    const first = await runImportSlice(context, job.runId, 60_000);
    expect(first).toEqual({ state: 'wait', waitMs: 121_000 });
    expect(await store.githubImport()).toMatchObject({ state: 'waiting', phase: 'issues', cursor: expect.stringContaining('page=2'), retryAt: new Date(clock.now + 121_000).toISOString(), error: { code: 'GITHUB_RATE_LIMITED' } });
    expect((await store.githubImport())!.counts.issues).toBe(100);
    clock.now += 121_000;
    expect(await runImportSlice(context, job.runId, 60_000)).toEqual({ state: 'wait', waitMs: 30_000 });
    clock.now += 30_000;
    await drain(context, job.runId);
    expect(await store.githubImport()).toMatchObject({ state: 'completed', counts: expect.objectContaining({ issues: 150 }) });
    expect(issuesOf(store.store)).toHaveLength(150);
  });

  it('sleeps through rate limits inside the workflow and resumes after transient failures', async () => {
    const data = baseData();
    let failures = 0, limited = false;
    const clock = { now: Date.parse(now) };
    const fetcher = fakeGithub(data, [], (url) => {
      if (url.pathname.endsWith('/issues/comments') && failures < 2) { failures++; return new Response('oops', { status: 502 }); }
      if (url.pathname.endsWith('/releases') && !limited) { limited = true; return new Response('{}', { status: 403, headers: { 'retry-after': '90' } }); }
      return undefined;
    });
    const store = records();
    const job = await started(store);
    const sleeps: number[] = [];
    const step: StepRunner = {
      async do(_name, config, callback) { for (let attempt = 0; ; attempt++) { try { return await callback(); } catch (error) { if (attempt >= (config.retries?.limit ?? 0)) throw error; } } },
      async sleep(_name, duration) { sleeps.push(duration); clock.now += duration; },
    };
    await runImportWorkflow({ repositoryId: 'repo-1', records: store, services: services(), fetcher, now: () => clock.now }, { kind: 'github-import', repositoryId: 'repo-1', workspaceId: 'w1', runId: job.runId, generation: 0 }, step, async () => {});
    expect(sleeps).toEqual([90_000]);
    expect(await store.githubImport()).toMatchObject({ state: 'completed', counts: expect.objectContaining({ comments: 4, releases: 1 }) });
    expect(store.changes.filter(change => change.kind === 'error')).toHaveLength(2);
    expect(commentsOf(store.store, 1).map(item => item.body)).toEqual(['first', 'second', 'third']);
  });

  it('marks the job failed after exhausted retries and resumes where it stopped', async () => {
    const data = baseData();
    let down = true;
    const fetcher = fakeGithub(data, [], (url) => down && url.pathname.endsWith('/issues/comments') ? new Response('down', { status: 503 }) : undefined);
    const store = records();
    const job = await started(store);
    const step: StepRunner = { async do(_name, _config, callback) { return callback(); } };
    const context: ImportRunContext = { repositoryId: 'repo-1', records: store, services: services(), fetcher, now: () => Date.parse(now) };
    await runImportWorkflow(context, { kind: 'github-import', repositoryId: 'repo-1', workspaceId: 'w1', runId: job.runId, generation: 0 }, step, async () => {});
    expect(await store.githubImport()).toMatchObject({ state: 'failed', phase: 'comments', error: { code: 'GITHUB_UNAVAILABLE' } });
    expect(issuesOf(store.store)).toHaveLength(4);
    down = false;
    await store.changeGithubImport({ kind: 'resume', runId: 'resume-run-000001', now });
    await drain(context, 'resume-run-000001');
    expect(await store.githubImport()).toMatchObject({ state: 'completed', counts: expect.objectContaining({ issues: 3, comments: 4 }) });
    expect(issuesOf(store.store)).toHaveLength(4);
  });

  it('is idempotent when run again and maps numbers when the repository already has issues', async () => {
    const data = baseData();
    const store = records();
    store.store.put('issue-count', 2);
    store.store.put('issue:000001', { repositoryId: 'repo-1', number: 1, title: 'Local', body: '', state: 'open', labels: [], assignees: [], missionIds: [], authorId: 'u1', createdAt: now, updatedAt: now, commentCount: 0 });
    store.store.put('issue:000002', { repositoryId: 'repo-1', number: 2, title: 'Local 2', body: '', state: 'open', labels: [], assignees: [], missionIds: [], authorId: 'u1', createdAt: now, updatedAt: now, commentCount: 0 });
    const svc = services();
    const first = await started(store);
    expect(first.preserveNumbers).toBe(false);
    await drain({ repositoryId: 'repo-1', records: store, services: svc, fetcher: fakeGithub(data), now: () => Date.parse(now) }, first.runId);
    const mapped = issuesOf(store.store).filter(item => item.importedFrom).map(item => [item.importedFrom!.number, item.number]);
    expect(mapped).toEqual([[1, 3], [2, 4], [3, 5], [5, 6]]);
    data.issues[0] = { ...data.issues[0]!, title: 'Crash on start (edited)', updated_at: '2026-02-01T00:00:00Z' };
    data.comments[0] = { ...data.comments[0]!, body: 'first (edited)', updated_at: '2026-02-01T00:00:00Z' };
    const again = await started(store);
    expect(again.preserveNumbers).toBe(false);
    await drain({ repositoryId: 'repo-1', records: store, services: svc, fetcher: fakeGithub(data), now: () => Date.parse(now) }, again.runId);
    const final = (await store.githubImport())!;
    expect(final.counts).toMatchObject({ issues: 0, comments: 0, labels: 0, releases: 0, proposals: 0, updated: 2 });
    expect(issuesOf(store.store)).toHaveLength(6);
    expect(readIssue(store.store, 3)).toMatchObject({ title: 'Crash on start (edited)', commentCount: 3 });
    expect(commentsOf(store.store, 3)[0]).toMatchObject({ body: 'first (edited)', editedAt: '2026-02-01T00:00:00.000Z' });
    expect(svc.opened).toEqual([[4]]);
    expect(store.store.list('release:')).toHaveLength(1);
  });

  it('refuses a private GitHub repository anonymously and imports it with a token, never into a public repository', async () => {
    const data = { ...baseData(), requireToken: true, repo: { private: true } };
    const store = records();
    const anonymous = await started(store);
    await drain({ repositoryId: 'repo-1', records: store, services: services(), fetcher: fakeGithub(data), now: () => Date.parse(now) }, anonymous.runId);
    expect(await store.githubImport()).toMatchObject({ state: 'failed', error: { code: 'GITHUB_NOT_FOUND', message: expect.stringContaining('add a read-only token in the browser') } });
    const withToken = await started(store, undefined, { credential: { kind: 'token', encrypted: 'sealed', setBy: owner.userId, setAt: now }, sourcePrivate: true });
    const blocked = services({ isPublic: async () => true });
    await drain({ repositoryId: 'repo-1', records: store, services: blocked, fetcher: fakeGithub(data), now: () => Date.parse(now) }, withToken.runId);
    expect(await store.githubImport()).toMatchObject({ state: 'failed', error: { code: 'PRIVATE_SOURCE_PUBLIC_TARGET' } });
    expect(issuesOf(store.store)).toHaveLength(0);
    const again = await started(store, undefined, { credential: { kind: 'token', encrypted: 'sealed', setBy: owner.userId, setAt: now }, sourcePrivate: true });
    const seen: { url: string; authorization: string | null; method: string }[] = [];
    await drain({ repositoryId: 'repo-1', records: store, services: services(), fetcher: fakeGithub(data, seen), now: () => Date.parse(now) }, again.runId);
    expect(await store.githubImport()).toMatchObject({ state: 'completed', credential: null });
    expect(seen.every(request => request.authorization === `Bearer ${PAT}`)).toBe(true);
    expect(issuesOf(store.store)).toHaveLength(4);
  });

  it('stops when the Owner who started it loses access and waits for the code import before proposals', async () => {
    const store = records();
    const job = await started(store);
    await drain({ repositoryId: 'repo-1', records: store, services: services({ check: async () => { throw new ApiError(403, 'FORBIDDEN', 'no'); } }), fetcher: fakeGithub(baseData()), now: () => Date.parse(now) }, job.runId);
    expect(await store.githubImport()).toMatchObject({ state: 'failed', error: { code: 'GITHUB_IMPORT_AUTHORITY_REVOKED' } });
    const pending = await started(store, { issues: false, pullRequests: false, releases: true });
    const importing = services({ repository: async () => ({ id: 'repo-1', name: 'app', description: '', defaultBranch: 'main', provider: 'artifacts', headSha: null, createdAt: now, updatedAt: now, urlImport: { source: 'https://github.com/acme/app', provider: 'github', status: 'importing', phase: 'fetching', attempt: 1, requestId: 'r', authenticated: false, startedAt: now, updatedAt: now } }) });
    expect(await runImportSlice({ repositoryId: 'repo-1', records: store, services: importing, fetcher: fakeGithub(baseData()), now: () => Date.parse(now) }, pending.runId)).toEqual({ state: 'wait', waitMs: 60_000 });
    expect(await store.githubImport()).toMatchObject({ state: 'waiting', error: { code: 'WAITING_FOR_CODE' } });
  });

  it('pulls updated issues and comments during the transition and stops once Gitflare is canonical', async () => {
    const data = baseData();
    const store = records();
    const job = await started(store, undefined, { keepCredential: true, credential: { kind: 'token', encrypted: 'sealed', setBy: owner.userId, setAt: now } });
    const seen: { url: string; authorization: string | null; method: string }[] = [];
    const context: ImportRunContext = { repositoryId: 'repo-1', records: store, services: services(), fetcher: fakeGithub(data, seen), now: () => Date.parse('2026-10-20T12:00:00.000Z') };
    await drain(context, job.runId);
    expect((await store.githubImport())!.credential).not.toBeNull();
    await store.changeGithubImport({ kind: 'transition', enabled: true, now });
    data.issues.push(issue(6, { title: 'New on GitHub', created_at: '2026-10-20T11:00:00Z', updated_at: '2026-10-20T11:00:00Z' }));
    data.comments.push(comment(16, 6, 'reply', { created_at: '2026-10-20T11:30:00Z', updated_at: '2026-10-20T11:30:00Z' }));
    const pulled = (await store.changeGithubImport({ kind: 'pull', runId: 'pull-run-0000001', now: '2026-10-20T12:00:00.000Z' })).job!;
    expect(pulled).toMatchObject({ mode: 'pull', phase: 'issues', since: '2026-10-20T09:55:00.000Z' });
    seen.length = 0;
    await drain(context, 'pull-run-0000001');
    expect(seen.map(request => new URL(request.url).pathname)).toEqual(['/repos/acme/app/issues', '/repos/acme/app/issues/comments']);
    expect(seen.every(request => request.url.includes('since=2026-10-20T09%3A55%3A00.000Z'))).toBe(true);
    const after = (await store.githubImport())!;
    expect(after).toMatchObject({ state: 'completed', mode: 'pull', transition: { enabled: true, lastPullAt: '2026-10-20T12:00:00.000Z' } });
    expect(readIssue(store.store, 6)).toMatchObject({ title: 'New on GitHub', commentCount: 1 });
    await store.changeGithubImport({ kind: 'canonical', canonical: { at: now, by: owner.userId }, now });
    const canonical = (await store.githubImport())!;
    expect(canonical).toMatchObject({ canonical: { by: owner.userId }, transition: { enabled: false }, credential: null });
    await expect(store.changeGithubImport({ kind: 'transition', enabled: true, now })).rejects.toMatchObject({ code: 'GITFLARE_CANONICAL' });
    await expect(store.changeGithubImport({ kind: 'pull', runId: 'pull-run-0000002', now })).rejects.toMatchObject({ code: 'TRANSITION_OFF' });
  });

  it('skips issues beyond the repository limit', async () => {
    const store = records();
    store.store.put('issue-count', ISSUE_LIMIT);
    store.store.put('issue:000001', { repositoryId: 'repo-1', number: 1, title: 'x', body: '', state: 'open', labels: [], assignees: [], missionIds: [], authorId: 'u', createdAt: now, updatedAt: now, commentCount: 0 });
    const job = await started(store, { issues: true, pullRequests: false, releases: false });
    await drain({ repositoryId: 'repo-1', records: store, services: services(), fetcher: fakeGithub(baseData()), now: () => Date.parse(now) }, job.runId);
    const final = (await store.githubImport())!;
    expect(final.counts.issues).toBe(0);
    expect(final.skipped.filter(item => item.kind === 'issue')[0]).toMatchObject({ reason: expect.stringContaining('50,000') });
  });
});

describe('GitHub REST client', () => {
  it('follows only API links and classifies errors', async () => {
    const client = githubClient(null, (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/one')) return new Response('[1]', { headers: { link: '<https://evil.test/two>; rel="next"' } });
      if (url.endsWith('/gone')) return new Response('', { status: 401 });
      if (url.endsWith('/abuse')) return new Response('', { status: 403 });
      if (url.endsWith('/secondary')) return new Response('', { status: 403, headers: { 'retry-after': '5' } });
      return new Response('', { status: 500 });
    }) as typeof fetch, () => 1_000);
    expect(await client.get('https://api.github.com/one')).toEqual({ data: [1], next: null });
    await expect(client.get('https://evil.test/x')).rejects.toMatchObject({ code: 'GITHUB_PROTOCOL' });
    await expect(client.get('https://api.github.com/gone')).rejects.toMatchObject({ code: 'GITHUB_TOKEN_REJECTED' });
    await expect(client.get('https://api.github.com/abuse')).rejects.toMatchObject({ code: 'GITHUB_FORBIDDEN' });
    await expect(client.get('https://api.github.com/secondary')).rejects.toEqual(expect.objectContaining({ retryAt: 6_000 }));
    await expect(client.get('https://api.github.com/secondary')).rejects.toBeInstanceOf(GitHubRateLimited);
    await expect(client.get('https://api.github.com/other')).rejects.toMatchObject({ code: 'GITHUB_UNAVAILABLE' });
  });
});

function git(args: string[], input?: Uint8Array): Buffer {
  const result = spawnSync('git', args, { input, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' } });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
}
function pkt(text: string): Buffer { const data = Buffer.from(text); return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]); }
function temp(prefix: string): string { const directory = mkdtempSync(join(tmpdir(), prefix)); directories.push(directory); return directory; }
function bare(): string { const directory = temp('gitflare-import-bare-'); git(['init', '-q', '--bare', '--initial-branch=main', directory]); return directory; }

function gitServer(servers: Record<string, { dir: string; authorization: string | null }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const base = Object.keys(servers).find(prefix => url.startsWith(`${prefix}/`));
    const headers = new Headers(init?.headers);
    if (!base) return new Response('not found', { status: 404 });
    const server = servers[base]!;
    if (headers.get('authorization') !== server.authorization) return new Response('denied', { status: 401 });
    const body = init?.body ? new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()) : undefined;
    const path = url.slice(base.length);
    if (path.startsWith('/info/refs?service=')) {
      const service = path.slice('/info/refs?service='.length);
      return new Response(new Uint8Array(Buffer.concat([pkt(`# service=${service}\n`), Buffer.from('0000'), git([service.slice(4), '--stateless-rpc', '--advertise-refs', server.dir])])), { headers: { 'content-type': `application/x-${service}-advertisement` } });
    }
    const service = path.slice(1);
    return new Response(new Uint8Array(git([service.slice(4), '--stateless-rpc', server.dir], body)), { headers: { 'content-type': `application/x-${service}-result` } });
  }) as typeof fetch;
}

describe('open pull requests as proposals', () => {
  it('fetches refs/pull/N/head into github-pr/N with the exact GitHub head SHA, anonymously', async () => {
    const github = bare(), gitflare = bare(), work = temp('gitflare-import-work-');
    git(['init', '-q', '--initial-branch=main', work]);
    writeFileSync(join(work, 'README.md'), 'one\n'); git(['-C', work, 'add', '.']); git(['-C', work, 'commit', '-qm', 'one']);
    git(['-C', work, 'push', '-q', github, 'main']); git(['-C', work, 'push', '-q', gitflare, 'main']);
    writeFileSync(join(work, 'feature.txt'), 'pr\n'); git(['-C', work, 'add', '.']); git(['-C', work, 'commit', '-qm', 'feature']);
    const head = git(['-C', work, 'rev-parse', 'HEAD']).toString().trim();
    git(['-C', work, 'push', '-q', github, `HEAD:refs/pull/7/head`]);
    const fetcher = gitServer({ 'https://github.com/acme/app.git': { dir: github, authorization: null }, 'https://artifacts.test/app': { dir: gitflare, authorization: 'Bearer write-token' } });
    const released = vi.fn(async () => {});
    const pulls = [{ number: 7, title: 'Feature', description: 'x', url: 'https://github.com/acme/app/pull/7', author: 'contrib', headSha: head, baseRef: 'main' }, { number: 8, title: 'Gone', description: 'x', url: 'https://github.com/acme/app/pull/8', author: 'contrib', headSha: head, baseRef: 'main' }];
    const results = await fetchPullHeads({ url: 'https://github.com/acme/app.git', authorization: '', label: 'GitHub' }, { remote: { url: 'https://artifacts.test/app', authorization: 'Bearer write-token', label: 'Gitflare storage' }, release: released }, pulls, fetcher);
    expect(results).toEqual([{ number: 7, headSha: head }, { number: 8, reason: expect.stringContaining('no longer advertises') }]);
    expect(git(['--git-dir', gitflare, 'rev-parse', `refs/heads/${pullStream(7)}`]).toString().trim()).toBe(head);
    expect(released).toHaveBeenCalledOnce();
    const again = await fetchPullHeads({ url: 'https://github.com/acme/app.git', authorization: '', label: 'GitHub' }, { remote: { url: 'https://artifacts.test/app', authorization: 'Bearer write-token', label: 'Gitflare storage' }, release: released }, pulls.slice(0, 1), fetcher);
    expect(again).toEqual([{ number: 7, headSha: head }]);
  });
});

function apiContext(overrides: Partial<ImportApiContext> = {}, data = baseData()): ImportApiContext & { dispatched: StoredImport[]; registered: boolean[]; audits: string[]; store: ReturnType<typeof records> } {
  const store = records();
  const dispatched: StoredImport[] = [], registered: boolean[] = [], audits: string[] = [];
  const repository: Repository = { id: 'repo-1', workspaceId: 'w1', name: 'app', description: '', defaultBranch: 'main', provider: 'artifacts', headSha: null, createdAt: now, updatedAt: now };
  return {
    dispatched, registered, audits, store,
    repository, principal: owner, records: store, encryptionKey: 'a'.repeat(64), fetcher: fakeGithub(data), homeUrl: 'https://gitflare.test/repository/repo-1',
    access: {
      authorize: async (principal, action) => { if (principal.role !== 'Owner' && action === 'manage') throw new ApiError(403, 'FORBIDDEN', 'no'); },
      checkMany: async (principal) => [principal.role === 'Owner'],
      rateLimit: async () => {},
      auditRepositoryChange: async (_principal, action) => { audits.push(action); },
    },
    mirror: async () => null,
    mirrorToken: async () => PAT,
    isPublic: async () => false,
    dispatch: async (job) => { dispatched.push(job); },
    register: async (enabled) => { registered.push(enabled); },
    ...overrides,
  };
}

const post = (action: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => new Request(`https://gitflare.test/api/repositories/repo-1/github-import/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://gitflare.test', 'idempotency-key': `key-${action}-0000000001`, ...headers }, body: JSON.stringify(body) });

describe('GitHub import API', () => {
  it('starts an anonymous import, replays the same request and reports progress without credentials', async () => {
    const context = apiContext();
    const response = await handleGithubImport(post('start', { owner: 'acme', name: 'app' }), context, 'start');
    expect(response.status).toBe(202);
    const body = await response.json() as GitHubImportSnapshot;
    expect(body.job).toMatchObject({ owner: 'acme', name: 'app', state: 'queued', phase: 'labels', credential: 'none', preserveNumbers: true, sourcePrivate: false });
    expect(context.dispatched).toHaveLength(1);
    expect(context.registered).toEqual([true]);
    expect(context.audits).toEqual(['repository.github-import.start']);
    await handleGithubImport(post('start', { owner: 'acme', name: 'app' }), context, 'start');
    expect(context.dispatched).toHaveLength(1);
    await expect(handleGithubImport(post('start', { owner: 'acme', name: 'other' }, { 'idempotency-key': 'key-start-other-0001' }), context, 'start')).rejects.toMatchObject({ code: 'GITHUB_IMPORT_RUNNING' });
    const read = await handleGithubImport(new Request('https://gitflare.test/api/repositories/repo-1/github-import'), context, undefined);
    expect(JSON.stringify(await read.json())).not.toContain('encrypted');
  });

  it('accepts a token only from a signed-in browser and stores it encrypted', async () => {
    const data = { ...baseData(), requireToken: true, repo: { private: true } };
    const context = apiContext({}, data);
    await expect(handleGithubImport(post('start', { owner: 'acme', name: 'app', credential: 'token', token: PAT }, { authorization: 'Bearer gfp_x' }), context, 'start')).rejects.toMatchObject({ code: 'BROWSER_REQUIRED' });
    await expect(handleGithubImport(post('start', { owner: 'acme', name: 'app', credential: 'token', token: PAT }), { ...context, principal: { ...owner, sessionId: undefined } }, 'start')).rejects.toMatchObject({ code: 'BROWSER_REQUIRED' });
    await expect(handleGithubImport(post('start', { owner: 'acme', name: 'app' }), context, 'start')).rejects.toMatchObject({ code: 'GITHUB_NOT_FOUND' });
    const response = await handleGithubImport(post('start', { owner: 'acme', name: 'app', credential: 'token', token: PAT, keepCredential: true }, { 'idempotency-key': 'key-start-token-00001' }), context, 'start');
    expect((await response.json() as GitHubImportSnapshot).job).toMatchObject({ credential: 'token', keepCredential: true, sourcePrivate: true });
    const stored = (await context.store.githubImport())!;
    expect(stored.credential).toMatchObject({ kind: 'token' });
    expect(JSON.stringify(stored)).not.toContain(PAT);
  });

  it('refuses a private source for a public repository, non-Owners and task credentials', async () => {
    const data = { ...baseData(), repo: { private: true } };
    await expect(handleGithubImport(post('start', { owner: 'acme', name: 'app' }), apiContext({ isPublic: async () => true }, data), 'start')).rejects.toMatchObject({ code: 'PRIVATE_SOURCE_PUBLIC_TARGET' });
    await expect(handleGithubImport(post('start', { owner: 'acme', name: 'app' }), apiContext({ principal: { ...owner, role: 'Maintainer' } }), 'start')).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    await expect(handleGithubImport(post('start', { owner: 'acme', name: 'app' }), apiContext({ principal: { ...owner, credentialId: 'cred-1' } }), 'start')).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
  });

  it('uses the mirror credential only for the same GitHub repository', async () => {
    const mirror = { owner: 'acme', name: 'app', refPatterns: [], credential: { kind: 'pat' as const, encrypted: 'x', setBy: 'o', setAt: now, authorizedBy: owner }, linkedBy: 'o', linkedAt: now, updatedAt: now, refs: {}, sync: { state: 'idle' as const } };
    const data = { ...baseData(), requireToken: true, repo: { private: true } };
    const context = apiContext({ mirror: async () => mirror }, data);
    await expect(handleGithubImport(post('start', { owner: 'acme', name: 'other', credential: 'mirror' }), context, 'start')).rejects.toMatchObject({ code: 'MIRROR_CREDENTIAL_MISSING' });
    const response = await handleGithubImport(post('start', { owner: 'acme', name: 'app', credential: 'mirror' }, { 'idempotency-key': 'key-start-mirror-0001' }), context, 'start');
    expect((await response.json() as GitHubImportSnapshot).job).toMatchObject({ credential: 'mirror' });
  });

  it('cancels, resumes, turns the transition pull on and off, and switches to canonical with a GitHub notice', async () => {
    const seen: { url: string; authorization: string | null; method: string }[] = [];
    const context = apiContext({ fetcher: fakeGithub(baseData(), seen) });
    await handleGithubImport(post('start', { owner: 'acme', name: 'app', credential: 'token', token: PAT, keepCredential: true }), context, 'start');
    await handleGithubImport(post('cancel', {}), context, 'cancel');
    expect((await context.store.githubImport())!.state).toBe('canceled');
    await expect(handleGithubImport(post('resume', {}), context, 'resume')).rejects.toMatchObject({ code: 'GITHUB_IMPORT_FINISHED' });
    await handleGithubImport(post('start', { owner: 'acme', name: 'app', credential: 'stored', keepCredential: true }, { 'idempotency-key': 'key-start-again-00001' }), context, 'start');
    const job = (await context.store.githubImport())!;
    await drain({ repositoryId: 'repo-1', records: context.store, services: services(), fetcher: fakeGithub(baseData()), now: () => Date.parse(now) }, job.runId);
    await handleGithubImport(post('transition', { enabled: true }), context, 'transition');
    expect(context.registered.at(-1)).toBe(true);
    const pull = await handleGithubImport(post('pull', {}), context, 'pull');
    expect(((await pull.json()) as GitHubImportSnapshot).job).toMatchObject({ mode: 'pull', state: 'queued' });
    await handleGithubImport(post('cancel', {}, { 'idempotency-key': 'key-cancel-pull-00001' }), context, 'cancel');
    const switched = await handleGithubImport(post('canonical', { notify: true }), context, 'canonical');
    const view = ((await switched.json()) as GitHubImportSnapshot).job!;
    expect(view).toMatchObject({ canonical: { by: owner.userId, noticeUrl: 'https://github.com/acme/app/issues/999' }, transition: { enabled: false }, credential: 'none' });
    expect(seen.find(request => request.method === 'POST')).toMatchObject({ url: `${API}/issues`, authorization: `Bearer ${PAT}` });
    expect(context.registered.at(-1)).toBe(false);
  });

  it('never exposes the stored token in the view', () => {
    const job = newImportJob({ requestId: 'r', owner: 'acme', name: 'app', options: { issues: true, pullRequests: false, releases: false }, credential: { kind: 'token', encrypted: 'sealed-secret', setBy: 'o', setAt: now }, keepCredential: true, sourcePrivate: true, principal: owner, now });
    expect(JSON.stringify(importView(job))).not.toContain('sealed-secret');
    expect(importView(job).credential).toBe('token');
  });
});

describe('issue index', () => {
  it('rebuilds the listing index for repositories created before it and keeps search working', () => {
    const store = memoryStore();
    for (let number = 1; number <= 3; number++) store.put(`issue:${String(number).padStart(6, '0')}`, { repositoryId: 'r', number, title: `Old ${number}`, body: number === 2 ? 'mentions checkout' : '', state: 'open', labels: number === 3 ? ['Bug'] : [], assignees: [], missionIds: [], authorId: 'u', createdAt: now, updatedAt: now, commentCount: 0 });
    store.put('issue-count', 3);
    expect(listIssues(store).items.map(item => item.number)).toEqual([3, 2, 1]);
    expect(store.get('issue-index-ready')).toBe(true);
    expect(listIssues(store, { q: 'checkout' }).items.map(item => item.number)).toEqual([2]);
    expect(listIssues(store, { label: 'bug' }).items.map(item => item.number)).toEqual([3]);
  });
});

describe('GitHub import over MCP', () => {
  async function connectAs(access: string, api: (request: Request) => Promise<Response>) {
    const client = new Client({ name: 'gitflare-import-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('https://gitflare.test/mcp'), { fetch: (input, init) => {
      const request = new Request(input, init);
      request.headers.set('Host', 'gitflare.test');
      request.headers.set('X-Gitflare-Access', access);
      return handleMcp(request, api);
    } }));
    return client;
  }

  it('forwards the same routes as the UI, never carries a token and needs admin access to write', async () => {
    const forwarded: { method: string; path: string; body: unknown; key: string | null }[] = [];
    const api = async (request: Request) => {
      forwarded.push({ method: request.method, path: new URL(request.url).pathname, body: request.method === 'POST' ? await request.json() : null, key: request.headers.get('Idempotency-Key') });
      return Response.json({ repositoryId: 'repo-1', canManage: true, job: null, mirror: null });
    };
    const admin = await connectAs('admin', api);
    await admin.callTool({ name: 'gitflare_import_github', arguments: { repository_id: 'repo-1', action: 'start', owner: 'acme', name: 'app', pull_requests: false, credential: 'mirror', idempotency_key: 'import-key-000000001' } });
    expect(forwarded.at(-1)).toEqual({ method: 'POST', path: '/api/repositories/repo-1/github-import/start', body: { owner: 'acme', name: 'app', pullRequests: false, credential: 'mirror' }, key: 'import-key-000000001' });
    await admin.callTool({ name: 'gitflare_import_github', arguments: { repository_id: 'repo-1', action: 'transition-on', idempotency_key: 'import-key-000000002' } });
    expect(forwarded.at(-1)).toMatchObject({ path: '/api/repositories/repo-1/github-import/transition', body: { enabled: true } });
    const setup = await admin.callTool({ name: 'gitflare_import_github', arguments: { repository_id: 'repo-1', action: 'credential-setup', idempotency_key: 'import-key-000000003' } });
    expect(JSON.parse((setup.content as { text: string }[])[0]!.text)).toMatchObject({ browserStartUrl: 'https://gitflare.test/repository/repo-1/settings#github-import', browserEntryRequired: true });
    await admin.callTool({ name: 'gitflare_import_github_organization', arguments: { owner: 'acme', repositories: ['app', 'site'], idempotency_key: 'import-key-000000004' } });
    expect(forwarded.at(-1)).toMatchObject({ path: '/api/github-import/organizations', body: { owner: 'acme', repositories: ['app', 'site'] } });
    await admin.callTool({ name: 'gitflare_github_organization', arguments: { view: 'repositories', owner: 'acme' } });
    expect(forwarded.at(-1)).toMatchObject({ method: 'POST', path: '/api/github-import/organizations/repositories', body: { owner: 'acme', page: 1 }, key: null });
    const tools = (await admin.listTools()).tools;
    const start = tools.find(tool => tool.name === 'gitflare_import_github')!;
    expect(Object.keys((start.inputSchema as { properties: Record<string, unknown> }).properties)).not.toContain('token');
    const write = await connectAs('write', api);
    const before = forwarded.length;
    const refused = await write.callTool({ name: 'gitflare_import_github', arguments: { repository_id: 'repo-1', action: 'cancel', idempotency_key: 'import-key-000000005' } });
    expect(refused.isError).toBe(true);
    expect(forwarded).toHaveLength(before);
    const read = await connectAs('read', api);
    expect((await read.callTool({ name: 'gitflare_github_import', arguments: { repository_id: 'repo-1' } })).isError).toBeFalsy();
    expect(forwarded.at(-1)).toMatchObject({ method: 'GET', path: '/api/repositories/repo-1/github-import' });
    for (const client of [admin, write, read]) await client.close();
  });
});
