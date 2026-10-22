import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { SandboxRunner } from '../src/worker/execution';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {}, WorkflowEntrypoint: class {} }));
const run = promisify(execFile);

async function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'gitflare-revert-'));
  const git = (...args: string[]) => run('git', args, { cwd: dir }).then((result) => result.stdout.trim());
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@example.test');
  await git('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'README.md'), '# Site\n\nIntro.\n');
  await git('add', '-A'); await git('commit', '-qm', 'base');
  const previous = await git('rev-parse', 'HEAD');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'index.js'), 'export default { fetch: () => new Response("hi") };\n');
  writeFileSync(join(dir, 'wrangler.toml'), 'name = "site"\nmain = "src/index.js"\n');
  writeFileSync(join(dir, 'README.md'), '# Site\n\nIntro.\n\n## Deploy\n\nnpx wrangler deploy\n');
  await git('add', '-A'); await git('commit', '-qm', 'landed');
  const landed = await git('rev-parse', 'HEAD');
  const sandbox: SandboxRunner = {
    prepare: async () => {}, destroy: async () => {},
    command: async (argv, cwd) => {
      try { const result = await run(argv[0], argv.slice(1), { cwd: cwd === '/workspace/repo' || !cwd ? dir : cwd }); return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }; }
      catch (error) { const failure = error as { code?: number; stdout?: string; stderr?: string }; return { exitCode: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }; }
    },
  };
  return { dir, git, previous, landed, sandbox, change: { missionId: 'm', title: 'Make it hostable', previousSha: previous, landedSha: landed } };
}

describe('reverting a landed mission', () => {
  it('undoes exactly the landed files on top of later commits', async () => {
    const { applyRevert } = await import('../src/worker/execution');
    const repo = await repository();
    writeFileSync(join(repo.dir, 'NOTES.md'), 'Added after landing.\n');
    await repo.git('add', '-A'); await repo.git('commit', '-qm', 'later');
    const paths = await applyRevert(repo.sandbox, repo.change);
    expect(paths.sort()).toEqual(['README.md', 'src/index.js', 'wrangler.toml']);
    await repo.git('commit', '-qm', 'revert');
    expect(readFileSync(join(repo.dir, 'README.md'), 'utf8')).toBe('# Site\n\nIntro.\n');
    expect(existsSync(join(repo.dir, 'wrangler.toml'))).toBe(false);
    expect(existsSync(join(repo.dir, 'src', 'index.js'))).toBe(false);
    expect(readFileSync(join(repo.dir, 'NOTES.md'), 'utf8')).toBe('Added after landing.\n');
    expect(await repo.git('diff', '--name-only', repo.previous, 'HEAD', '--', 'README.md', 'src/index.js', 'wrangler.toml')).toBe('');
  });

  it('refuses when later commits changed the same lines', async () => {
    const { applyRevert } = await import('../src/worker/execution');
    const repo = await repository();
    writeFileSync(join(repo.dir, 'README.md'), '# Site\n\nIntro.\n\n## Deploy\n\nnpm run deploy\n');
    await repo.git('add', '-A'); await repo.git('commit', '-qm', 'later edit');
    await expect(applyRevert(repo.sandbox, repo.change)).rejects.toThrow('no longer reverts cleanly');
  });

  it('refuses commits that are not ancestors of the branch', async () => {
    const { applyRevert } = await import('../src/worker/execution');
    const repo = await repository();
    await expect(applyRevert(repo.sandbox, { ...repo.change, landedSha: 'f'.repeat(40) })).rejects.toThrow();
    await expect(applyRevert(repo.sandbox, { ...repo.change, previousSha: 'not-a-sha' })).rejects.toThrow('exact landed and previous commits');
  });
});
