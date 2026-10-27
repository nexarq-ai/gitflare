import type { Check } from '../shared/types';
import type { CommandResult } from '../../runner/sandbox';
import type { RepositoryPolicy } from './repository-policy';

export const outputLimit = 12_000;

function reportedTests(stdout: string, passingOnly: boolean): Map<string, number> {
  const names = new Map<string, number>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(not )?ok \d+ - (.+?)(\s+# (?:SKIP|TODO)\b.*)?$/i.exec(line);
    if (match && !(passingOnly && (match[1] || match[3]))) names.set(match[2], (names.get(match[2]) ?? 0) + 1);
  }
  return names;
}

function missingBaselineTests(baselineStdout: string, candidateStdout: string): string[] {
  const passing = reportedTests(candidateStdout, true);
  return [...reportedTests(baselineStdout, false)].filter(([name, count]) => (passing.get(name) ?? 0) < count).map(([name]) => name);
}

const FAILURE_LINE = /^\s*not ok\b|^\s*(npm ERR!|npm error)|\b(Error|ERR_[A-Z_]+|FAIL|failed|Cannot find|not found|No test files|exceeded its execution deadline|Timed out after)\b/;

export function checkFailureSummary(output: string): string {
  const lines = output.split('\n').map((line) => line.trim()).filter((line) => line && !/^# (tests|suites|pass|cancelled|skipped|todo|duration_ms) /.test(line) && !/^(TAP version|1\.\.\d+|---|\.\.\.)$/.test(line));
  const picked = lines.filter((line) => FAILURE_LINE.test(line)).slice(0, 3);
  const summary = (picked.length ? picked : lines.slice(-3)).join(' · ');
  return summary ? summary.slice(0, 400) : 'the test command produced no output. Open Checks for details.';
}

export type CheckLimits = Pick<RepositoryPolicy, 'testTimeoutMs' | 'testTimeoutSource' | 'runner' | 'runnerSource'>;

const LIMIT_SOURCE = { owner: 'limit an Owner set for this proposal', 'gitflare.json': 'limit from gitflare.json timeoutSeconds', repository: 'limit from the repository check settings', learned: 'limit learned from recent check durations', auto: 'automatically increased limit', default: 'default limit' } as const;

function lastCharacters(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const keep = Math.max(0, limit - 48);
  return `[${text.length - keep} earlier characters omitted]\n${keep ? text.slice(text.length - keep) : ''}`;
}

export function commandOutput(result: Pick<CommandResult, 'stdout' | 'stderr'>, limit = outputLimit): string {
  const stdout = result.stdout.replace(/\s+$/, '');
  const stderr = result.stderr.replace(/\s+$/, '');
  if (!stderr) return lastCharacters(stdout, limit);
  if (!stdout) return lastCharacters(stderr, limit);
  const stdoutHeader = '--- stdout ---\n', stderrHeader = '\n--- stderr ---\n';
  const room = limit - stdoutHeader.length - stderrHeader.length;
  const stderrRoom = Math.min(stderr.length, Math.max(Math.floor(room / 3), room - stdout.length));
  return `${stdoutHeader}${lastCharacters(stdout, room - stderrRoom)}${stderrHeader}${lastCharacters(stderr, stderrRoom)}`;
}

export function timeoutNotice(result: CommandResult, limits: CheckLimits | undefined, subject = ''): string {
  if (!result.timedOut) return '';
  const limit = limits ? ` after ${Math.round(limits.testTimeoutMs / 1000)} s on ${limits.runner} (${LIMIT_SOURCE[limits.testTimeoutSource]})` : '';
  return `${subject}Timed out${limit}. Raise the check time limit (repository check settings, or timeoutSeconds in gitflare.json, up to 900 s) or choose a larger runner.\n`;
}

export type ReportFormat = 'tap' | 'node-spec' | 'vitest' | 'jest' | 'mocha';
export interface TestReport { format: ReportFormat; tests: number; passed: number; failed: number }

const REPORTER_NAMES: Record<ReportFormat, string> = { tap: 'TAP', 'node-spec': 'node:test spec', vitest: 'Vitest', jest: 'Jest', mocha: 'Mocha' };
const count = (text: string, pattern: RegExp): number | undefined => { const match = pattern.exec(text); return match ? Number(match[1]) : undefined; };

export function testReport(stdout: string, stderr = ''): TestReport | null {
  const text = `${stdout}\n${stderr}`.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  const tapTests = count(text, /^# tests (\d+)$/m);
  if (tapTests !== undefined) return { format: 'tap', tests: tapTests, passed: count(text, /^# pass (\d+)$/m) ?? 0, failed: count(text, /^# fail (\d+)$/m) ?? 0 };
  const specTests = count(text, /^\s*ℹ tests (\d+)\s*$/m);
  if (specTests !== undefined) return { format: 'node-spec', tests: specTests, passed: count(text, /^\s*ℹ pass (\d+)\s*$/m) ?? 0, failed: (count(text, /^\s*ℹ fail (\d+)\s*$/m) ?? 0) + (count(text, /^\s*ℹ cancelled (\d+)\s*$/m) ?? 0) };
  const vitest = /^\s*Tests\s+(.+?)\s+\((\d+)\)\s*$/m.exec(text);
  if (vitest) return { format: 'vitest', tests: Number(vitest[2]), passed: count(vitest[1]!, /(\d+) passed/) ?? 0, failed: count(vitest[1]!, /(\d+) failed/) ?? 0 };
  const jest = /^\s*Tests:\s+(.+?(\d+) total)\s*$/m.exec(text);
  if (jest) return { format: 'jest', tests: Number(jest[2]), passed: count(jest[1]!, /(\d+) passed/) ?? 0, failed: count(jest[1]!, /(\d+) failed/) ?? 0 };
  const passing = count(text, /^\s*(\d+) passing\b/m);
  if (passing !== undefined) { const failed = count(text, /^\s*(\d+) failing\b/m) ?? 0; return { format: 'mocha', tests: passing + failed, passed: passing, failed }; }
  return null;
}

type EvidenceContext = CheckLimits & Partial<Pick<RepositoryPolicy, 'evidenceSource' | 'testCommand'>>;

function evidenceSetting(context: EvidenceContext | undefined): string {
  if (context?.evidenceSource === 'owner') return 'The repository check settings (Owner override of gitflare.json) set "evidence": "tap"';
  if (context?.evidenceSource === 'gitflare.json') return 'gitflare.json sets "evidence": "tap"';
  return 'No "evidence" setting is configured, so Gitflare expects TAP';
}

const EVIDENCE_ADVICE = 'Make the test command print TAP (for node:test add --test-reporter=tap), or set "evidence": "exit-code" in gitflare.json; an Owner can also override evidence and the test command in the repository check settings.';

export function checkFromCommand(id: string, name: string, candidateSha: string, result: CommandResult, durationMs: number, baseline?: CommandResult, evidence: RepositoryPolicy['evidence'] = 'tap', limits?: EvidenceContext): Check {
  const tests = result.stdout.match(/^# tests (\d+)$/m);
  const passed = result.stdout.match(/^# pass (\d+)$/m);
  const hasCompleteEvidence = !!tests && !!passed && Number(tests[1]) > 0 && Number(passed[1]) === Number(tests[1]) && /^# fail 0$/m.test(result.stdout) && /^# cancelled 0$/m.test(result.stdout) && /^# duration_ms [\d.]+$/m.test(result.stdout);
  const truncated = result.stdout.includes('[output truncated]') || result.stderr.includes('[output truncated]');
  const timedOut = timeoutNotice(result, limits) + (baseline ? timeoutNotice(baseline, limits, 'Base commit test run: ') : '');
  const body = (prefix: string) => `${prefix}${commandOutput(result, outputLimit - prefix.length)}`;
  const timeout = (result.timedOut || baseline?.timedOut) && limits ? { timeout: { seconds: Math.round(limits.testTimeoutMs / 1000), runner: limits.runner, timeoutSource: limits.testTimeoutSource, runnerSource: limits.runnerSource } } : {};
  if (evidence === 'exit-code') return { id, name, detail: 'exit code only', candidateSha, durationMs, status: result.exitCode === 0 && !result.timedOut && !truncated ? 'passed' : 'failed', output: body(timedOut), ...timeout };
  const implicit = !limits?.evidenceSource || limits.evidenceSource === 'default';
  const command = limits?.testCommand ? `\`${limits.testCommand}\`` : 'The test command';
  if (!tests) {
    const report = testReport(result.stdout, result.stderr);
    if (!implicit || !report) {
      const notice = `${evidenceSetting(limits)}, but ${command} printed no TAP summary ("# tests N", "# pass N")${report ? ` (it printed the ${REPORTER_NAMES[report.format]} reporter)` : ' and no recognised test report'}. ${EVIDENCE_ADVICE}\n`;
      return { id, name, candidateSha, durationMs, status: 'failed', output: body(`${timedOut}${notice}`), ...timeout };
    }
    const base = baseline ? testReport(baseline.stdout, baseline.stderr) : null;
    const fewer = !!base && base.format === report.format && report.tests < base.tests;
    const ok = result.exitCode === 0 && !result.timedOut && !truncated && !baseline?.timedOut && report.tests > 0 && report.failed === 0 && report.passed > 0 && !fewer;
    const notice = `${evidenceSetting(limits)}; ${command} printed the ${REPORTER_NAMES[report.format]} reporter instead (${report.tests} tests, ${report.passed} passed, ${report.failed} failed), so this check used the exit code and that summary.${baseline && !base ? ' The base commit printed no recognised report, so tests were not compared with it.' : ''}${fewer ? ` The candidate reported fewer tests than the base commit (${report.tests} < ${base!.tests}).` : ''} ${EVIDENCE_ADVICE}\n`;
    return { id, name, detail: `exit code and ${REPORTER_NAMES[report.format]} summary`, candidateSha, durationMs, status: ok ? 'passed' : 'failed', output: body(`${timedOut}${notice}`), ...timeout };
  }
  const baselineCount = baseline?.stdout.match(/^# tests (\d+)$/m);
  const baselineComplete = !baseline || (!!baselineCount && Number(baselineCount[1]) > 0 && /^# duration_ms [\d.]+$/m.test(baseline.stdout) && !`${baseline.stdout}\n${baseline.stderr}`.includes('[output truncated]'));
  const baselineReport = baseline && !baselineCount ? testReport(baseline.stdout, baseline.stderr) : null;
  const baselineSkipped = !baselineComplete && implicit && !!baselineReport && baseline!.exitCode === 0 && !baseline!.timedOut;
  const retainedCount = !baselineCount || (!!tests && Number(tests[1]) >= Number(baselineCount[1]));
  const missing = baseline && baselineCount ? missingBaselineTests(baseline.stdout, result.stdout) : [];
  const coverageNotice = baselineSkipped ? `The base commit printed the ${REPORTER_NAMES[baselineReport?.format ?? 'tap']} reporter instead of TAP, so the candidate's tests were not compared with it by name. ${EVIDENCE_ADVICE}\n` : !baselineComplete ? `The base test report was incomplete; candidate coverage cannot be verified. ${evidenceSetting(limits)}, and the base commit's run of ${command} did not print a complete TAP report. ${EVIDENCE_ADVICE}\n` : !retainedCount ? 'The candidate reported fewer tests than the base commit.\n' : '';
  const notice = missing.length ? `Tests reported at the base commit did not run and pass on this candidate: ${missing.slice(0, 20).join('; ')}\n` : '';
  return { id, name, candidateSha, durationMs, status: result.exitCode === 0 && !result.timedOut && hasCompleteEvidence && !truncated && (baselineComplete || baselineSkipped) && retainedCount && !missing.length ? 'passed' : 'failed', output: body(`${timedOut}${coverageNotice}${notice}`), ...timeout };
}
