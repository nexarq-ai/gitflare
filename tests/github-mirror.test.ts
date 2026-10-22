import { afterEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Repository } from '../src/shared/types';
import type { GitHubMirrorSnapshot } from '../src/shared/github-mirror';
import type { ArtifactRepo, ArtifactsBinding } from '../src/worker/artifacts';
import type { Principal } from '../src/worker/security';
import type { StepRunner } from '../src/worker/background-work';
import { encryptAuth } from '../src/worker/mfa';
import { ApiError } from '../src/worker/domain';
import { applyMirrorChange, credentialContext, handleGithubMirror, matchesPatterns, mirrorRemotes, parseRefPatterns, runMirrorSync, runMirrorWorkflow, scheduleMirrorSync, type MirrorAccess, type MirrorApiContext, type MirrorChange, type MirrorRecords, type MirrorRunContext, type StoredMirror } from '../src/worker/github-mirror';
import { githubAppJwt, githubInstallationToken, pkcs8Der } from '../src/worker/github-app';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {}, WorkflowEntrypoint: class {} }));

const KEY = 'a'.repeat(64);
const PAT = `github_pat_${'Z9'.repeat(20)}`;
const ARTIFACTS_TOKEN = 'artifacts-ephemeral-token';
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true }); });

function git(args: string[], input?: Uint8Array): Buffer {
  const result = spawnSync('git', args, { input, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' } });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
}
function pkt(text: string): Buffer { const data = Buffer.from(text); return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]); }
function temp(prefix: string): string { const directory = mkdtempSync(join(tmpdir(), prefix)); directories.push(directory); return directory; }
function bare(): string { const directory = temp('gitflare-mirror-bare-'); git(['init', '-q', '--bare', '--initial-branch=main', directory]); return directory; }
function commit(work: string, file: string, content: string): string {
  writeFileSync(join(work, file), content); git(['-C', work, 'add', '.']); git(['-C', work, 'commit', '-qm', `Update ${file}`]);
  return git(['-C', work, 'rev-parse', 'HEAD']).toString().trim();
}
function workTree(): string { const work = temp('gitflare-mirror-work-'); git(['init', '-q', '--initial-branch=main', work]); return work; }
const refSha = (directory: string, ref: string) => { const result = spawnSync('git', ['--git-dir', directory, 'rev-parse', '--verify', '-q', ref]); return result.status === 0 ? result.stdout.toString().trim() : null; };

interface Served { dir: string; authorization: string }
function gitServer(servers: Record<string, Served>, seen: { url: string; authorization: string | null; body?: string }[] = [], fail?: (url: string) => boolean): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (fail?.(url)) throw new TypeError('network down');
    const base = Object.keys(servers).find(prefix => url.startsWith(`${prefix}/`));
    const headers = new Headers(init?.headers);
    const body = init?.body ? new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()) : undefined;
    seen.push({ url, authorization: headers.get('authorization'), ...(body ? { body: Buffer.from(body).toString('latin1') } : {}) });
    if (!base) return new Response('not found', { status: 404 });
    const server = servers[base];
    if (headers.get('authorization') !== server.authorization) return new Response('denied', { status: 401 });
    const path = url.slice(base.length);
    if (path.startsWith('/info/refs?service=')) {
      const service = path.slice('/info/refs?service='.length);
      return new Response(new Uint8Array(Buffer.concat([pkt(`# service=${service}\n`), Buffer.from('0000'), git([service.slice(4), '--stateless-rpc', '--advertise-refs', server.dir])])), { headers: { 'content-type': `application/x-${service}-advertisement` } });
    }
    const service = path.slice(1);
    return new Response(new Uint8Array(git([service.slice(4), '--stateless-rpc', server.dir], body)), { headers: { 'content-type': `application/x-${service}-result` } });
  }) as typeof fetch;
}

const owner: Principal = { userId: 'owner-1', workspaceId: 'w1', role: 'Owner', sessionId: 'session-1' };
const repository: Repository = { id: 'repo-1', workspaceId: 'w1', name: 'mirror-repo', description: '', defaultBranch: 'main', remote: 'https://artifacts.test/mirror-repo', provider: 'artifacts', headSha: null, createdAt: '', updatedAt: '' };

function artifactsFor(dir: string): ArtifactsBinding {
  const source = {
    info: async () => ({ name: 'mirror-repo', remote: 'https://artifacts.test/mirror-repo', defaultBranch: 'main' }),
    createToken: async () => ({ plaintext: ARTIFACTS_TOKEN, expiresAt: 'soon' }),
    revokeToken: async () => true,
    log: async (options?: { ref?: string; limit?: number }) => git(['--git-dir', dir, 'rev-list', `--max-count=${options?.limit ?? 1}`, options?.ref ?? 'main']).toString().trim().split('\n').filter(Boolean).map(hash => ({ hash, treeHash: '', message: '' })),
    [Symbol.dispose]: () => {},
  } as unknown as ArtifactRepo;
  return { get: async () => source, create: async () => { throw new Error('unused'); } } as unknown as ArtifactsBinding;
}

function memoryRecords(): MirrorRecords & { store: Map<string, unknown>; changes: MirrorChange[] } {
  const store = new Map<string, unknown>(); const changes: MirrorChange[] = [];
  const adapter = { get: <T>(key: string) => store.has(key) ? structuredClone(store.get(key)) as T : undefined, put: <T>(key: string, value: T) => { store.set(key, structuredClone(value)); }, delete: (key: string) => { store.delete(key); } };
  return { store, changes, githubMirror: async () => adapter.get<StoredMirror>('github-mirror') ?? null, changeGithubMirror: async change => { changes.push(change); return structuredClone(applyMirrorChange(adapter, change)); } };
}

async function linkedMirror(records: MirrorRecords, patterns = ['refs/heads/main', 'refs/tags/*']): Promise<void> {
  await records.changeGithubMirror({ kind: 'link', owner: 'acme', name: 'app', refPatterns: patterns, actor: owner.userId, now: '2026-10-17T00:00:00.000Z' });
  await records.changeGithubMirror({ kind: 'credential', credential: { kind: 'pat', encrypted: await encryptAuth(PAT, KEY, credentialContext('w1', repository.id)), setBy: owner.userId, setAt: '2026-10-17T00:00:00.000Z', authorizedBy: { userId: owner.userId, workspaceId: 'w1', role: 'Owner' } }, now: '2026-10-17T00:00:00.000Z' });
}

function setup(fail?: (url: string) => boolean) {
  const gitflare = bare(), github = bare(), work = workTree();
  const first = commit(work, 'README.md', 'one\n');
  git(['-C', work, 'tag', '-a', 'v1', '-m', 'v1']);
  git(['-C', work, 'push', '-q', gitflare, 'main', 'v1']);
  const seen: { url: string; authorization: string | null; body?: string }[] = [];
  const fetcher = gitServer({ 'https://artifacts.test/mirror-repo': { dir: gitflare, authorization: `Bearer ${ARTIFACTS_TOKEN}` }, 'https://github.com/acme/app.git': { dir: github, authorization: `Basic ${Buffer.from(`x-access-token:${PAT}`).toString('base64')}` } }, seen, fail);
  const records = memoryRecords();
  const sandbox = new Proxy({}, { get() { throw new Error('the mirror must never touch the agent sandbox'); } });
  const env = { AUTH_ENCRYPTION_KEY: KEY, ARTIFACTS: artifactsFor(gitflare), SANDBOX: sandbox };
  const authority = { check: vi.fn(async () => {}) };
  const context: MirrorRunContext = { records, remotes: mirrorRemotes(env, repository, fetcher), authority, repositoryId: repository.id };
  return { gitflare, github, work, first, seen, fetcher, records, env, context, authority };
}

let runs = 0;
const run = (context: MirrorRunContext, extra: Partial<Parameters<typeof runMirrorSync>[1]> = {}) => runMirrorSync(context, { runId: `run-${++runs}`, reason: 'test', ...extra });

describe('GitHub mirror sync', () => {
  it('pushes the default branch and tags, then each landing, without leaking credentials', async () => {
    const { gitflare, github, work, seen, records, context } = setup();
    await linkedMirror(records);
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    expect(await run(context)).toMatchObject({ state: 'synced', pushed: 2 });
    expect(refSha(github, 'refs/heads/main')).toBe(refSha(gitflare, 'refs/heads/main'));
    expect(refSha(github, 'refs/tags/v1')).toBe(refSha(gitflare, 'refs/tags/v1'));
    const landed = commit(work, 'src.txt', 'landed\n'); git(['-C', work, 'push', '-q', gitflare, 'main']);
    const scheduled = await scheduleMirrorSync(records, null, params => runMirrorSync(context, { runId: params.runId, reason: params.reason }), { repositoryId: repository.id, workspaceId: 'w1', reason: 'land' }, ['refs/heads/main']);
    expect(scheduled).toBe(true);
    expect(refSha(github, 'refs/heads/main')).toBe(landed);
    const mirror = (await records.githubMirror())!;
    expect(mirror.refs['refs/heads/main']).toMatchObject({ state: 'synced', lastSyncedSha: landed, gitflareSha: landed, githubSha: landed });
    expect(mirror.sync.state).toBe('idle');
    expect(await scheduleMirrorSync(records, null, async () => { throw new Error('must not run'); }, { repositoryId: repository.id, workspaceId: 'w1', reason: 'push' }, ['refs/heads/feature'])).toBe(false);
    expect(JSON.stringify(mirror)).not.toContain(PAT);
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(PAT);
    expect(seen.filter(call => call.url.startsWith('https://github.com')).every(call => !call.url.includes(PAT) && !call.body?.includes(PAT))).toBe(true);
  });

  it('marks divergence instead of overwriting, then imports or overwrites only on an explicit lease', async () => {
    const { gitflare, github, work, records, context } = setup();
    await linkedMirror(records, ['refs/heads/main']);
    await run(context);
    const other = workTree(); git(['-C', other, 'pull', '-q', github, 'main']);
    const githubOnly = commit(other, 'hotfix.txt', 'from github\n'); git(['-C', other, 'push', '-q', github, 'main']);
    const local = commit(work, 'src.txt', 'gitflare\n'); git(['-C', work, 'push', '-q', gitflare, 'main']);
    expect(await run(context)).toMatchObject({ state: 'diverged', diverged: ['refs/heads/main'] });
    expect(refSha(github, 'refs/heads/main')).toBe(githubOnly);
    let status = (await records.githubMirror())!.refs['refs/heads/main'];
    expect(status).toMatchObject({ state: 'diverged', gitflareSha: local, githubSha: githubOnly, error: { code: 'MIRROR_DIVERGED' } });
    expect(await run(context)).toMatchObject({ state: 'diverged' });
    expect(refSha(github, 'refs/heads/main')).toBe(githubOnly);
    const { importFromGithub } = await import('../src/worker/github-mirror');
    const imported = await importFromGithub((await records.githubMirror())!, 'refs/heads/main', context.remotes);
    expect(imported.branch).toBe(`refs/heads/github-import/main-${githubOnly.slice(0, 7)}`);
    expect(refSha(gitflare, imported.branch)).toBe(githubOnly);
    expect(await run(context, { override: { ref: 'refs/heads/main', expectedGithubSha: local } })).toMatchObject({ state: 'diverged' });
    expect((await records.githubMirror())!.refs['refs/heads/main'].error?.code).toBe('GITHUB_CHANGED');
    expect(refSha(github, 'refs/heads/main')).toBe(githubOnly);
    expect(await run(context, { override: { ref: 'refs/heads/main', expectedGithubSha: githubOnly } })).toMatchObject({ state: 'synced', pushed: 1 });
    expect(refSha(github, 'refs/heads/main')).toBe(local);
    status = (await records.githubMirror())!.refs['refs/heads/main'];
    expect(status).toMatchObject({ state: 'synced', lastSyncedSha: local });
  });

  it('fast-forwards GitHub after Gitflare lands imported GitHub commits, and Gitflare wins a rewind under the lease', async () => {
    const { gitflare, github, work, first, records, context } = setup();
    await linkedMirror(records, ['refs/heads/main']);
    await run(context);
    const second = commit(work, 'b.txt', 'b\n'); git(['-C', work, 'push', '-q', gitflare, 'main']);
    await run(context);
    expect(refSha(github, 'refs/heads/main')).toBe(second);
    git(['-C', work, 'reset', '-q', '--hard', first]); git(['-C', work, 'push', '-q', '--force', gitflare, 'main']);
    expect(await run(context)).toMatchObject({ state: 'synced', pushed: 1 });
    expect(refSha(github, 'refs/heads/main')).toBe(first);
  });

  it('retries transient GitHub failures with backoff and records failure after retries run out', async () => {
    let down = true;
    const { github, gitflare, records, context } = setup(url => down && url.startsWith('https://github.com'));
    await linkedMirror(records);
    const outcome = await run(context);
    expect(outcome.state).toBe('retrying');
    expect((await records.githubMirror())!.sync).toMatchObject({ state: 'retrying', attempt: 1, error: { code: 'MIRROR_UNREACHABLE' } });
    const step: StepRunner = { async do(_name, config, callback) { let last: unknown; for (let attempt = 0; attempt <= (config.retries?.limit ?? 0); attempt++) { try { return await callback(); } catch (error) { last = error; if (attempt === 1) down = false; } } throw last; } };
    await runMirrorWorkflow(context, { kind: 'mirror', repositoryId: repository.id, workspaceId: 'w1', reason: 'land', runId: 'workflow-1' }, step);
    expect(refSha(github, 'refs/heads/main')).toBe(refSha(gitflare, 'refs/heads/main'));
    expect((await records.githubMirror())!.sync).toMatchObject({ state: 'idle' });
    down = true;
    const never: StepRunner = { async do(_name, config, callback) { let last: unknown; for (let attempt = 0; attempt <= (config.retries?.limit ?? 0); attempt++) { try { return await callback(); } catch (error) { last = error; } } throw last; } };
    await runMirrorWorkflow(context, { kind: 'mirror', repositoryId: repository.id, workspaceId: 'w1', reason: 'land', runId: 'workflow-2' }, never);
    expect((await records.githubMirror())!.sync).toMatchObject({ state: 'failed', error: { code: 'MIRROR_UNREACHABLE' } });
  });

  it('serializes concurrent syncs and reruns once for work queued while running', async () => {
    const { records, context } = setup();
    await linkedMirror(records);
    expect((await records.changeGithubMirror({ kind: 'begin', runId: 'holder', reason: 'land', now: Date.now() })).acquired).toBe(true);
    expect(await run(context)).toMatchObject({ state: 'queued' });
    expect((await records.githubMirror())!.sync.pending).toBe(true);
    expect((await records.changeGithubMirror({ kind: 'end', runId: 'holder', sync: { state: 'idle' } })).pending).toBe(true);
  });

  it('stops when the Owner who stored the credential lost authority', async () => {
    const { github, records, context, authority } = setup();
    await linkedMirror(records);
    authority.check.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'no'));
    expect(await run(context)).toMatchObject({ state: 'failed', error: { code: 'MIRROR_AUTHORITY_REVOKED' } });
    expect(refSha(github, 'refs/heads/main')).toBeNull();
  });

  it('never reaches the agent sandbox or its runner', () => {
    for (const file of ['src/worker/github-mirror.ts', 'src/worker/git-transfer.ts', 'src/worker/github-app.ts', 'src/worker/github-mirror-runtime.ts']) {
      const source = readFileSync(join(__dirname, '..', file), 'utf8');
      expect(source, file).not.toMatch(/SANDBOX|runner\/sandbox|getSandbox/);
    }
    for (const file of ['src/worker/execution.ts', 'runner/sandbox.ts']) expect(readFileSync(join(__dirname, '..', file), 'utf8'), file).not.toMatch(/github-mirror|GITHUB_APP|githubMirror/);
  });

  it('validates ref patterns', () => {
    expect(parseRefPatterns(undefined, 'trunk')).toEqual(['refs/heads/trunk', 'refs/tags/*']);
    expect(() => parseRefPatterns(['main'], 'main')).toThrow(ApiError);
    expect(() => parseRefPatterns(['refs/heads/../x'], 'main')).toThrow(ApiError);
    expect(matchesPatterns('refs/heads/release/1.2', ['refs/heads/release/*'])).toBe(true);
    expect(matchesPatterns('refs/heads/main2', ['refs/heads/main'])).toBe(false);
  });
});

function access(overrides: Partial<MirrorAccess> = {}): MirrorAccess & { audits: string[] } {
  const audits: string[] = [];
  return { audits, authorize: async () => {}, checkMany: async () => [true], rateLimit: async () => {}, auditRepositoryChange: async (_p, action) => { audits.push(action); }, installationCredentialAdmin: async () => false, ...overrides };
}

function apiRequest(action: string | undefined, body?: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  const url = `https://gitflare.test/api/repositories/${repository.id}/github-mirror${action ? `/${action}` : ''}`;
  return body ? new Request(url, { method: 'POST', headers: { Origin: 'https://gitflare.test', 'Content-Type': 'application/json', 'Idempotency-Key': `key-${crypto.randomUUID()}`, ...headers }, body: JSON.stringify(body) }) : new Request(url);
}

describe('GitHub mirror API', () => {
  function api(principal: Principal, fixture = setup(), grants = access()) {
    const context: MirrorApiContext = {
      env: fixture.env, repository, principal, access: grants, records: fixture.records, remotes: fixture.context.remotes, fetcher: fixture.fetcher,
      run: options => runMirrorSync(fixture.context, { runId: `api-${++runs}`, ...options }),
      schedule: async reason => { await runMirrorSync(fixture.context, { runId: `api-${++runs}`, reason }); return true; },
      freshRepository: async () => refSha(fixture.gitflare, 'refs/heads/main') === null,
      recordHead: async () => {},
    };
    return { fixture, grants, call: async (action: string | undefined, body?: Record<string, unknown>, headers?: Record<string, string>) => handleGithubMirror(apiRequest(action, body, headers), context, action) };
  }
  const json = async (response: Response) => await response.json() as GitHubMirrorSnapshot & Record<string, unknown>;

  it('is Owner-only for every change and refuses task credentials', async () => {
    for (const principal of [{ ...owner, role: 'Maintainer' as const }, { ...owner, credentialId: 'task-credential' }]) {
      const { call } = api(principal);
      for (const action of ['link', 'credential', 'sync', 'overwrite', 'import', 'adopt', 'unlink']) await expect(call(action, { owner: 'acme', name: 'app' })).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    }
    const { call } = api({ ...owner, role: 'Viewer' });
    expect((await json(await call(undefined))).canManage).toBe(false);
  });

  it('stores a verified token write-only, rejects it from API and MCP clients, and syncs on request', async () => {
    const { call, fixture, grants } = api(owner);
    const linked = await json(await call('link', { owner: 'acme', name: 'app' }));
    expect(linked.mirror).toMatchObject({ owner: 'acme', name: 'app', refPatterns: ['refs/heads/main', 'refs/tags/*'], credential: null });
    await expect(call('credential', { kind: 'pat', token: PAT }, { Authorization: 'Bearer gitflare-token' })).rejects.toMatchObject({ code: 'BROWSER_REQUIRED' });
    await expect(call('credential', { kind: 'pat', token: `github_pat_${'x'.repeat(30)}` })).rejects.toMatchObject({ code: 'MIRROR_AUTH_REJECTED' });
    const responses = [await call('credential', { kind: 'pat', token: PAT }), await call(undefined), await call('sync', {})];
    const texts = await Promise.all(responses.map(response => response.text()));
    for (const text of texts) { expect(text).not.toContain(PAT); expect(text).not.toContain('encrypted'); }
    expect(JSON.parse(texts[1]).mirror.credential).toMatchObject({ kind: 'pat', setBy: owner.userId });
    expect(refSha(fixture.github, 'refs/heads/main')).toBe(refSha(fixture.gitflare, 'refs/heads/main'));
    expect(grants.audits).toEqual(['repository.github-mirror.link', 'repository.github-mirror.credential.pat', 'repository.github-mirror.sync']);
    await expect(call('link', { owner: 'acme', name: 'other' })).rejects.toMatchObject({ code: 'MIRROR_CREDENTIAL_BOUND' });
  });

  it('adopts GitHub once into an empty repository and then mirrors back', async () => {
    const fixture = setup();
    const emptyGitflare = bare();
    git(['--git-dir', fixture.github, 'fetch', '-q', fixture.gitflare, 'refs/heads/main:refs/heads/main', 'refs/tags/v1:refs/tags/v1']);
    const servers = gitServer({ 'https://artifacts.test/mirror-repo': { dir: emptyGitflare, authorization: `Bearer ${ARTIFACTS_TOKEN}` }, 'https://github.com/acme/app.git': { dir: fixture.github, authorization: `Basic ${Buffer.from(`x-access-token:${PAT}`).toString('base64')}` } });
    const env = { ...fixture.env, ARTIFACTS: artifactsFor(emptyGitflare) };
    const adoptedFixture = { ...fixture, gitflare: emptyGitflare, fetcher: servers, env, context: { ...fixture.context, remotes: mirrorRemotes(env, repository, servers) } };
    const { call } = api(owner, adoptedFixture);
    await linkedMirror(fixture.records);
    const request = apiRequest('adopt', {});
    const key = request.headers.get('Idempotency-Key')!;
    const context = (body: Request) => handleGithubMirror(body, { env, repository, principal: owner, access: access(), records: fixture.records, remotes: adoptedFixture.context.remotes, fetcher: servers, run: async () => ({ state: 'synced', pushed: 0, diverged: [] }), schedule: async () => true, freshRepository: async () => refSha(emptyGitflare, 'refs/heads/main') === null, recordHead: async () => {} }, 'adopt');
    const adopted = await json(await context(request));
    expect(adopted.mirror?.adoptedAt).toBeTruthy();
    expect(refSha(emptyGitflare, 'refs/heads/main')).toBe(refSha(fixture.github, 'refs/heads/main'));
    expect(refSha(emptyGitflare, 'refs/tags/v1')).toBe(refSha(fixture.github, 'refs/tags/v1'));
    expect((await context(new Request(request.url, { method: 'POST', headers: { Origin: 'https://gitflare.test', 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: '{}' }))).status).toBe(200);
    await expect(call('adopt', {})).rejects.toMatchObject({ code: 'MIRROR_ALREADY_ADOPTED' });
    expect(adopted.mirror?.refs.every(ref => ref.state === 'synced')).toBe(true);
  });
});

describe('GitHub App installation tokens', () => {
  it('signs an RS256 app JWT from a PKCS#1 key and requests a repository-scoped token', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    expect(pkcs8Der(pem).length).toBeGreaterThan(1000);
    const jwt = await githubAppJwt({ appId: '1234', privateKey: pem }, 1_800_000_000_000);
    const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({ iat: 1_799_999_940, exp: 1_800_000_540, iss: '1234' });
    expect(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ repositories: ['app'], permissions: { contents: 'write' } });
      return Response.json({ token: 'ghs_installation' }, { status: 201 });
    }) as unknown as typeof fetch;
    expect(await githubInstallationToken({ appId: '1234', privateKey: pem }, 42, 'app', fetcher)).toBe('ghs_installation');
    expect(String(vi.mocked(fetcher).mock.calls[0][0])).toBe('https://api.github.com/app/installations/42/access_tokens');
  });
});
