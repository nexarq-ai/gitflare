import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import type { ArtifactRepo, ArtifactsBinding } from '../src/worker/artifacts';
import { buildInitializationPack, initialRepositoryFiles, initializeArtifactsRepository, validateRepositoryInitialization } from '../src/worker/repository-initialization';

const directories: string[] = [];
const options = { initializeReadme: true, gitignore: 'Node' as const, license: 'MIT' as const, copyrightHolder: 'Example Maintainers' };
const input = { name: 'test-repository', description: 'A test repository', options };
function git(args: string[], input?: Uint8Array) { const result = spawnSync('git', args, { input, encoding: null }); if (result.status !== 0) throw new Error(result.stderr.toString()); return result.stdout; }
function emptyRepository() { const directory = mkdtempSync(join(tmpdir(), 'gitflare-initialize-')); directories.push(directory); git(['init', '--bare', '--initial-branch=main', directory]); return directory; }
function pkt(text: string) { const payload = Buffer.from(text); return Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, '0')), payload]); }
function nativeTransport(directory: string, beforePush?: () => void) {
  const revokeToken = vi.fn(async () => true);
  const repository = { info: async () => ({ name: input.name, remote: 'https://artifacts.example/repository', defaultBranch: 'main' }), createToken: vi.fn(async () => ({ plaintext: 'test-capability', expiresAt: 'soon' })), revokeToken, log: async () => [{ hash: git(['--git-dir', directory, 'rev-parse', 'refs/heads/main']).toString().trim(), message: '', treeHash: '' }], [Symbol.dispose]: () => {} } as unknown as ArtifactRepo;
  const artifacts = { get: async () => repository } as unknown as ArtifactsBinding;
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes('/info/refs?')) {
      const refs = git(['receive-pack', '--stateless-rpc', '--advertise-refs', directory]);
      return new Response(new Uint8Array(Buffer.concat([pkt('# service=git-receive-pack\n'), Buffer.from('0000'), refs])), { headers: { 'content-type': 'application/x-git-receive-pack-advertisement' } });
    }
    beforePush?.();
    const response = git(['receive-pack', '--stateless-rpc', directory], init?.body as Uint8Array);
    return new Response(new Uint8Array(response), { headers: { 'content-type': 'application/x-git-receive-pack-result' } });
  }) as typeof fetch & ReturnType<typeof vi.fn>;
  return { artifacts, repository, fetcher, revokeToken };
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('repository initialization validation', () => {
  it('accepts only explicit supported initialization options before side effects', () => {
    expect(validateRepositoryInitialization({})).toEqual({ initializeReadme: false, gitignore: 'none', license: 'none' });
    for (const invalid of [{ initializeReadme: 'yes' }, { gitignore: 'Ruby' }, { license: 'GPL' }, { copyrightHolder: 'one\ntwo' }, { copyrightHolder: 'x'.repeat(201) }]) expect(() => validateRepositoryInitialization(invalid)).toThrow();
  });
  it('generates full licenses and selected ignore rules without adding unrequested files', () => {
    const files = initialRepositoryFiles(input, new Date('2026-01-01T00:00:00Z'));
    expect(files['README.md']).toBe('# test-repository\n\nA test repository\n');
    expect(files['.gitignore']).toContain('node_modules/');
    expect(files.LICENSE).toContain('Copyright (c) 2026 Example Maintainers');
    expect(files.LICENSE).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    const apache = initialRepositoryFiles({ ...input, options: { initializeReadme: false, gitignore: 'Python', license: 'Apache-2.0' } });
    expect(apache['.gitignore']).toContain('__pycache__/');
    expect(apache.LICENSE).toContain('END OF TERMS AND CONDITIONS');
    expect(apache).not.toHaveProperty('README.md');
    expect(initialRepositoryFiles({ ...input, options: { initializeReadme: false, gitignore: 'none', license: 'none' } })).toEqual({});
  });
});

describe('native Git initialization', () => {
  it('produces a pack real git index-pack accepts and reconstructs exact UTF-8 root files', () => {
    const directory = emptyRepository();
    const files = initialRepositoryFiles({ ...input, description: 'Unicode: café 🌱' });
    const built = buildInitializationPack(files, new Date('2026-10-13T00:00:00Z'));
    git(['--git-dir', directory, 'index-pack', '--stdin', '--strict'], built.pack);
    expect(git(['--git-dir', directory, 'show', `${built.commitSha}:README.md`]).toString()).toBe(files['README.md']);
    expect(git(['--git-dir', directory, 'show', `${built.commitSha}:LICENSE`]).toString()).toBe(files.LICENSE);
    expect(git(['--git-dir', directory, 'show', `${built.commitSha}:.gitignore`]).toString()).toBe(files['.gitignore']);
    expect(git(['--git-dir', directory, 'rev-list', '--parents', built.commitSha]).toString().trim()).toBe(built.commitSha);
    expect(() => buildInitializationPack({ '../escape': 'x' })).toThrow();
    expect(() => buildInitializationPack({ 'README.md': 'x'.repeat(16385) })).toThrow();
  });
  it('initializes a real empty repository through smart HTTP without a runner and revokes the token', async () => {
    const directory = emptyRepository(); const transport = nativeTransport(directory);
    const result = await initializeArtifactsRepository(transport.artifacts, input.name, input, transport.fetcher);
    expect(result.headSha).toMatch(/^[a-f0-9]{40}$/);
    expect(result.initializedFiles.sort()).toEqual(['.gitignore', 'LICENSE', 'README.md']);
    expect(git(['--git-dir', directory, 'show', 'main:README.md']).toString()).toContain('A test repository');
    expect(transport.revokeToken).toHaveBeenCalledWith('test-capability');
    expect(transport.fetcher.mock.calls.every(call => (call[1] as RequestInit).redirect === 'manual')).toBe(true);
    expect(transport.repository.createToken).toHaveBeenCalledWith('write', 60);
  });
  it('refuses existing references before sending a receive-pack update', async () => {
    const directory = emptyRepository(); const transport = nativeTransport(directory);
    await initializeArtifactsRepository(transport.artifacts, input.name, input, transport.fetcher);
    transport.fetcher.mockClear(); transport.revokeToken.mockClear();
    await expect(initializeArtifactsRepository(transport.artifacts, input.name, input, transport.fetcher)).rejects.toThrow('REPOSITORY_NOT_EMPTY');
    expect(transport.fetcher).toHaveBeenCalledTimes(1);
    expect(transport.revokeToken).toHaveBeenCalledTimes(1);
  });
  it('rejects a concurrent writer without replacing its canonical commit', async () => {
    const directory = emptyRepository();
    const other = buildInitializationPack({ 'README.md': '# Existing concurrent writer\n' });
    const transport = nativeTransport(directory, () => { git(['--git-dir', directory, 'index-pack', '--stdin'], other.pack); git(['--git-dir', directory, 'update-ref', 'refs/heads/main', other.commitSha]); });
    await expect(initializeArtifactsRepository(transport.artifacts, input.name, input, transport.fetcher)).rejects.toThrow('INITIALIZATION_REJECTED');
    expect(git(['--git-dir', directory, 'rev-parse', 'main']).toString().trim()).toBe(other.commitSha);
    expect(transport.revokeToken).toHaveBeenCalledOnce();
  });
  it('skips all Git operations for an intentionally empty repository', async () => {
    const directory = emptyRepository(); const transport = nativeTransport(directory);
    expect(await initializeArtifactsRepository(transport.artifacts, input.name, { ...input, options: { initializeReadme: false, gitignore: 'none', license: 'none' } }, transport.fetcher)).toEqual({ headSha: null, initializedFiles: [] });
    expect(transport.fetcher).not.toHaveBeenCalled(); expect(transport.repository.createToken).not.toHaveBeenCalled();
  });
  it('rejects redirects, malformed discovery, oversized bodies and missing confirmation', async () => {
    for (const response of [new Response('', { status: 302, headers: { location: 'https://elsewhere.example' } }), new Response('invalid', { headers: { 'content-type': 'application/x-git-receive-pack-advertisement' } }), new Response('x'.repeat(65537), { headers: { 'content-type': 'application/x-git-receive-pack-advertisement' } })]) {
      const transport = nativeTransport(emptyRepository());
      await expect(initializeArtifactsRepository(transport.artifacts, input.name, input, vi.fn(async () => response))).rejects.toThrow('INITIALIZATION_PROTOCOL');
      expect(transport.revokeToken).toHaveBeenCalledOnce();
    }
    const transport = nativeTransport(emptyRepository()); transport.repository.log = async () => [];
    await expect(initializeArtifactsRepository(transport.artifacts, input.name, input, transport.fetcher)).rejects.toThrow('INITIALIZATION_UNCONFIRMED');
    expect(transport.revokeToken).toHaveBeenCalledOnce();
  });
});
