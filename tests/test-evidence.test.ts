import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../runner/sandbox';
import { normalizeCheckSettings, withLearnedLimits } from '../src/worker/check-settings';
import { checkFromCommand, testReport } from '../src/worker/execution';
import { parseRepositoryPolicy } from '../src/worker/repository-policy';

const sha = 'e'.repeat(40);
const spec = (tests: number, failed = 0) => `✔ moves the ship (1.2ms)\nℹ tests ${tests}\nℹ suites 0\nℹ pass ${tests - failed}\nℹ fail ${failed}\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 41.2\n`;
const tap = (tests: number) => `TAP version 13\n${Array.from({ length: tests }, (_, index) => `ok ${index + 1} - test ${index + 1}`).join('\n')}\n1..${tests}\n# tests ${tests}\n# pass ${tests}\n# fail 0\n# cancelled 0\n# duration_ms 12\n`;
const run = (stdout: string, exitCode = 0): CommandResult => ({ exitCode, stdout, stderr: '' });
const limits = { testTimeoutMs: 120_000, testTimeoutSource: 'default' as const, runner: 'standard-1' as const, runnerSource: 'default' as const };

describe('test evidence defaults in gitflare.json', () => {
  it('uses exit-code for package test scripts and TAP for other commands when evidence is not set', () => {
    expect(parseRepositoryPolicy('{"test":"npm test"}', 'x')).toMatchObject({ testCommand: 'npm test', evidence: 'exit-code' });
    expect(parseRepositoryPolicy('{"test":"pnpm run test"}', 'x')).toMatchObject({ evidence: 'exit-code' });
    const implicit = parseRepositoryPolicy('{"test":"node --test tests/*.test.mjs"}', 'x');
    expect(implicit).toMatchObject({ evidence: 'tap' });
    expect(implicit.evidenceSource).toBeUndefined();
    expect(parseRepositoryPolicy('{"test":"npm test","evidence":"tap"}', 'x')).toMatchObject({ evidence: 'tap', evidenceSource: 'gitflare.json' });
  });

  it('lets an Owner override the test command, evidence, time limit and runner that gitflare.json sets', () => {
    const raw = JSON.stringify({ test: 'node --test', evidence: 'tap', timeoutSeconds: 200, runner: 'standard-1' });
    const policy = parseRepositoryPolicy(raw, 'x', ['gitflare.json'], null, null, { policyOverride: { test: 'node --test --test-reporter=tap', evidence: 'exit-code', testTimeoutSeconds: 300, runner: 'standard-3' } });
    expect(policy).toMatchObject({ testCommand: 'node --test --test-reporter=tap', evidence: 'exit-code', evidenceSource: 'owner', testTimeoutMs: 300_000, testTimeoutSource: 'owner', runner: 'standard-3', runnerSource: 'owner' });
    expect(parseRepositoryPolicy(raw, 'x', ['gitflare.json'], null, null, { policyOverride: { test: 'npm test' } })).toMatchObject({ testCommand: 'npm test', evidence: 'exit-code', testTimeoutSource: 'gitflare.json' });
    expect(parseRepositoryPolicy(null, 'node --test', ['README.md'], null, null, { policyOverride: { test: 'node --test --test-reporter=tap' } })).toMatchObject({ testCommand: 'node --test --test-reporter=tap', untested: false });
  });

  it('validates the override and keeps it when learned limits are saved', () => {
    expect(normalizeCheckSettings({ policyOverride: { evidence: 'exit-code', test: ' npm test ' } })).toEqual({ policyOverride: { evidence: 'exit-code', test: 'npm test' } });
    expect(normalizeCheckSettings({ policyOverride: {} })).toEqual({});
    for (const policyOverride of [{ evidence: 'junit' }, { test: 'a\nb' }, { runner: 'huge' }, { deploy: true }, { testTimeoutSeconds: 5 }]) expect(() => normalizeCheckSettings({ policyOverride })).toThrow();
    expect(withLearnedLimits({ policyOverride: { evidence: 'exit-code' } }, { testTimeoutSeconds: 600 })).toEqual({ testTimeoutSeconds: 600, policyOverride: { evidence: 'exit-code' } });
  });
});

describe('recognised test reports', () => {
  it('reads TAP, node:test spec, Vitest, Jest and Mocha summaries', () => {
    expect(testReport(tap(2))).toEqual({ format: 'tap', tests: 2, passed: 2, failed: 0 });
    expect(testReport(spec(3, 1))).toEqual({ format: 'node-spec', tests: 3, passed: 2, failed: 1 });
    expect(testReport(' Test Files  2 passed (2)\n      Tests  1 failed | 4 passed (5)\n')).toEqual({ format: 'vitest', tests: 5, passed: 4, failed: 1 });
    expect(testReport('', 'Tests:       1 failed, 2 passed, 3 total\n')).toEqual({ format: 'jest', tests: 3, passed: 2, failed: 1 });
    expect(testReport('  7 passing (20ms)\n  1 failing\n')).toEqual({ format: 'mocha', tests: 8, passed: 7, failed: 1 });
    expect(testReport('\u001b[32mℹ tests 4\u001b[39m\nℹ pass 4\nℹ fail 0\n')).toMatchObject({ format: 'node-spec', tests: 4 });
    expect(testReport('done')).toBeNull();
  });
});

describe('checks with implicit and explicit TAP evidence', () => {
  it('passes the spec reporter on exit code 0 when evidence is implicit, and says so', () => {
    const check = checkFromCommand('run', 'Repository test suite', sha, run(spec(5)), 1, run(spec(4)), 'tap', { ...limits, testCommand: 'node --test tests/*.test.mjs' });
    expect(check.status).toBe('passed');
    expect(check.name).toBe('Repository test suite (exit code and node:test spec summary)');
    expect(check.output).toContain('No "evidence" setting is configured');
    expect(check.output).toContain('set "evidence": "exit-code" in gitflare.json');
  });

  it('fails an implicit check that reports failures, fewer tests than the base, or no recognised report', () => {
    expect(checkFromCommand('run', 'tests', sha, run(spec(5, 1), 1), 1, undefined, 'tap', limits).status).toBe('failed');
    const fewer = checkFromCommand('run', 'tests', sha, run(spec(3)), 1, run(spec(4)), 'tap', limits);
    expect(fewer.status).toBe('failed');
    expect(fewer.output).toContain('fewer tests than the base commit (3 < 4)');
    const unknown = checkFromCommand('run', 'tests', sha, run('all good'), 1, undefined, 'tap', { ...limits, testCommand: 'make test' });
    expect(unknown.status).toBe('failed');
    expect(unknown.output).toContain('`make test` printed no TAP summary ("# tests N", "# pass N") and no recognised test report');
  });

  it('names the gitflare.json setting when explicit TAP evidence gets another reporter', () => {
    const check = checkFromCommand('run', 'tests', sha, run(spec(5)), 1, undefined, 'tap', { ...limits, evidenceSource: 'gitflare.json', testCommand: 'npm test' });
    expect(check.status).toBe('failed');
    expect(check.output).toContain('gitflare.json sets "evidence": "tap", but `npm test` printed no TAP summary');
    expect(check.output).toContain('(it printed the node:test spec reporter)');
    expect(checkFromCommand('run', 'tests', sha, run(spec(5)), 1, undefined, 'tap', { ...limits, evidenceSource: 'owner' }).output).toContain('The repository check settings (Owner override of gitflare.json) set "evidence": "tap"');
  });

  it('does not fail a TAP candidate because an implicit base printed another reporter, but does for explicit TAP', () => {
    expect(checkFromCommand('run', 'tests', sha, run(tap(3)), 1, run(spec(3)), 'tap', limits)).toMatchObject({ status: 'passed' });
    const explicit = checkFromCommand('run', 'tests', sha, run(tap(3)), 1, run(spec(3)), 'tap', { ...limits, evidenceSource: 'gitflare.json' });
    expect(explicit.status).toBe('failed');
    expect(explicit.output).toContain('The base test report was incomplete; candidate coverage cannot be verified. gitflare.json sets "evidence": "tap"');
    expect(checkFromCommand('run', 'tests', sha, run(tap(3)), 1, run(tap(3)), 'tap', { ...limits, evidenceSource: 'gitflare.json' }).status).toBe('passed');
  });
});
