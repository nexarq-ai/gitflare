import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type Remote = { url: string; display: string };
type Git = (args: string[]) => string;
const { gitflarePublicRemote, syncGitflarePublicRepository } = await import('../scripts/gitflare-public-repository.mjs' as string) as {
  gitflarePublicRemote(canonical: string): Remote | null;
  syncGitflarePublicRepository(options: { head: string; remote: Remote; objects: { path: string; ref: string }; git: Git; dryRun?: boolean }): { status: string; head: string; remoteHead?: string | null; repository: string };
};

const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const gitIn = (cwd: string): Git => args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...identity } });

describe('Gitflare public repository remote', () => {
  it('derives gitflare/gitflare on the canonical Gitflare host and never displays credentials', () => {
    expect(gitflarePublicRemote('https://app.gitflare.io/git/gitflare-platform.git')).toEqual({ url: 'https://app.gitflare.io/gitflare/gitflare.git', display: 'https://app.gitflare.io/gitflare/gitflare.git' });
    const withToken = gitflarePublicRemote('https://owner:secret-token@app.gitflare.io/git/gitflare-platform.git?x=1#y')!;
    expect(withToken.url).toBe('https://owner:secret-token@app.gitflare.io/gitflare/gitflare.git');
    expect(withToken.display).toBe('https://app.gitflare.io/gitflare/gitflare.git');
  });

  it('refuses GitHub, SSH and missing remotes', () => {
    for (const remote of ['', 'https://github.com/nexarq-ai/gitflare-platform.git', 'git@github.com:nexarq-ai/gitflare-platform.git', 'http://app.gitflare.io/git/x.git', 'not a url']) expect(gitflarePublicRemote(remote), remote).toBe(null);
  });
});

describe('Gitflare public repository sync', () => {
  let root: string;
  let source: Git;
  let exported: Git;
  let remote: Remote;
  let bare: Git;
  const commit = (git: Git, message: string, parents: string[] = []) => git(['commit-tree', git(['write-tree']).trim(), ...parents.flatMap(parent => ['-p', parent]), '-m', message]).trim();
  const remoteHead = () => bare(['rev-parse', 'refs/heads/main']).trim();
  const sync = (head: string, dryRun = false) => {
    exported(['update-ref', 'refs/heads/publish', head]);
    return syncGitflarePublicRepository({ head, remote, objects: { path: join(root, 'exported'), ref: 'refs/heads/publish' }, git: source, dryRun });
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitflare-public-sync-'));
    for (const name of ['source', 'exported']) execFileSync('git', ['init', '--quiet', join(root, name)]);
    execFileSync('git', ['init', '--quiet', '--bare', join(root, 'remote.git')]);
    source = gitIn(join(root, 'source'));
    exported = gitIn(join(root, 'exported'));
    bare = gitIn(join(root, 'remote.git'));
    remote = { url: join(root, 'remote.git'), display: 'https://gitflare.test/gitflare/gitflare.git' };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('fast-forwards from the once-imported head to the exported head', () => {
    const imported = commit(exported, 'Imported');
    exported(['push', '--quiet', remote.url, `${imported}:refs/heads/main`]);
    const head = commit(exported, 'Next', [commit(exported, 'Middle', [imported])]);
    expect(sync(head)).toMatchObject({ status: 'fast-forwarded', remoteHead: imported, head });
    expect(remoteHead()).toBe(head);
    expect(bare(['rev-list', '--count', 'main']).trim()).toBe('3');
    expect(sync(head)).toMatchObject({ status: 'current' });
  });

  it('creates main on an empty repository', () => {
    const head = commit(exported, 'First');
    expect(sync(head).status).toBe('fast-forwarded');
    expect(remoteHead()).toBe(head);
  });

  it('refuses to rewrite a diverged history and leaves the remote untouched', () => {
    const base = commit(exported, 'Base');
    const imported = commit(exported, 'Imported elsewhere', [base]);
    exported(['push', '--quiet', remote.url, `${imported}:refs/heads/main`]);
    const head = commit(exported, 'Canonical', [base]);
    expect(sync(head)).toMatchObject({ status: 'diverged', remoteHead: imported });
    expect(remoteHead()).toBe(imported);
  });

  it('treats a remote head unknown to the exported history as diverged', () => {
    const stranger = gitIn(join(root, 'remote.git'));
    const foreign = commit(stranger, 'Unrelated');
    bare(['update-ref', 'refs/heads/main', foreign]);
    expect(sync(commit(exported, 'Canonical')).status).toBe('diverged');
    expect(remoteHead()).toBe(foreign);
  });

  it('does not push on a dry run', () => {
    const imported = commit(exported, 'Imported');
    exported(['push', '--quiet', remote.url, `${imported}:refs/heads/main`]);
    expect(sync(commit(exported, 'Next', [imported]), true).status).toBe('would-fast-forward');
    expect(remoteHead()).toBe(imported);
  });

  it('reports a rejected push without the credential-bearing URL', () => {
    const secret = { url: 'https://owner:secret-token@127.0.0.1:9/gitflare/gitflare.git', display: 'https://127.0.0.1:9/gitflare/gitflare.git' };
    const head = commit(exported, 'First');
    exported(['update-ref', 'refs/heads/publish', head]);
    const failing: Git = args => { if (args[0] === 'ls-remote') return ''; if (args[0] === 'push') throw Object.assign(new Error('push failed'), { stderr: ` ! [remote rejected] ${head} -> main (protected branch; push another branch and open a pull request)\nerror: failed to push some refs to '${secret.url}'\n` }); return source(args); };
    let failure: (Error & { protectedBranch?: boolean }) | undefined;
    try { syncGitflarePublicRepository({ head, remote: secret, objects: { path: join(root, 'exported'), ref: 'refs/heads/publish' }, git: failing }); } catch (error) { failure = error as Error; }
    expect(failure?.message).toContain('protected branch');
    expect(failure?.message).not.toContain('secret-token');
    expect(failure?.protectedBranch).toBe(true);
  });
});
