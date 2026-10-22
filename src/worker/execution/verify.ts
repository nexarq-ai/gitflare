import type { Check, CheckPlan, FileChange, ManifestDependencyChanges, RepositorySkillChange, RevertChange } from '../../shared/types';
import type { ArtifactInfo } from '../artifacts';
import type { CommandResult } from '../../../runner/sandbox';
import { DEPENDENCY_FILES, type InstallPlan } from '../package-manager';
import type { LearnedLimits } from '../check-settings';
import { escalatedLimits, isFixedSource, startingTimeoutMs, parseRepositoryPolicy, POLICY_FILE, starterCheck, type RepositoryPolicy } from '../repository-policy';
import { checkFailureSummary, checkFromCommand, commandOutput, outputLimit } from '../check-evidence';
import type { SandboxRunner, ExecutionEnv, AuthorityGuard } from './environment';
import { checked, cloneOnFreshRunner, changesWithStatus, landedPaths } from './sandbox-git';
import { readLockHead, reviewChanges, installDependencies, DependencyInstallError, AGENT_INSTALL_RESERVE_MS, workingFiles } from './dependencies';

export async function verifySkillBytes(sandbox: SandboxRunner, change: RepositorySkillChange): Promise<void> {
  const expected = new TextEncoder().encode(change.content);
  const digest = await crypto.subtle.digest('SHA-256', expected);
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const actual = await checked(sandbox, ['sha256sum', '--', change.path]);
  if (actual.split(/\s+/)[0] !== hash) throw new Error('Skill candidate content differs from the exact requested bytes');
}

export async function loadPolicy(sandbox: SandboxRunner, baseSha: string, defaultTestCommand: string, settings?: CheckPlan | null): Promise<RepositoryPolicy> {
  const file = await sandbox.command(['git', 'show', `${baseSha}:${POLICY_FILE}`], '/workspace/repo');
  const tree = await sandbox.command(['git', 'ls-tree', '-r', '--name-only', baseSha], '/workspace/repo');
  const baseFiles = tree.exitCode === 0 && tree.stdout.trim() ? tree.stdout.split('\n').filter(Boolean) : undefined;
  const manifest = baseFiles?.includes('package.json') ? await sandbox.command(['git', 'show', `${baseSha}:package.json`], '/workspace/repo') : undefined;
  const lockHead = baseFiles ? await readLockHead(sandbox, baseFiles, baseSha) : null;
  return parseRepositoryPolicy(file.exitCode === 0 && file.stdout.trim() ? file.stdout : null, defaultTestCommand, baseFiles, manifest?.exitCode === 0 ? manifest.stdout : null, lockHead, settings);
}

export function protectedFailure(prefix: string, blocked: string[]): Error {
  return new Error(`${prefix}: ${blocked.join('; ')}`.slice(0, 1000));
}

async function resolveStarterCheck(sandbox: SandboxRunner): Promise<ReturnType<typeof starterCheck>> {
  const files = (await checked(sandbox, ['git', 'ls-files'])).split('\n').filter(Boolean);
  const manifest = await sandbox.command(['cat', 'package.json'], '/workspace/repo');
  return starterCheck(files, manifest.exitCode === 0 ? manifest.stdout : null, await readLockHead(sandbox, files));
}

export async function agentTests(sandbox: SandboxRunner, policy: RepositoryPolicy, remainingMs: number): Promise<string> {
  let checkPolicy = policy;
  if (policy.untested) {
    const files = await workingFiles(sandbox);
    const manifest = files.includes('package.json') ? await sandbox.command(['cat', 'package.json'], '/workspace/repo') : undefined;
    const starter = starterCheck(files, manifest?.exitCode === 0 ? manifest.stdout : null, await readLockHead(sandbox, files));
    if (!starter) return 'No tests found. Add a node:test file named *.test.mjs, or a package.json with a working "test" script; otherwise the check fails.';
    checkPolicy = { ...policy, testCommand: starter.testCommand, evidence: starter.evidence };
  }
  const timeoutMs = Math.min(checkPolicy.testTimeoutMs, remainingMs - AGENT_INSTALL_RESERVE_MS);
  if (timeoutMs < 10_000) return 'Not enough agent time left to run the tests. Finish now and report that tests were not run.';
  const result = await runBounded(sandbox, checkPolicy.testCommand, timeoutMs);
  const status = result.exitCode === 0 && !result.timedOut ? 'passed' : 'failed';
  return `\`${checkPolicy.testCommand}\` ${status} (exit ${result.exitCode}${result.timedOut ? `, timed out after ${Math.round(timeoutMs / 1000)} s` : ''}).${status === 'failed' ? ` ${checkFailureSummary(commandOutput(result))}` : ''}\n${commandOutput(result, 6000)}`;
}

export function runBounded(sandbox: SandboxRunner, script: string, timeoutMs: number): Promise<CommandResult> {
  return sandbox.check ? sandbox.check(script, timeoutMs) : sandbox.command(['/bin/bash', '-lc', script], '/workspace/repo', Math.min(timeoutMs, 120_000));
}

function runCheck(sandbox: SandboxRunner, policy: RepositoryPolicy): Promise<CommandResult> {
  return runBounded(sandbox, policy.testCommand, policy.testTimeoutMs);
}

export function mergeLearnedLimits(current: LearnedLimits | undefined, next: LearnedLimits): LearnedLimits {
  const runners = ['standard-1', 'standard-2', 'standard-3', 'standard-4'];
  const seconds = Math.max(current?.testTimeoutSeconds ?? 0, next.testTimeoutSeconds ?? 0);
  const runner = [current?.runner, next.runner].filter((value): value is NonNullable<LearnedLimits['runner']> => !!value).sort((a, b) => runners.indexOf(b) - runners.indexOf(a))[0];
  return { ...(seconds ? { testTimeoutSeconds: seconds } : {}), ...(runner ? { runner } : {}) };
}

export type Escalate = (message: string) => Promise<void>;

export async function verify(env: Required<Pick<ExecutionEnv, 'SANDBOX'>>, key: string, fork: ArtifactInfo, sha: string, baseSha: string, policy: RepositoryPolicy, assertAuthority: AuthorityGuard, skillChange?: RepositorySkillChange, isActive: () => Promise<boolean> = async () => true, humanBranch = false, onEscalate: Escalate = async () => {}): Promise<{ check: Check; changes: FileChange[]; dependencyChanges: ManifestDependencyChanges[]; learned?: LearnedLimits }> {
  const first = await verifyOnce(env, key, fork, sha, baseSha, policy, assertAuthority, skillChange, isActive, humanBranch);
  const timeout = first.check.timeout;
  const next = timeout && first.check.status === 'failed' ? escalatedLimits(timeout, policy.autoIncrease) : null;
  if (!timeout || !next || !await isActive()) return first;
  await onEscalate(`Timed out after ${timeout.seconds} s on ${timeout.runner}; retrying with ${next.seconds} s on ${next.runner}`);
  const escalated: RepositoryPolicy = { ...policy, testTimeoutMs: next.seconds * 1000, testTimeoutSource: isFixedSource(timeout.timeoutSource) ? timeout.timeoutSource : 'auto', runner: next.runner, runnerSource: isFixedSource(timeout.runnerSource) ? timeout.runnerSource : 'auto' };
  let second: Awaited<ReturnType<typeof verifyOnce>>;
  try { second = await verifyOnce(env, `${key}-escalated`, fork, sha, baseSha, escalated, assertAuthority, skillChange, isActive, humanBranch); }
  catch (error) {
    if (!await isActive()) throw error;
    const reason = error instanceof Error ? error.message : 'the retry runner failed';
    console.error(JSON.stringify({ event: 'check_escalation_failed', key, seconds: next.seconds, runner: next.runner, message: reason.slice(0, 300) }));
    await onEscalate(`Timed out after ${timeout.seconds} s on ${timeout.runner}; the automatic retry with ${next.seconds} s on ${next.runner} could not run`);
    return { ...first, check: { ...first.check, output: `Automatic retry with ${next.seconds} s on ${next.runner} could not run: ${reason.slice(0, 600)}\n${first.check.output ?? ''}`.slice(0, outputLimit) } };
  }
  second.check.escalatedFrom = timeout;
  if (second.check.status !== 'passed') return second;
  const learned: LearnedLimits = { ...(escalated.testTimeoutSource === 'auto' && next.seconds > timeout.seconds ? { testTimeoutSeconds: next.seconds } : {}), ...(escalated.runnerSource === 'auto' && next.runner !== timeout.runner ? { runner: next.runner } : {}) };
  return { ...second, learned };
}

async function verifyOnce(env: Required<Pick<ExecutionEnv, 'SANDBOX'>>, key: string, fork: ArtifactInfo, sha: string, baseSha: string, policy: RepositoryPolicy, assertAuthority: AuthorityGuard, skillChange?: RepositorySkillChange, isActive: () => Promise<boolean> = async () => true, humanBranch = false): Promise<{ check: Check; changes: FileChange[]; dependencyChanges: ManifestDependencyChanges[] }> {
  let sandbox = env.SANDBOX.getByName(`${key}-verify`);
  try {
    await assertAuthority();
    await sandbox.prepare([{ ...fork, write: false }], { runner: policy.runner });
    sandbox = await cloneOnFreshRunner(sandbox, async () => {
      const fresh = env.SANDBOX.getByName(`${key}-verify-fresh`);
      await assertAuthority();
      await fresh.prepare([{ ...fork, write: false }], { runner: policy.runner });
      return fresh;
    }, fork, baseSha);
    // Dependencies and baseline come from the base commit, before any candidate code executes in this sandbox
    if (policy.install && !policy.untested) await installDependencies(sandbox, policy.install, assertAuthority, isActive);
    const baseline = policy.evidence === 'tap' && !policy.untested ? await runCheck(sandbox, policy) : undefined;
    await checked(sandbox, ['git', 'checkout', '--detach', sha]);
    await checked(sandbox, ['git', 'merge-base', '--is-ancestor', baseSha, sha]);
    const statuses = await changesWithStatus(sandbox, [baseSha, sha]);
    const changedFiles = statuses.map((change) => change.path);
    const { blocked, dependencyChanges } = humanBranch ? { blocked: [], dependencyChanges: [] } : await reviewChanges(sandbox, statuses, policy, baseSha, sha);
    if (blocked.length) throw protectedFailure('Verified candidate changed protected files', blocked);
    const reinstall = (humanBranch ? changedFiles.some((path) => DEPENDENCY_FILES.test(path)) : dependencyChanges.length) && policy.install && !policy.untested ? policy.install : null;
    if (skillChange) {
      if (changedFiles.length !== 1 || changedFiles[0] !== skillChange.path) throw new Error('Skill candidate changed files outside the requested skill');
      await verifySkillBytes(sandbox, skillChange);
    }
    const changes: FileChange[] = [];
    for (const path of changedFiles) {
      const patch = await checked(sandbox, ['git', 'diff', '--no-renames', baseSha, sha, '--', path]);
      changes.push({ path, patch: patch.slice(0, outputLimit), additions: patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length, deletions: patch.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length, runIds: [] });
    }
    const failedInstall = async (plan: InstallPlan): Promise<Check | null> => {
      try { await installDependencies(sandbox, plan, assertAuthority, isActive); return null; }
      catch (error) {
        if (!(error instanceof DependencyInstallError)) throw error;
        return { id: key, name: 'Repository test suite', candidateSha: sha, status: 'failed', output: error.message };
      }
    };
    if (reinstall) {
      const failed = await failedInstall(reinstall);
      if (failed) return { check: failed, changes, dependencyChanges };
    }
    await assertAuthority();
    let checkPolicy = policy;
    if (policy.untested) {
      const starter = await resolveStarterCheck(sandbox);
      if (!starter) return { check: { id: key, name: 'Repository test suite', candidateSha: sha, status: 'failed', output: 'This repository had no tests at the base commit, and the candidate did not add any. Add a node:test file named *.test.mjs, or a package.json with a working "test" script, so the change can be checked.' }, changes, dependencyChanges };
      const failed = starter.install ? await failedInstall(starter.install) : null;
      if (failed) return { check: failed, changes, dependencyChanges };
      checkPolicy = { ...policy, testCommand: starter.testCommand, evidence: starter.evidence, testTimeoutMs: policy.testTimeoutSource === 'default' || policy.testTimeoutSource === 'learned' ? startingTimeoutMs(starter.testCommand, { learnedTimeoutSeconds: Math.round(policy.testTimeoutMs / 1000), autoIncrease: policy.autoIncrease }) : policy.testTimeoutMs };
    }
    const start = Date.now();
    const result = await runCheck(sandbox, checkPolicy);
    const check = checkFromCommand(key, 'Repository test suite', sha, result, Date.now() - start, baseline, checkPolicy.evidence, checkPolicy);
    if (policy.untested) check.name = `${check.name} (tests added by the agent; the repository had none)`;
    return { check, changes, dependencyChanges };
  } finally { await sandbox.destroy(); }
}

export async function verifyRevert(env: Required<Pick<ExecutionEnv, 'SANDBOX'>>, key: string, fork: ArtifactInfo, sha: string, change: RevertChange, defaultTestCommand: string, assertAuthority: AuthorityGuard, isActive: () => Promise<boolean>, runner: RepositoryPolicy['runner'], settings?: CheckPlan | null): Promise<{ check: Check; changes: FileChange[]; learned?: LearnedLimits }> {
  let sandbox = env.SANDBOX.getByName(`${key}-verify`);
  try {
    await assertAuthority();
    // The restored revision's policy is only readable after cloning
    await sandbox.prepare([{ ...fork, write: false }], { runner });
    // The restored revision was itself approved and landed, so its tests define what the revert must keep passing
    sandbox = await cloneOnFreshRunner(sandbox, async () => {
      const fresh = env.SANDBOX.getByName(`${key}-verify-fresh`);
      await assertAuthority();
      await fresh.prepare([{ ...fork, write: false }], { runner });
      return fresh;
    }, fork, change.previousSha);
    const policy = await loadPolicy(sandbox, change.previousSha, defaultTestCommand, settings);
    if (policy.install && !policy.untested) await installDependencies(sandbox, policy.install, assertAuthority, isActive);
    const baseline = policy.evidence === 'tap' && !policy.untested ? await runCheck(sandbox, policy) : undefined;
    await checked(sandbox, ['git', 'checkout', '--detach', sha]);
    const head = (await checked(sandbox, ['git', 'rev-parse', `${sha}^`]));
    const changedFiles = (await checked(sandbox, ['git', 'diff', '--no-renames', '--name-only', head, sha])).split('\n').filter(Boolean);
    const allowed = await landedPaths(sandbox, change);
    if (changedFiles.some((path) => !allowed.includes(path))) throw new Error('Revert candidate changed files outside the landed change');
    const changes: FileChange[] = [];
    for (const path of changedFiles) {
      const patch = await checked(sandbox, ['git', 'diff', '--no-renames', head, sha, '--', path]);
      changes.push({ path, patch: patch.slice(0, outputLimit), additions: patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length, deletions: patch.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length, runIds: [] });
    }
    await assertAuthority();
    if (policy.untested) {
      const differing = (await checked(sandbox, ['git', 'diff', '--no-renames', '--name-only', change.previousSha, sha, '--', ...allowed])).split('\n').filter(Boolean);
      const output = differing.length
        ? `The restored revision ${change.previousSha.slice(0, 12)} has no tests, and later commits also changed: ${differing.join(', ')}. Review the diff before approving.`
        : `The restored revision ${change.previousSha.slice(0, 12)} has no tests. All ${allowed.length} file(s) the landed change touched now match that revision exactly.`;
      return { check: { id: key, name: 'Revert restores the previous files', candidateSha: sha, status: differing.length ? 'failed' : 'passed', output }, changes };
    }
    const start = Date.now();
    const result = await runCheck(sandbox, policy);
    const check = checkFromCommand(key, 'Repository test suite', sha, result, Date.now() - start, baseline, policy.evidence, policy);
    check.name = `${check.name} (tests of the restored revision ${change.previousSha.slice(0, 12)})`;
    return { check, changes };
  } finally { await sandbox.destroy(); }
}
