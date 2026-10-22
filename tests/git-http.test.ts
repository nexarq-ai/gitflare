import { describe, expect, it, vi } from 'vitest';
import type { Repository } from '../src/shared/types';
import type { ArtifactsBinding } from '../src/worker/artifacts';
import { defaultBranchRule, normalizeBranchRule } from '../src/worker/branch-protection';
import { GitProtocolError, handleGitRequest, isLsRefsRequest, parseAdvertisedRefs, rewriteAdvertisedHead, parseReceivePackCommands, pktLine, receivePackReport, type GitHttpDependencies } from '../src/worker/git-http';
import { ApiError } from '../src/worker/domain';
import type { Action, Principal } from '../src/worker/security';

const a = 'a'.repeat(40), b = 'b'.repeat(40), zero = '0'.repeat(40);
const encoder = new TextEncoder(), decoder = new TextDecoder();
const join = (...parts: (string | Uint8Array)[]): Uint8Array<ArrayBuffer> => { const bytes = parts.map(part => typeof part === 'string' ? encoder.encode(part) : part); const out = new Uint8Array(bytes.reduce((n, part) => n + part.length, 0)); let offset = 0; for (const part of bytes) { out.set(part, offset); offset += part.length; } return out; };
const commands = (...lines: string[]) => join(...lines.map(pktLine), '0000');

describe('receive-pack command parsing', () => {
  it('parses an update with capabilities and stops at the flush packet', () => {
    const body = join(commands(`${a} ${b} refs/heads/feature\0report-status side-band-64k agent=git/2.45\n`), 'PACK');
    const parsed = parseReceivePackCommands(body)!;
    expect(parsed.updates).toEqual([{ oldSha: a, newSha: b, ref: 'refs/heads/feature' }]);
    expect(parsed.capabilities).toEqual(['report-status', 'side-band-64k', 'agent=git/2.45']);
    expect(decoder.decode(body.subarray(parsed.end))).toBe('PACK');
  });

  it('parses deletes, tags and multiple refs, skipping shallow lines', () => {
    const parsed = parseReceivePackCommands(commands(`shallow ${a}`, `${a} ${zero} refs/heads/old\0report-status`, `${zero} ${b} refs/tags/v1`, `${a} ${b} refs/heads/main`))!;
    expect(parsed.updates.map(update => [update.ref, update.newSha === zero])).toEqual([['refs/heads/old', true], ['refs/tags/v1', false], ['refs/heads/main', false]]);
  });

  it('returns null for an incomplete command section', () => {
    const full = commands(`${a} ${b} refs/heads/feature\0report-status`);
    expect(parseReceivePackCommands(full.subarray(0, full.length - 4))).toBeNull();
    expect(parseReceivePackCommands(full.subarray(0, 10))).toBeNull();
  });

  it.each([
    ['zzzz', 'length'],
    ['0003', 'length'],
    [join(pktLine(`${a} ${b}\n`), '0000'), 'invalid ref update'],
    [join(pktLine(`${a} ${b} heads/main\n`), '0000'), 'invalid ref update'],
    [join(pktLine(`${a} ${b} refs/heads/a~1\n`), '0000'), 'invalid ref update'],
    [join(pktLine(`${zero} ${zero} refs/heads/a\n`), '0000'), 'invalid ref update'],
    [join(pktLine(`${a} ${b} refs/heads/a\n`), pktLine(`${a} ${b} refs/heads/c\0report-status\n`), '0000'), 'capabilities'],
    [join(pktLine('push-cert\0report-status\n'), '0000'), 'signed pushes'],
    ['0000', 'no ref updates'],
  ])('rejects malformed input %#', (input, message) => {
    expect(() => parseReceivePackCommands(typeof input === 'string' ? encoder.encode(input) : input)).toThrow(GitProtocolError);
    expect(() => parseReceivePackCommands(typeof input === 'string' ? encoder.encode(input) : input)).toThrow(message);
  });

  it('writes report-status rejections in and out of side-band', () => {
    const decisions = [{ ref: 'refs/heads/main', ok: false as const, reason: 'protected branch' }, { ref: 'refs/heads/feature', ok: true as const }];
    const plain = decoder.decode(receivePackReport(decisions, ['report-status']));
    expect(plain).toBe('000eunpack ok\n0028ng refs/heads/main protected branch\n004bng refs/heads/feature not updated because refs/heads/main was rejected\n0000');
    const banded = receivePackReport(decisions, ['report-status', 'side-band-64k']);
    const text = decoder.decode(banded);
    expect(text).toContain('\x02Gitflare rejected refs/heads/main: protected branch');
    expect(text).toContain('\x01000eunpack ok');
    expect(text.endsWith('0000')).toBe(true);
  });

  it('reads branch heads from an upload-pack advertisement', () => {
    const advertisement = join(pktLine('# service=git-upload-pack\n'), '0000', pktLine(`${a} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`), pktLine(`${a} refs/heads/main\n`), pktLine(`${b} refs/heads/feature/x\n`), pktLine(`${b} refs/tags/v1\n`), '0000');
    expect([...parseAdvertisedRefs(advertisement)]).toEqual([['main', a], ['feature/x', b]]);
  });
});

function fixture(role: Principal['role'] = 'Contributor', rules = [defaultBranchRule('main')]) {
  const repository = { id: 'repo', name: 'site', defaultBranch: 'main', provider: 'artifacts', headSha: a } as Repository;
  const principal: Principal = { userId: 'user', workspaceId: 'ws', role };
  const allowed: Record<string, Action[]> = { Viewer: ['read'], Contributor: ['read', 'contribute', 'execute'], Maintainer: ['read', 'contribute', 'execute', 'review', 'land'], Owner: ['read', 'contribute', 'execute', 'review', 'land', 'manage'], Reviewer: ['read', 'review'], Deployer: ['read'] };
  const forwarded: { url: string; headers: Headers; body: Uint8Array }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), headers = new Headers(init?.headers);
    const body = init?.body ? new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()) : new Uint8Array();
    forwarded.push({ url, headers, body });
    const service = url.includes('receive-pack') ? 'git-receive-pack' : 'git-upload-pack';
    return new Response('upstream', { headers: { 'Content-Type': url.includes('info/refs') ? `application/x-${service}-advertisement` : `application/x-${service}-result` } });
  }) as unknown as typeof fetch;
  const createToken = vi.fn(async (scope: string) => ({ plaintext: `artifacts-${scope}-secret`, expiresAt: '' }));
  const artifacts = { get: vi.fn(async () => ({ info: async () => ({ name: 'site', remote: 'https://acct.artifacts.cloudflare.net/git/site.git', defaultBranch: 'main' }), createToken, revokeToken: async () => true, [Symbol.dispose]: () => {} })) } as unknown as ArtifactsBinding;
  const deps: GitHttpDependencies = {
    authenticate: async (token) => { if (token !== 'personal-token') throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in'); return principal; },
    authorize: async (_p, action) => { if (!allowed[role]!.includes(action)) throw new ApiError(403, 'FORBIDDEN', 'No'); },
    repository: async (_p, name) => name === 'site' ? repository : undefined,
    rules: async () => rules,
    artifacts, fetcher,
  };
  const basic = (password = 'personal-token') => `Basic ${btoa(`anything:${password}`)}`;
  const push = (body: Uint8Array<ArrayBuffer>, authorization = basic()) => handleGitRequest(new Request('https://gitflare.test/git/site.git/git-receive-pack', { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/x-git-receive-pack-request' }, body }), deps);
  return { deps, forwarded, fetcher, createToken, push, basic };
}

describe('authenticated Git endpoint', () => {
  it('ignores other paths and challenges missing or invalid credentials', async () => {
    const f = fixture();
    expect(await handleGitRequest(new Request('https://gitflare.test/api/workspace'), f.deps)).toBeNull();
    const missing = (await handleGitRequest(new Request('https://gitflare.test/git/site.git/info/refs?service=git-upload-pack'), f.deps))!;
    expect(missing.status).toBe(401);
    expect(missing.headers.get('WWW-Authenticate')).toContain('Basic realm="Gitflare"');
    const invalid = (await handleGitRequest(new Request('https://gitflare.test/git/site.git/info/refs?service=git-upload-pack', { headers: { Authorization: f.basic('wrong') } }), f.deps))!;
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get('WWW-Authenticate')).toContain('Basic');
    expect((await handleGitRequest(new Request('https://gitflare.test/git/other.git/info/refs?service=git-upload-pack', { headers: { Authorization: f.basic() } }), f.deps))!.status).toBe(404);
    expect((await handleGitRequest(new Request('https://gitflare.test/git/site.git/info/refs?service=git-upload-archive', { headers: { Authorization: f.basic() } }), f.deps))!.status).toBe(403);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('lets a viewer clone with a short-lived read token but refuses push discovery', async () => {
    const f = fixture('Viewer');
    const refs = (await handleGitRequest(new Request('https://gitflare.test/git/site.git/info/refs?service=git-upload-pack', { headers: { Authorization: f.basic(), 'Git-Protocol': 'version=2' } }), f.deps))!;
    expect(refs.status).toBe(200);
    expect(refs.headers.get('Content-Type')).toBe('application/x-git-upload-pack-advertisement');
    expect(f.forwarded[0]).toMatchObject({ url: 'https://acct.artifacts.cloudflare.net/git/site.git/info/refs?service=git-upload-pack' });
    expect(f.forwarded[0]!.headers.get('Authorization')).toBe('Bearer artifacts-read-secret');
    expect(f.forwarded[0]!.headers.get('Git-Protocol')).toBe('version=2');
    expect(f.createToken).toHaveBeenCalledWith('read', 60);
    const discovery = (await handleGitRequest(new Request('https://gitflare.test/git/site.git/info/refs?service=git-receive-pack', { headers: { Authorization: f.basic() } }), f.deps))!;
    expect(discovery.status).toBe(403);
    expect(await discovery.text()).toContain('cannot push');
    expect((await f.push(commands(`${a} ${b} refs/heads/feature\0report-status`)))!.status).toBe(403);
    expect(f.createToken).not.toHaveBeenCalledWith('write', 60);
  });

  it('rejects protected branch, default deletion and tag pushes without contacting storage', async () => {
    const f = fixture('Owner');
    for (const line of [`${a} ${b} refs/heads/main`, `${a} ${zero} refs/heads/main`, `${zero} ${b} refs/tags/v1.0.0`]) {
      const response = (await f.push(join(commands(`${line}\0report-status side-band-64k`), 'PACK-data')))!;
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/x-git-receive-pack-result');
      expect(decoder.decode(await response.arrayBuffer())).toMatch(/ng refs\/(heads\/main|tags\/v1\.0\.0) (protected branch|the default branch cannot be deleted|tags are managed)/);
    }
    const plain = (await f.push(commands(`${a} ${b} refs/heads/main`)))!;
    expect(plain.status).toBe(403);
    expect(await plain.text()).toContain('open a pull request');
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('forwards an allowed feature-branch push byte for byte with a write token', async () => {
    const f = fixture('Contributor');
    const body = join(commands(`${zero} ${b} refs/heads/feature/login\0report-status`), 'PACK', new Uint8Array([0, 1, 2, 255]));
    const response = (await f.push(body))!;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('upstream');
    expect(f.forwarded[0]!.url).toBe('https://acct.artifacts.cloudflare.net/git/site.git/git-receive-pack');
    expect(f.forwarded[0]!.headers.get('Authorization')).toBe('Bearer artifacts-write-secret');
    expect([...f.forwarded[0]!.body]).toEqual([...body]);
  });

  it('allows a direct push to a protected branch only for permitted landers when pull requests are optional', async () => {
    const rules = [normalizeBranchRule({ pattern: 'main', requirePullRequest: false, restrictLanders: ['Owner'] })];
    const body = commands(`${a} ${b} refs/heads/main\0report-status`);
    const contributor = fixture('Contributor', rules);
    expect(decoder.decode(await (await contributor.push(body))!.arrayBuffer())).toContain('only Owner landers');
    const maintainer = fixture('Maintainer', rules);
    expect(decoder.decode(await (await maintainer.push(body))!.arrayBuffer())).toContain('only Owner landers');
    const owner = fixture('Owner', rules);
    expect(await (await owner.push(body))!.text()).toBe('upstream');
  });

  it('rejects malformed and oversized pushes', async () => {
    const f = fixture();
    expect((await f.push(encoder.encode('zzzz')))!.status).toBe(400);
    const large = await handleGitRequest(new Request('https://gitflare.test/git/site.git/git-receive-pack', { method: 'POST', headers: { Authorization: f.basic(), 'Content-Type': 'application/x-git-receive-pack-request', 'Content-Length': String(200 * 1024 * 1024) }, body: 'x' }), f.deps);
    expect(large!.status).toBe(413);
    const wrongType = await handleGitRequest(new Request('https://gitflare.test/git/site.git/git-receive-pack', { method: 'POST', headers: { Authorization: f.basic() }, body: 'x' }), f.deps);
    expect(wrongType!.status).toBe(415);
  });
});

describe('Artifacts handle lifetime', () => {
  it('keeps the repository handle open until forwarding has used it', async () => {
    const f = fixture('Contributor');
    let disposed = false;
    const handle = { info: async () => { if (disposed) throw new Error('RPC stub used after being disposed.'); return { name: 'site', remote: 'https://acct.artifacts.cloudflare.net/git/site.git', defaultBranch: 'main' }; }, createToken: async () => { if (disposed) throw new Error('RPC stub used after being disposed.'); return { plaintext: 'token', expiresAt: '' }; }, revokeToken: async () => true, [Symbol.dispose]: () => { disposed = true; } };
    const deps = { ...f.deps, artifacts: { get: vi.fn(async () => handle) } as unknown as ArtifactsBinding };
    const refs = (await handleGitRequest(new Request('https://gitflare.test/git/site.git/info/refs?service=git-upload-pack', { headers: { Authorization: f.basic() } }), deps))!;
    expect(refs.status).toBe(200);
    expect(disposed).toBe(true);
  });
});

describe('advertised HEAD', () => {
  const advertisement = (head: string, symref: string) => join(pktLine('# service=git-upload-pack\n'), '0000', pktLine(`${head} HEAD\0multi_ack symref=HEAD:refs/heads/${symref} agent=git/2\n`), pktLine(`${a} refs/heads/main\n`), pktLine(`${b} refs/heads/claude/pending\n`), '0000');

  it('points the v0/v1 advertisement and v2 ls-refs at the repository default branch', () => {
    expect(decoder.decode(rewriteAdvertisedHead(advertisement(b, 'claude/pending'), 'main'))).toBe(decoder.decode(advertisement(a, 'main')));
    const lsRefs = (head: string, target: string) => join(pktLine(`${head} HEAD symref-target:refs/heads/${target}\n`), pktLine(`${a} refs/heads/main\n`), pktLine(`${b} refs/heads/claude/pending\n`), '0000');
    expect(decoder.decode(rewriteAdvertisedHead(lsRefs(b, 'claude/pending'), 'main'))).toBe(decoder.decode(lsRefs(a, 'main')));
    const unchanged = advertisement(b, 'claude/pending');
    expect(rewriteAdvertisedHead(unchanged, 'missing')).toBe(unchanged);
    const garbage = join('not pkt-lines');
    expect(rewriteAdvertisedHead(garbage, 'main')).toBe(garbage);
  });

  it('detects v2 ls-refs commands', () => {
    expect(isLsRefsRequest(join(pktLine('command=ls-refs\n'), pktLine('agent=git/2\n'), '0001', pktLine('symrefs\n'), '0000'))).toBe(true);
    expect(isLsRefsRequest(join(pktLine('command=fetch\n'), '0000'))).toBe(false);
    expect(isLsRefsRequest(join(pktLine(`want ${a}\n`), '0000'))).toBe(false);
  });

  it('rewrites the HEAD a client sees on clone discovery and ls-refs, but not pack data', async () => {
    const f = fixture('Viewer');
    const upstream: Record<string, Uint8Array<ArrayBuffer>> = {
      refs: advertisement(b, 'claude/pending'),
      'ls-refs': join(pktLine(`${b} HEAD symref-target:refs/heads/claude/pending\n`), pktLine(`${a} refs/heads/main\n`), '0000'),
      fetch: join(pktLine(`${b} HEAD\n`), '0000'),
    };
    f.deps.fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? decoder.decode(new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer())) : '';
      const kind = url.includes('info/refs') ? 'refs' : body.includes('command=ls-refs') ? 'ls-refs' : 'fetch';
      return new Response(upstream[kind], { headers: { 'Content-Type': kind === 'refs' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-upload-pack-result' } });
    }) as unknown as typeof fetch;
    const refs = await handleGitRequest(new Request('https://gitflare.test/git/site.git/info/refs?service=git-upload-pack', { headers: { Authorization: f.basic() } }), f.deps);
    expect(await refs!.text()).toContain(`${a} HEAD\0multi_ack symref=HEAD:refs/heads/main`);
    const rpc = (body: Uint8Array<ArrayBuffer>) => handleGitRequest(new Request('https://gitflare.test/git/site.git/git-upload-pack', { method: 'POST', headers: { Authorization: f.basic(), 'Content-Type': 'application/x-git-upload-pack-request', 'Git-Protocol': 'version=2' }, body }), f.deps);
    expect(await (await rpc(join(pktLine('command=ls-refs\n'), '0001', pktLine('symrefs\n'), '0000')))!.text()).toContain(`${a} HEAD symref-target:refs/heads/main`);
    expect(await (await rpc(join(pktLine('command=fetch\n'), '0001', pktLine(`want ${b}\n`), '0000')))!.text()).toContain(`${b} HEAD`);
  });
});
