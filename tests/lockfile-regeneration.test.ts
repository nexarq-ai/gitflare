import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Mission, Repository } from '../src/shared/types';
import type { ArtifactRepo, ArtifactsBinding } from '../src/worker/artifacts';
import { executeMission, LOCKFILE_COMMIT, type ExecutionEnv, type SandboxRunner } from '../src/worker/execution';
import type { InstallMode, InstallPlan } from '../src/worker/package-manager';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd })).stdout.trim();
}

function write(dir: string, path: string, content: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

const manifest = (dependencies: Record<string, string>, devDependencies: Record<string, string> = {}) => `${JSON.stringify({ name: 'app', private: true, dependencies, description: 'padding', version: '1.0.0', license: 'MIT', type: 'module', devDependencies }, null, 2)}\n`;

function resolvedLockfile(lockfile: string, packageJson: string): string {
  const { dependencies = {}, devDependencies = {} } = JSON.parse(packageJson) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  if (lockfile === 'pnpm-lock.yaml') return `lockfileVersion: '9.0'\n# ${JSON.stringify({ dependencies, devDependencies })}\n`;
  return `${JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies, devDependencies } } }, null, 2)}\n`;
}

const TEST = "import test from 'node:test';\ntest('ok', () => {});\n";
const POLICY = JSON.stringify({ test: 'node --test --test-reporter=tap tests/app.test.mjs', editable: ['src/'], install: 'auto' });

function repository(lockfile: string | null, dependencies: Record<string, string> = { base: '^1.0.0' }): Record<string, string> {
  const packageJson = manifest(dependencies);
  return { 'gitflare.json': POLICY, 'package.json': packageJson, 'tests/app.test.mjs': TEST, 'src/app.mjs': 'export const app = 1;\n', ...(lockfile ? { [lockfile]: resolvedLockfile(lockfile, packageJson) } : {}) };
}

interface Agent { name: string; shell?: string; carried?: (dir: string) => void }
type LockfileBehaviour = 'resolve' | 'fail' | 'stray';

const replace = (path: string, content: string) => `cat > ${path} <<'GITFLARE_EOF'\n${content}GITFLARE_EOF`;

async function fixture(files: Record<string, string>, agents: Agent[], behaviour: LockfileBehaviour = 'resolve') {
  const root = mkdtempSync(join(tmpdir(), 'gitflare-lockfile-'));
  roots.push(root);
  const origin = join(root, 'canonical.git');
  const seed = join(root, 'seed');
  await exec('git', ['init', '-q', '-b', 'main', seed]);
  await git(seed, 'config', 'user.email', 'seed@example.test');
  await git(seed, 'config', 'user.name', 'Seed');
  for (const [path, content] of Object.entries(files)) write(seed, path, content);
  await git(seed, 'add', '-A');
  await git(seed, 'commit', '-qm', 'base');
  const baseSha = await git(seed, 'rev-parse', 'HEAD');
  await exec('git', ['clone', '-q', '--bare', seed, origin]);
  const carried: (string | undefined)[] = [];
  for (const [index, agent] of agents.entries()) {
    if (!agent.carried) { carried.push(undefined); continue; }
    const fork = join(root, `gf-mission-1-run-${index + 1}.git`);
    await exec('git', ['clone', '-q', '--bare', origin, fork]);
    await git(seed, 'checkout', '-q', '--detach', baseSha);
    agent.carried(seed);
    await git(seed, 'add', '-A');
    await git(seed, 'commit', '-qm', `Gitflare: ${agent.name}`);
    await git(seed, 'push', '-q', fork, 'HEAD:refs/heads/gitflare-candidate');
    carried.push(await git(seed, 'rev-parse', 'HEAD'));
  }
  const installs: { sandbox: string; plan: InstallPlan; mode: InstallMode; before?: string; exitCode: number }[] = [];
  const sandboxes = new Map<string, string>();
  const getByName = (name: string): SandboxRunner => {
    if (!sandboxes.has(name)) { const dir = join(root, 'sandboxes', name); mkdirSync(dir, { recursive: true }); sandboxes.set(name, dir); }
    const dir = sandboxes.get(name)!;
    const repo = join(dir, 'repo');
    const local = (value: string) => value === '/workspace/repo' ? repo : value === '/workspace' ? dir : value;
    const run = async (argv: string[], cwd?: string) => {
      try { const result = await exec(argv[0]!, argv.slice(1).map(local), { cwd: local(cwd ?? '/workspace'), maxBuffer: 16 * 1024 * 1024 }); return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }; }
      catch (error) { const failure = error as { code?: number; stdout?: string; stderr?: string }; return { exitCode: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }; }
    };
    const install = async (plan: InstallPlan, mode: InstallMode = 'install') => {
      const packageJson = readFileSync(join(repo, 'package.json'), 'utf8');
      const lockPath = plan.lockfile ? join(repo, plan.lockfile) : null;
      const before = lockPath && existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : undefined;
      let result = { exitCode: 0, stdout: '', stderr: '' };
      if (mode === 'lockfile') {
        if (behaviour === 'fail') result = { exitCode: 1, stdout: '', stderr: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/charts - Not found\n' };
        else {
          writeFileSync(lockPath!, resolvedLockfile(plan.lockfile!, packageJson));
          if (behaviour === 'stray') write(repo, 'src/stray.txt', 'stray\n');
        }
      } else if (lockPath && before !== resolvedLockfile(plan.lockfile!, packageJson)) {
        result = { exitCode: 1, stdout: '', stderr: `\`${plan.installer === 'npm' ? 'npm ci' : 'pnpm install --frozen-lockfile'}\` can only install packages when package.json and ${plan.lockfile} are in sync\n` };
      }
      installs.push({ sandbox: name, plan, mode, before, exitCode: result.exitCode });
      return result;
    };
    return { prepare: async () => {}, destroy: async () => {}, command: run, check: async (script) => run(['/bin/bash', '-c', script], '/workspace/repo'), install };
  };
  const repoHandle = (name: string): ArtifactRepo => {
    const path = join(root, `${name}.git`);
    return {
      info: async () => ({ name, remote: path, defaultBranch: 'main' }),
      log: async ({ ref }: { ref?: string } = {}) => {
        if (name === 'canonical') return [{ hash: baseSha, treeHash: 't', message: '' }];
        try { return [{ hash: await git(path, 'rev-parse', `refs/heads/${ref}`), treeHash: 't', message: '' }]; } catch { return []; }
      },
      readTree: async () => [],
      fork: async (forkName: string) => { await exec('git', ['clone', '-q', '--bare', origin, join(root, `${forkName}.git`)]); return { name: forkName, remote: join(root, `${forkName}.git`), defaultBranch: 'main', token: 'unused' }; },
      revokeToken: async () => true,
      [Symbol.dispose]: () => {},
    } as unknown as ArtifactRepo;
  };
  const done = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Changed the requested files.' }] }] };
  const ai = async (_model: string, request: Record<string, unknown>) => {
    const input = request.input as { role?: string; type?: string; content?: unknown }[];
    if (input.some((item) => item.type === 'function_call_output')) return done;
    const context = String(input.find((item) => item.role === 'user')?.content ?? '');
    const agent = agents.find((candidate) => new RegExp(`"assignment": \\{\\s*"name": "${candidate.name}"`).test(context))!;
    return { status: 'completed', output: [{ type: 'function_call', call_id: 'edit', name: 'shell', arguments: JSON.stringify({ command: agent.shell }) }] };
  };
  const env: ExecutionEnv = { MODEL: 'openai/gpt-6-luna', AI_GATEWAY_ID: 'test', AI: { run: ai }, ARTIFACTS: { get: async (name: string) => repoHandle(name) } as unknown as ArtifactsBinding, SANDBOX: { getByName } };
  const mission: Mission = {
    id: 'mission', epoch: 1, repositoryId: 'repository', status: 'running', title: 'Dependencies', prompt: 'Add a dependency', baseSha, mode: 'combine', candidateSha: null, events: [], createdAt: '', updatedAt: '',
    runs: agents.map((agent, index) => carried[index]
      ? { id: `run-${index + 1}`, name: agent.name, role: 'Engineer', task: agent.name, status: 'completed' as const, commitSha: carried[index], forkName: `gf-mission-1-run-${index + 1}`, branch: 'gitflare-candidate', reusedFromEpoch: 0, candidateBaseSha: baseSha, changedFiles: [] }
      : { id: `run-${index + 1}`, name: agent.name, role: 'Engineer', task: agent.name, status: 'queued' as const, changedFiles: [] }),
    checks: agents.flatMap((agent, index) => carried[index] ? [{ id: `check-${index + 1}`, name: `${agent.name}: repository tests`, runId: `run-${index + 1}`, status: 'passed' as const, candidateSha: carried[index] }] : []),
    changes: [],
  };
  const result = await executeMission({ repository: { name: 'canonical', headSha: baseSha } as Repository, mission, testCommand: 'node --test' }, env);
  const subjects = async (fork: string, sha: string) => (await git(join(root, `${fork}.git`), 'log', '--format=%s', `${baseSha}..${sha}`)).split('\n');
  const show = (fork: string, sha: string, path: string) => git(join(root, `${fork}.git`), 'show', `${sha}:${path}`);
  return { result, installs, subjects, show, baseSha, files };
}

const addCharts = (lockfile?: string): Agent => ({ name: 'Charts', shell: `${replace('package.json', manifest({ base: '^1.0.0', charts: '^2.0.0' }))}${lockfile ? `\necho '{ hand edited' > ${lockfile}` : ''}` });
const editSource: Agent = { name: 'Copy', shell: replace('src/copy.mjs', 'export const copy = 1;\n') };

describe('agent candidates that change dependencies', () => {
  for (const lockfile of ['package-lock.json', 'pnpm-lock.yaml']) {
    it(`regenerates ${lockfile} before the candidate is recorded, so the frozen install passes`, async () => {
      const { result, installs, subjects, show, files } = await fixture(repository(lockfile), [addCharts(lockfile)]);
      const run = result.runs[0]!;
      expect(run.error).toBeUndefined();
      expect(run.status).toBe('completed');
      expect(await subjects(run.forkName!, run.commitSha!)).toEqual([LOCKFILE_COMMIT, 'Dependencies']);
      expect(await show(run.forkName!, run.commitSha!, lockfile)).toBe(resolvedLockfile(lockfile, manifest({ base: '^1.0.0', charts: '^2.0.0' })).trimEnd());
      const regenerations = installs.filter((entry) => entry.mode === 'lockfile');
      expect(regenerations).toEqual([expect.objectContaining({ sandbox: 'gf-mission-1-run-1', plan: expect.objectContaining({ installer: lockfile === 'pnpm-lock.yaml' ? 'pnpm' : 'npm', lockfile }), before: files[lockfile] })]);
      expect(installs.filter((entry) => entry.sandbox === 'gf-mission-1-run-1-verify' && entry.mode === 'install')).toEqual([expect.objectContaining({ exitCode: 0 }), expect.objectContaining({ exitCode: 0 })]);
      expect(run.changedFiles.sort()).toEqual([lockfile, 'package.json'].sort());
      expect(run.dependencyChanges).toEqual([{ path: 'package.json', changes: [{ section: 'dependencies', name: 'charts', change: 'added', to: '^2.0.0' }] }]);
      expect(result.checks.find((check) => check.id === 'integration')).toMatchObject({ status: 'passed', candidateSha: run.commitSha });
      expect(result.events).toEqual([expect.objectContaining({ runId: 'run-1', type: 'info', message: `Charts: regenerated ${lockfile} with ${lockfile === 'pnpm-lock.yaml' ? 'pnpm' : 'npm'} from ${lockfile} in lockfile-only mode for the dependency changes (charts@^2.0.0)` })]);
    });
  }

  it('fails the run with the installer error when the lockfile cannot be regenerated', async () => {
    const { result } = await fixture(repository('package-lock.json'), [addCharts()], 'fail');
    const run = result.runs[0]!;
    expect(run.status).toBe('failed');
    expect(run.commitSha).toBeUndefined();
    expect(run.error).toContain('Lockfile regeneration with npm from package-lock.json failed (1)');
    expect(run.error).toContain('404 Not Found - GET https://registry.npmjs.org/charts');
    expect(result.checks).toEqual([expect.objectContaining({ id: 'gf-mission-1-run-1-lockfile', name: 'Charts: Update lockfile', runId: 'run-1', status: 'failed', output: expect.stringContaining('E404') })]);
    expect(result.candidateSha).toBeNull();
  });

  it('refuses a regeneration that changes anything except the lockfile', async () => {
    const { result } = await fixture(repository('package-lock.json'), [addCharts()], 'stray');
    const run = result.runs[0]!;
    expect(run.status).toBe('failed');
    expect(run.error).toBe('Regenerating package-lock.json with npm from package-lock.json in lockfile-only mode also changed src/stray.txt. Only package-lock.json may change.');
    expect(run.commitSha).toBeUndefined();
  });

  it('skips regeneration in a repository without a lockfile', async () => {
    const { result, installs, subjects } = await fixture(repository(null), [addCharts()]);
    const run = result.runs[0]!;
    expect(run.status).toBe('completed');
    expect(installs.some((entry) => entry.mode === 'lockfile')).toBe(false);
    expect(await subjects(run.forkName!, run.commitSha!)).toEqual(['Dependencies']);
    expect(result.events).toEqual([expect.objectContaining({ message: 'Charts: the repository has no lockfile, so none was generated for the dependency changes (charts@^2.0.0)' })]);
  });

  it('leaves an agent without dependency changes alone', async () => {
    const { result, installs, subjects } = await fixture(repository('package-lock.json'), [editSource]);
    const run = result.runs[0]!;
    expect(run.status).toBe('completed');
    expect(installs.some((entry) => entry.mode === 'lockfile')).toBe(false);
    expect(await subjects(run.forkName!, run.commitSha!)).toEqual(['Dependencies']);
    expect(result.events).toBeUndefined();
  });
});

describe('combined candidates that change dependencies', () => {
  it('regenerates the lockfile after merging even when nothing conflicted', async () => {
    const { result, installs, subjects, show } = await fixture(repository('package-lock.json'), [
      { name: 'Charts', carried: (dir) => write(dir, 'package.json', manifest({ base: '^1.0.0', charts: '^2.0.0' })) },
      { name: 'Copy', carried: (dir) => write(dir, 'src/copy.mjs', 'export const copy = 1;\n') },
    ]);
    expect(result.error).toBeUndefined();
    expect(installs.filter((entry) => entry.mode === 'lockfile')).toEqual([expect.objectContaining({ sandbox: 'gf-mission-1-integration' })]);
    expect((await subjects('gf-mission-1-integration', result.candidateSha!))[0]).toBe(LOCKFILE_COMMIT);
    expect(await show('gf-mission-1-integration', result.candidateSha!, 'package-lock.json')).toBe(resolvedLockfile('package-lock.json', manifest({ base: '^1.0.0', charts: '^2.0.0' })).trimEnd());
    expect(result.checks.find((check) => check.id === 'integration')).toMatchObject({ status: 'passed', candidateSha: result.candidateSha });
    expect(result.dependencyChanges).toEqual([{ path: 'package.json', changes: [{ section: 'dependencies', name: 'charts', change: 'added', to: '^2.0.0' }] }]);
    expect(result.events).toEqual([expect.objectContaining({ type: 'info', message: 'Combined candidate: regenerated package-lock.json with npm from package-lock.json in lockfile-only mode for the dependency changes (charts@^2.0.0)' })]);
  });

  it('records that live agent lockfiles already matched after combining', async () => {
    const { result, installs } = await fixture(repository('package-lock.json'), [addCharts(), editSource]);
    expect(result.error).toBeUndefined();
    expect(installs.filter((entry) => entry.mode === 'lockfile').map((entry) => entry.sandbox).sort()).toEqual(['gf-mission-1-integration', 'gf-mission-1-run-1']);
    expect(result.events?.map((event) => event.message)).toEqual(expect.arrayContaining([
      'Charts: regenerated package-lock.json with npm from package-lock.json in lockfile-only mode for the dependency changes (charts@^2.0.0)',
      'Combined candidate: package-lock.json already matched the dependency changes (charts@^2.0.0)',
    ]));
    expect(result.checks.find((check) => check.id === 'integration')).toMatchObject({ status: 'passed' });
  });

  it('fails the combined candidate when regeneration fails', async () => {
    const { result } = await fixture(repository('package-lock.json'), [
      { name: 'Charts', carried: (dir) => write(dir, 'package.json', manifest({ base: '^1.0.0', charts: '^2.0.0' })) },
      { name: 'Copy', carried: (dir) => write(dir, 'src/copy.mjs', 'export const copy = 1;\n') },
    ], 'fail');
    expect(result.candidateSha).toBeNull();
    expect(result.error).toContain('Lockfile regeneration with npm from package-lock.json failed (1)');
    expect(result.checks.find((check) => check.id === 'integration-lockfile')).toMatchObject({ name: 'Update lockfile', status: 'failed' });
  });
});
