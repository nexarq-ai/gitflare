import { describe, expect, it } from 'vitest';
import { addsStarterPolicyFile, isStarterRepository, parseNameStatus, parseRepositoryPolicy, protectedChanges, protectionReason, starterCheck, starterPolicyFileProblem } from '../src/worker/repository-policy';

describe('starter repositories', () => {
  it('treats a repository with no tests, manifest or policy as a starter', () => {
    expect(isStarterRepository(['README.md'])).toBe(true);
    expect(isStarterRepository(['README.md', 'LICENSE', 'src/index.html'])).toBe(true);
    for (const existing of ['package.json', 'tests/a.test.mjs', 'src/a.test.ts', 'gitflare.json', 'web/package.json']) expect(isStarterRepository(['README.md', existing])).toBe(false);
    expect(parseRepositoryPolicy(null, 'node --test', ['README.md']).starter).toBe(true);
    expect(parseRepositoryPolicy(null, 'node --test', undefined).starter).toBe(false);
    expect(parseRepositoryPolicy('{"test":"npm test"}', 'node --test', ['README.md', 'gitflare.json']).starter).toBe(false);
  });

  it('lets agents scaffold a project and tests in a starter, and its first root gitflare.json, but never CI', () => {
    const starter = parseRepositoryPolicy(null, 'node --test', ['README.md', 'LICENSE']);
    const changes = parseNameStatus('A\tpackage.json\nA\tpackage-lock.json\nA\tastro.config.mjs\nA\tsrc/pages/index.astro\nA\ttests/page.test.mjs\nM\tREADME.md');
    expect(protectedChanges(changes, starter)).toEqual([]);
    expect(protectedChanges(parseNameStatus('A\tgitflare.json\nA\tweb/gitflare.json\nA\t.github/workflows/x.yml\nA\t.npmrc\nM\tLICENSE\nD\tLICENSE'), starter)).toEqual(['web/gitflare.json', '.github/workflows/x.yml', '.npmrc', 'LICENSE', 'LICENSE']);
    expect(addsStarterPolicyFile(parseNameStatus('A\tgitflare.json'), starter)).toBe(true);
  });

  it('protects gitflare.json once the base has one', () => {
    const configured = parseRepositoryPolicy('{"test":"npm test"}', 'node --test', ['README.md', 'gitflare.json']);
    expect(configured.starter).toBe(false);
    expect(protectedChanges(parseNameStatus('M\tgitflare.json'), configured)).toEqual(['gitflare.json']);
    expect(addsStarterPolicyFile(parseNameStatus('A\tgitflare.json'), configured)).toBe(false);
    const tested = parseRepositoryPolicy(null, 'node --test', ['README.md', 'tests/a.test.mjs']);
    expect(protectedChanges(parseNameStatus('A\tgitflare.json'), tested)).toEqual(['gitflare.json']);
  });

  it('validates an agent-created gitflare.json and refuses deploy settings', () => {
    expect(starterPolicyFileProblem('{"test":"npm test","evidence":"exit-code"}')).toBeNull();
    expect(starterPolicyFileProblem('{"deploy":{"targets":[]}}')).toContain('may not set "deploy"');
    expect(starterPolicyFileProblem('{"network":true}')).toContain('unsupported field "network"');
    expect(starterPolicyFileProblem('{')).toContain('not valid JSON');
  });

  it('names the rule that protects each path', () => {
    const tested = parseRepositoryPolicy(null, 'node --test', ['README.md', 'tests/a.test.mjs', 'public/index.html']);
    expect(protectedChanges(parseNameStatus('M\tpublic/index.html\nM\tstatic/a.css\nM\tassets/logo.svg'), tested)).toEqual([]);
    expect(protectionReason('wrangler.jsonc', tested)).toBe('outside the editable paths src/, docs/, public/, static/, assets/, README.md; set "editable" in gitflare.json to allow it');
    expect(protectionReason('tests/a.test.mjs', tested)).toContain('existing tests are protected');
    expect(protectionReason('.github/workflows/ci.yml', tested)).toContain('always protected');
  });

  it('keeps the strict policy for repositories that already have tests', () => {
    const existing = parseRepositoryPolicy(null, 'node --test', ['README.md', 'tests/a.test.mjs']);
    expect(protectedChanges(parseNameStatus('A\tpackage.json\nA\ttests/b.test.mjs\nM\ttests/a.test.mjs\nM\tsrc/a.mjs\nA\twrangler.jsonc\nM\tvite.config.ts\nA\tpnpm-lock.yaml\nD\tREADME.md'), existing)).toEqual(['package.json', 'tests/a.test.mjs', 'vite.config.ts']);
  });

  it('chooses how to check what the agent added', () => {
    const scripted = JSON.stringify({ scripts: { test: 'node --test' } });
    expect(starterCheck(['package.json'], scripted)).toEqual({ testCommand: 'npm test', evidence: 'exit-code', install: null });
    const withDependencies = JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '^4.0.0' } });
    expect(starterCheck(['package.json'], withDependencies)).toEqual({ testCommand: 'npm test', evidence: 'exit-code', install: { installer: 'npm', lockfile: null, pinned: null, fallbackRange: null } });
    expect(starterCheck(['package.json', 'package-lock.json'], scripted)).toEqual({ testCommand: 'npm test', evidence: 'exit-code', install: { installer: 'npm', lockfile: 'package-lock.json', pinned: null, fallbackRange: null } });
    expect(starterCheck(['package.json', 'pnpm-lock.yaml'], scripted, "lockfileVersion: '9.0'\n")).toEqual({ testCommand: 'pnpm test', evidence: 'exit-code', install: { installer: 'pnpm', lockfile: 'pnpm-lock.yaml', pinned: null, fallbackRange: '10' } });
    const placeholder = JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } });
    expect(starterCheck(['package.json', 'tests/page.test.mjs'], placeholder)).toEqual({ testCommand: 'node --test --test-reporter=tap', evidence: 'tap', install: null });
    expect(starterCheck(['README.md', 'src/pages/index.astro'], null)).toBeNull();
    expect(starterCheck(['package.json'], '{not json')).toBeNull();
  });
});

describe('repositories without node:test files', () => {
  it('uses an existing npm test script and keeps checking against the base', () => {
    const policy = parseRepositoryPolicy(null, 'node --test --test-reporter=tap tests/*.test.mjs', ['package.json', 'package-lock.json', 'src/index.ts', 'src/index.test.ts'], JSON.stringify({ scripts: { test: 'vitest run' } }));
    expect(policy).toMatchObject({ testCommand: 'npm test', evidence: 'exit-code', install: { installer: 'npm', lockfile: 'package-lock.json' }, starter: false, untested: false });
  });

  it('requires agent-added tests for an imported project that has none', () => {
    const policy = parseRepositoryPolicy(null, 'node --test --test-reporter=tap tests/*.test.mjs', ['package.json', 'index.html', 'src/main.js'], JSON.stringify({ scripts: { build: 'vite build', test: 'echo "Error: no test specified" && exit 1' } }));
    expect(policy).toMatchObject({ starter: false, untested: true, testCommand: 'node --test --test-reporter=tap tests/*.test.mjs' });
  });

  it('keeps the fixture behaviour when the repository already has node:test files', () => {
    expect(parseRepositoryPolicy(null, 'node --test', ['README.md', 'tests/capacity.test.mjs', 'src/batch.mjs'], null)).toMatchObject({ testCommand: 'node --test', evidence: 'tap', starter: false, untested: false, install: null });
  });
});

describe('check failure summary', () => {
  it('surfaces the failing lines instead of a generic message', async () => {
    const { checkFailureSummary } = await import('../src/worker/execution');
    const tap = 'TAP version 13\n# Subtest: wrangler config\nnot ok 1 - wrangler config\n  ---\n  error: |-\n    ENOENT: no such file\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n# duration_ms 4.2';
    expect(checkFailureSummary(tap)).toContain('not ok 1 - wrangler config');
    expect(checkFailureSummary('npm ERR! code ERESOLVE\nnpm ERR! could not resolve dependency')).toContain('npm ERR! code ERESOLVE');
    expect(checkFailureSummary('Could not find \'/workspace/repo/tests/*.test.mjs\'')).toContain('Could not find');
    expect(checkFailureSummary('')).toContain('no output');
    expect(checkFailureSummary('x'.repeat(2000)).length).toBeLessThanOrEqual(400);
  });
});
