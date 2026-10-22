import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Mission, Repository } from '../src/shared/types';
import type { ArtifactRepo, ArtifactsBinding } from '../src/worker/artifacts';
import { executeMission, type ExecutionEnv, type SandboxRunner } from '../src/worker/execution';
import type { InstallMode, InstallPlan } from '../src/worker/package-manager';
import { isGeneratedPath, parseRepositoryPolicy } from '../src/worker/repository-policy';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const GENERATOR = `import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
const features = readdirSync('features').filter((name) => name.endsWith('.txt')).map((name) => name.slice(0, -4)).sort();
mkdirSync('generated', { recursive: true });
writeFileSync('generated/index.txt', features.join('\\n') + '\\n');
writeFileSync('generated/manifest.json', JSON.stringify(features) + '\\n');
`;
const FEATURE_TEST = `import test from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
test('generated index lists every feature', () => {
  const features = readdirSync('features').map((name) => name.slice(0, -4)).sort();
  assert.deepStrictEqual(readFileSync('generated/index.txt', 'utf8').trim().split('\\n'), features);
  assert.deepStrictEqual(JSON.parse(readFileSync('generated/manifest.json', 'utf8')), features);
});
`;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd })).stdout.trim();
}

function write(dir: string, path: string, content: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function lockfileFor(packageJson: string): string {
  const { dependencies = {}, devDependencies = {} } = JSON.parse(packageJson) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  return `${JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies, devDependencies } } }, null, 2)}\n`;
}

interface Agent { name: string; edit: (dir: string) => Promise<void> | void }

async function fixture(files: Record<string, string>, agents: Agent[], options: { baseSetup?: (dir: string) => Promise<void> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gitflare-generated-'));
  roots.push(root);
  const origin = join(root, 'canonical.git');
  const seed = join(root, 'seed');
  await exec('git', ['init', '-q', '-b', 'main', seed]);
  await git(seed, 'config', 'user.email', 'seed@example.test');
  await git(seed, 'config', 'user.name', 'Seed');
  for (const [path, content] of Object.entries(files)) write(seed, path, content);
  await options.baseSetup?.(seed);
  await git(seed, 'add', '-A');
  await git(seed, 'commit', '-qm', 'base');
  const baseSha = await git(seed, 'rev-parse', 'HEAD');
  await exec('git', ['clone', '-q', '--bare', seed, origin]);
  const commits: string[] = [];
  for (const [index, agent] of agents.entries()) {
    const fork = join(root, `gf-mission-1-run-${index + 1}.git`);
    await exec('git', ['clone', '-q', '--bare', origin, fork]);
    await git(seed, 'checkout', '-q', '--detach', baseSha);
    await agent.edit(seed);
    await git(seed, 'add', '-A');
    await git(seed, 'commit', '-qm', `Gitflare: ${agent.name}`);
    const commit = await git(seed, 'rev-parse', 'HEAD');
    await git(seed, 'push', '-q', fork, 'HEAD:refs/heads/gitflare-candidate');
    commits.push(commit);
  }
  const checks: string[] = [];
  const installs: { plan: InstallPlan; mode: InstallMode }[] = [];
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
    return {
      prepare: async () => {}, destroy: async () => {},
      command: run,
      check: async (script) => { checks.push(script); return run(['/bin/bash', '-c', script], '/workspace/repo'); },
      install: async (plan, mode = 'install') => {
        installs.push({ plan, mode });
        if (mode === 'lockfile') writeFileSync(join(repo, 'package-lock.json'), lockfileFor(readFileSync(join(repo, 'package.json'), 'utf8')));
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
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
  const env: ExecutionEnv = { MODEL: 'openai/gpt-6-luna', AI_GATEWAY_ID: 'test', AI: { run: async () => { throw new Error('No model call expected'); } }, ARTIFACTS: { get: async (name: string) => repoHandle(name) } as unknown as ArtifactsBinding, SANDBOX: { getByName } };
  const mission: Mission = {
    id: 'mission', epoch: 2, repositoryId: 'repository', status: 'running', title: 'Features', prompt: 'Add features', baseSha, mode: 'combine', candidateSha: null, events: [], createdAt: '', updatedAt: '',
    runs: agents.map((agent, index) => ({ id: `run-${index + 1}`, name: agent.name, role: 'Engineer', task: agent.name, status: 'completed' as const, commitSha: commits[index], forkName: `gf-mission-1-run-${index + 1}`, branch: 'gitflare-candidate', reusedFromEpoch: 1, candidateBaseSha: baseSha, changedFiles: [] })),
    checks: agents.map((agent, index) => ({ id: `check-${index + 1}`, name: `${agent.name}: repository tests`, runId: `run-${index + 1}`, status: 'passed' as const, candidateSha: commits[index] })),
    changes: [],
  };
  const result = await executeMission({ repository: { name: 'canonical', headSha: baseSha } as Repository, mission, testCommand: 'node --test' }, env);
  const integration = join(root, 'gf-mission-2-integration.git');
  const integrated = result.candidateSha ? await git(integration, 'log', '--format=%s', result.candidateSha) : '';
  const show = (path: string) => git(integration, 'show', `${result.candidateSha}:${path}`);
  return { result, checks, installs, integrated, show };
}

const policy = (generated: Record<string, unknown>) => JSON.stringify({ test: 'node --test --test-reporter=tap tests/features.test.mjs', editable: ['features/', 'generated/'], generated });
const featureRepository = (generated: Record<string, unknown> = { paths: ['generated/index.txt', 'generated/*.json'], command: 'node scripts/gen.mjs' }) => ({
  'gitflare.json': policy(generated),
  'scripts/gen.mjs': GENERATOR,
  'tests/features.test.mjs': FEATURE_TEST,
  'features/home.txt': 'home\n',
});
const addFeature = (name: string, extra?: (dir: string) => void): Agent => ({
  name,
  edit: async (dir) => {
    write(dir, `features/${name.toLowerCase()}.txt`, `${name}\n`);
    extra?.(dir);
    await exec('node', ['scripts/gen.mjs'], { cwd: dir });
  },
});
const generateBase = async (dir: string) => { await exec('node', ['scripts/gen.mjs'], { cwd: dir }); };

describe('combining agents that regenerated the same generated files', () => {
  it('keeps the integration version on generated-only conflicts and regenerates once after all merges', async () => {
    const { result, checks, integrated, show } = await fixture(featureRepository(), [addFeature('Dashboard'), addFeature('Habits'), addFeature('Settings')], { baseSetup: generateBase });
    expect(result.error).toBeUndefined();
    expect(checks.filter((script) => script === 'node scripts/gen.mjs')).toHaveLength(1);
    expect(integrated.split('\n')[0]).toBe('Regenerate generated files');
    expect(await show('generated/index.txt')).toBe('dashboard\nhabits\nhome\nsettings');
    expect(JSON.parse(await show('generated/manifest.json'))).toEqual(['dashboard', 'habits', 'home', 'settings']);
    expect(result.checks.find((check) => check.id === 'integration')).toMatchObject({ status: 'passed', candidateSha: result.candidateSha });
    expect(result.events).toEqual([expect.objectContaining({ type: 'info', message: expect.stringContaining('Regenerated generated/index.txt, generated/manifest.json with `node scripts/gen.mjs`') })]);
    expect(result.events![0]!.message).toContain('agents conflicted only in generated files (generated/index.txt, generated/manifest.json)');
  });

  it('fails on a conflict in a real file and names only that file', async () => {
    const { result, checks } = await fixture(featureRepository(), [
      addFeature('Dashboard', (dir) => write(dir, 'features/home.txt', 'home with dashboard\n')),
      addFeature('Habits', (dir) => write(dir, 'features/home.txt', 'home with habits\n')),
    ], { baseSetup: generateBase });
    expect(result.error).toBe("Agent changes collide (Git merge conflict) when adding Habits. Use retry_failed to rerun Habits on top of the other agents' merged candidates.");
    expect(result.runs.find((run) => run.name === 'Habits')!.collision).toEqual({ files: ['features/home.txt'], epoch: expect.any(Number) });
    expect(result.runs.find((run) => run.name === 'Dashboard')!.collision).toBeUndefined();
    const merge = result.checks.find((check) => check.id === 'integration-merge')!;
    expect(merge.output).toMatch(/^Collision \(Git merge conflict\) adding Habits in: features\/home\.txt\n/);
    expect(merge.output!.split('\n')[0]).not.toContain('generated/');
    expect(checks.filter((script) => script === 'node scripts/gen.mjs')).toHaveLength(0);
    expect(result.candidateSha).toBeNull();
  });

  it('refuses a generate command that changes files outside the generated paths', async () => {
    const { result } = await fixture(featureRepository({ paths: ['generated/index.txt', 'generated/*.json'], command: 'node scripts/gen.mjs && echo stray > stray.txt' }), [addFeature('Dashboard'), addFeature('Habits')], { baseSetup: generateBase });
    expect(result.candidateSha).toBeNull();
    expect(result.error).toContain('changed paths outside the generated paths: stray.txt');
    expect(result.checks.find((check) => check.id === 'integration-generate')).toMatchObject({ name: 'Regenerate generated files', status: 'failed', output: expect.stringContaining('stray.txt') });
  });

  it('fails clearly when the generate command fails', async () => {
    const { result } = await fixture(featureRepository({ paths: ['generated/**'], command: 'node scripts/missing.mjs' }), [addFeature('Dashboard'), addFeature('Habits')], { baseSetup: generateBase });
    expect(result.candidateSha).toBeNull();
    expect(result.checks.find((check) => check.id === 'integration-generate')!.output).toContain('`node scripts/missing.mjs` failed (exit 1)');
  });

  it('keeps the integration version without a command and warns that nothing was regenerated', async () => {
    const { result } = await fixture(featureRepository({ paths: ['generated/**'] }), [addFeature('Dashboard'), addFeature('Habits')], { baseSetup: generateBase });
    expect(result.events).toEqual([expect.objectContaining({ type: 'warning', message: expect.stringContaining('gitflare.json sets no generated.command') })]);
    expect(result.checks.find((check) => check.id === 'integration')).toMatchObject({ status: 'failed' });
  });

  it('still fails a generated-file conflict when the repository declares no generated paths', async () => {
    const files = featureRepository();
    files['gitflare.json'] = JSON.stringify({ test: 'node --test --test-reporter=tap tests/features.test.mjs', editable: ['features/', 'generated/'] });
    const { result } = await fixture(files, [addFeature('Dashboard'), addFeature('Habits')], { baseSetup: generateBase });
    expect(result.checks.find((check) => check.id === 'integration-merge')!.output).toContain('adding Habits in: generated/index.txt, generated/manifest.json');
  });
});

describe('combining agents whose lockfiles conflict', () => {
  const manifest = (dependencies: Record<string, string>, devDependencies: Record<string, string>) => `${JSON.stringify({ name: 'app', private: true, dependencies, description: 'padding', version: '1.0.0', license: 'MIT', type: 'module', devDependencies, scripts: { test: 'node --test --test-reporter=tap tests/features.test.mjs' } }, null, 2)}\n`;
  const withDependency = (name: string, edit: (dir: string) => void): Agent => ({ name, edit: (dir) => { edit(dir); writeFileSync(join(dir, 'package-lock.json'), lockfileFor(readFileSync(join(dir, 'package.json'), 'utf8'))); } });

  it('takes the integration lockfile while merging, regenerates it in lockfile-only mode, and records the combined dependency changes', async () => {
    const files = { 'package.json': manifest({}, {}), 'package-lock.json': lockfileFor(manifest({}, {})), 'tests/features.test.mjs': "import test from 'node:test';\ntest('ok', () => {});\n", 'features/home.txt': 'home\n', 'generated/index.txt': 'home\n', 'generated/manifest.json': '["home"]\n' };
    const { result, installs, integrated, show } = await fixture(files, [
      withDependency('Charts', (dir) => write(dir, 'package.json', manifest({ charts: '^1.0.0' }, {}))),
      withDependency('Lint', (dir) => write(dir, 'package.json', manifest({}, { lint: '^2.0.0' }))),
    ]);
    expect(installs.filter((entry) => entry.mode === 'lockfile')).toEqual([{ plan: expect.objectContaining({ installer: 'npm', lockfile: 'package-lock.json' }), mode: 'lockfile' }]);
    expect(integrated.split('\n')[0]).toBe('Regenerate generated files');
    expect(JSON.parse(await show('package-lock.json')).packages['']).toEqual({ dependencies: { charts: '^1.0.0' }, devDependencies: { lint: '^2.0.0' } });
    expect(result.events![0]!.message).toContain('Regenerated package-lock.json with npm from package-lock.json in lockfile-only mode');
    expect(result.error).toBeUndefined();
    expect(result.dependencyChanges).toEqual([{ path: 'package.json', changes: [
      { section: 'dependencies', name: 'charts', change: 'added', to: '^1.0.0' },
      { section: 'devDependencies', name: 'lint', change: 'added', to: '^2.0.0' },
    ] }]);
    expect(installs.filter((entry) => entry.mode === 'install').length).toBeGreaterThan(0);
  });

  it('still refuses a combined candidate whose manifest changes more than dependencies', async () => {
    const files = { 'package.json': manifest({}, {}), 'package-lock.json': lockfileFor(manifest({}, {})), 'tests/features.test.mjs': "import test from 'node:test';\ntest('ok', () => {});\n", 'features/home.txt': 'home\n' };
    const { result } = await fixture(files, [
      withDependency('Charts', (dir) => write(dir, 'package.json', manifest({ charts: '^1.0.0' }, {}).replace('"padding"', '"changed"'))),
      withDependency('Lint', (dir) => write(dir, 'package.json', manifest({}, { lint: '^2.0.0' }))),
    ]);
    expect(result.error).toBe('Verified candidate changed protected files: package.json changes "description", which only an Owner may change');
    expect(result.dependencyChanges).toBeUndefined();
  });
});

describe('generated files policy', () => {
  it('accepts exact files and globs with an optional command', () => {
    expect(parseRepositoryPolicy(JSON.stringify({ generated: { paths: ['src/features/index.ts', 'public/features/manifest.json'], command: 'node scripts/gen-features.mjs' } }), 'x').generated).toEqual({ paths: ['src/features/index.ts', 'public/features/manifest.json'], command: 'node scripts/gen-features.mjs' });
    expect(parseRepositoryPolicy(JSON.stringify({ generated: { paths: ['src/generated/**'] } }), 'x').generated).toEqual({ paths: ['src/generated/**'], command: null });
    expect(parseRepositoryPolicy('{}', 'x').generated).toBeNull();
    expect(parseRepositoryPolicy(JSON.stringify({ deploy: { targets: [] } }), 'x').generated).toBeNull();
  });

  it('rejects malformed generated settings', () => {
    const invalid = [
      { generated: true },
      { generated: [] },
      { generated: { paths: [] } },
      { generated: { paths: Array.from({ length: 51 }, (_, index) => `gen/${index}.ts`) } },
      { generated: { paths: ['../outside.ts'] } },
      { generated: { paths: ['/etc/passwd'] } },
      { generated: { paths: ['gen/'] } },
      { generated: { paths: ['gitflare.json'] } },
      { generated: { paths: ['.git/config'] } },
      { generated: { paths: ['a\\b'] } },
      { generated: { paths: ['gen.ts'], command: 'a\nb' } },
      { generated: { paths: ['gen.ts'], command: '' } },
      { generated: { paths: ['gen.ts'], shell: 'bash' } },
    ];
    for (const value of invalid) expect(() => parseRepositoryPolicy(JSON.stringify(value), 'x')).toThrow('gitflare.json');
  });

  it('matches exact paths, single-segment and recursive globs', () => {
    expect(isGeneratedPath('src/features/index.ts', ['src/features/index.ts'])).toBe(true);
    expect(isGeneratedPath('src/features/index.tsx', ['src/features/index.ts'])).toBe(false);
    expect(isGeneratedPath('public/features/manifest.json', ['public/*/manifest.json'])).toBe(true);
    expect(isGeneratedPath('public/a/b/manifest.json', ['public/*/manifest.json'])).toBe(false);
    expect(isGeneratedPath('src/gen/a/b.ts', ['src/gen/**'])).toBe(true);
    expect(isGeneratedPath('src/gen.ts', ['src/**/gen.ts'])).toBe(true);
    expect(isGeneratedPath('src/a/b/gen.ts', ['src/**/gen.ts'])).toBe(true);
    expect(isGeneratedPath('src/genXts', ['src/gen.ts'])).toBe(false);
    expect(isGeneratedPath('src/gen1.ts', ['src/gen?.ts'])).toBe(true);
  });
});
