import type { BranchChange, RevertChange } from '../../shared/types';
import { branchName } from '../branch-protection';
import { validGitSha, type ArtifactInfo } from '../artifacts';
import type { CommandResult } from '../../../runner/sandbox';
import { CLONE_ATTEMPTS, CLONE_CLEANUP_TIMEOUT_MS, CLONE_RETRY_BACKOFF_MS, cloneTimeoutMs } from '../budgets';
import { parseNameStatus } from '../repository-policy';
import { outputLimit } from '../check-evidence';
import type { SandboxRunner } from './environment';

export async function checked(sandbox: SandboxRunner, argv: string[], cwd = '/workspace/repo'): Promise<string> {
  const result = await sandbox.command(argv, cwd);
  if (result.exitCode !== 0) throw new Error(`Command failed (${result.exitCode}): ${argv[0]} ${result.stderr.slice(0, 1000)}`);
  return result.stdout.trim();
}

const TIMEOUT_EXIT_CODES = [124, 137, 143];

const TRANSIENT_CLONE = /Could not resolve host|Connection (?:reset|refused|timed out)|Operation timed out|early EOF|RPC failed|unexpected disconnect|remote end hung up|Recv failure|SSL_(?:ERROR|read)|TLS connection|returned error: 5\d\d|HTTP\/2 stream|expected flush after ref listing|protocol error|unexpected EOF|index-pack failed|fetch-pack: invalid/i;

export type CloneRetry = (message: string) => Promise<void>;

function retryPause(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, CLONE_RETRY_BACKOFF_MS * 2 ** (attempt - 1)));
}

function gitNetworkFailure(operation: 'clone' | 'fetch', result: CommandResult, attempt: number): { message: string; transient: boolean } {
  const timedOut = !!result.timedOut || TIMEOUT_EXIT_CODES.includes(result.exitCode);
  const detail = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-6).join('\n').slice(-800);
  const outcome = timedOut ? `timed out after ${Math.round(cloneTimeoutMs(attempt) / 1000)} s (exit ${result.exitCode})` : `failed (exit ${result.exitCode})`;
  return { message: `Git ${operation} ${outcome} on attempt ${attempt} of ${CLONE_ATTEMPTS}${detail ? `: ${detail}` : ''}`, transient: timedOut || TRANSIENT_CLONE.test(detail) };
}

class RunnerKilledError extends Error {
  constructor(message: string) { super(message); this.name = 'RunnerKilledError'; }
}

export async function cloneOnFreshRunner(sandbox: SandboxRunner, replace: () => Promise<SandboxRunner>, fork: ArtifactInfo, baseSha: string, onRetry: CloneRetry = async () => {}): Promise<SandboxRunner> {
  try {
    await clone(sandbox, fork, baseSha, onRetry);
    return sandbox;
  } catch (error) {
    if (!(error instanceof RunnerKilledError)) throw error;
    await onRetry(`${error.message}. Retrying the clone on a fresh runner`);
    try { await sandbox.destroy(); } catch { console.error(JSON.stringify({ event: 'killed_runner_cleanup_failed' })); }
    const fresh = await replace();
    await clone(fresh, fork, baseSha, onRetry);
    return fresh;
  }
}

function moveAsideCommand(attempt: number): string[] {
  return ['/bin/sh', '-c', 'if [ -e /workspace/repo ]; then mv -- /workspace/repo "/workspace/.failed-clone-$1"; fi', 'gitflare-clone-cleanup', String(attempt)];
}

export async function clone(sandbox: SandboxRunner, fork: ArtifactInfo, baseSha: string, onRetry: CloneRetry = async () => {}): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    const result = await sandbox.command(['git', 'clone', '--', fork.remote, '/workspace/repo'], '/workspace', cloneTimeoutMs(attempt));
    if (result.exitCode === 0) break;
    const failure = gitNetworkFailure('clone', result, attempt);
    console.warn(JSON.stringify({ event: 'git_clone_failed', attempt, attempts: CLONE_ATTEMPTS, exitCode: result.exitCode, timedOut: !!result.timedOut, transient: failure.transient, durationMs: Date.now() - started }));
    if (!failure.transient || attempt >= CLONE_ATTEMPTS) throw new Error(failure.message);
    await onRetry(`${failure.message}. Retrying the clone in a clean directory`);
    const cleanup = await sandbox.command(moveAsideCommand(attempt), '/workspace', CLONE_CLEANUP_TIMEOUT_MS);
    const lost = `${failure.message.charAt(0).toLowerCase()}${failure.message.slice(1)}`;
    if (cleanup.exitCode === 137 || cleanup.timedOut) throw new RunnerKilledError(`Runner was killed while moving the failed clone aside (exit ${cleanup.exitCode}) after ${lost}`);
    if (cleanup.exitCode !== 0) throw new Error(`Command failed (${cleanup.exitCode}): moving the failed clone aside ${cleanup.stderr.slice(0, 1000)}`);
    await retryPause(attempt);
  }
  await checked(sandbox, ['git', 'checkout', '--detach', baseSha]);
  await checked(sandbox, ['git', 'config', 'user.name', 'Gitflare']);
  await checked(sandbox, ['git', 'config', 'user.email', 'agent@gitflare.invalid']);
  await checked(sandbox, ['git', 'config', 'core.hooksPath', '/dev/null']);
}

export async function fetchRef(sandbox: SandboxRunner, remote: string, ref: string, options: string[] = []): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    const result = await sandbox.command(['git', 'fetch', ...options, '--', remote, ref], '/workspace/repo', cloneTimeoutMs(attempt));
    if (result.exitCode === 0) return checked(sandbox, ['git', 'rev-parse', 'FETCH_HEAD']);
    const failure = gitNetworkFailure('fetch', result, attempt);
    console.warn(JSON.stringify({ event: 'git_fetch_failed', attempt, attempts: CLONE_ATTEMPTS, exitCode: result.exitCode, timedOut: !!result.timedOut, transient: failure.transient, durationMs: Date.now() - started }));
    if (!failure.transient || attempt >= CLONE_ATTEMPTS) throw new Error(failure.message);
    await retryPause(attempt);
  }
}

export async function changesWithStatus(sandbox: SandboxRunner, range: string[]): Promise<ReturnType<typeof parseNameStatus>> {
  return parseNameStatus(await checked(sandbox, ['git', 'diff', '--no-renames', '--name-status', ...range]));
}

export async function conflictedPaths(sandbox: SandboxRunner): Promise<string[]> {
  const result = await sandbox.command(['git', 'diff', '--name-only', '--diff-filter=U'], '/workspace/repo');
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

export async function workingTreeChanges(sandbox: SandboxRunner): Promise<string[]> {
  const status = await sandbox.command(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], '/workspace/repo');
  if (status.exitCode !== 0) throw new Error(`Command failed (${status.exitCode}): git status ${status.stderr.slice(0, 1000)}`);
  return status.stdout.split('\0').filter(Boolean).map((entry) => entry.slice(3));
}

export async function touchedFiles(sandbox: SandboxRunner): Promise<string[] | null> {
  const status = await sandbox.command(['git', 'status', '--porcelain', '--untracked-files=all', '--no-renames'], '/workspace/repo', 15_000);
  if (status.exitCode !== 0) return null;
  return status.stdout.split('\n').map((line) => line.slice(3).trim()).filter(Boolean).sort().slice(0, 200);
}

export async function landedPaths(sandbox: SandboxRunner, change: RevertChange): Promise<string[]> {
  return (await checked(sandbox, ['git', 'diff', '--no-renames', '--name-only', change.previousSha, change.landedSha])).split('\n').filter(Boolean);
}

export async function applyRevert(sandbox: SandboxRunner, change: RevertChange): Promise<string[]> {
  if (!validGitSha(change.previousSha) || !validGitSha(change.landedSha)) throw new Error('A revert needs exact landed and previous commits');
  await checked(sandbox, ['git', 'merge-base', '--is-ancestor', change.landedSha, 'HEAD']);
  const paths = await landedPaths(sandbox, change);
  if (!paths.length) throw new Error('The landed change has no file differences to revert');
  await checked(sandbox, ['/bin/bash', '-c', `git diff --binary --no-renames ${change.previousSha} ${change.landedSha} > /tmp/gitflare-revert.patch`]);
  const applied = await sandbox.command(['git', 'apply', '-R', '--index', '--3way', '/tmp/gitflare-revert.patch'], '/workspace/repo');
  if (applied.exitCode !== 0) throw new Error(`The landed change no longer reverts cleanly, because later commits changed the same lines: ${(applied.stderr || applied.stdout).trim().slice(0, 600)}`);
  return paths;
}

export type BranchMergeResult = { mode: 'fast-forward' | 'merge' } | { mode: 'conflict'; conflicts: string[]; output: string };

export async function applyBranchMerge(sandbox: SandboxRunner, remote: string, change: BranchChange): Promise<BranchMergeResult> {
  if (!validGitSha(change.headSha)) throw new Error('A pull request needs the exact branch head commit');
  const branch = branchName(change.branch);
  const fetched = await fetchRef(sandbox, remote, `refs/heads/${branch}`, ['--no-tags']);
  if (fetched !== change.headSha) throw new Error(`Branch ${branch} moved to ${fetched.slice(0, 12)} after this proposal recorded ${change.headSha.slice(0, 12)}. Use Update from stream to check the new head.`);
  const target = await checked(sandbox, ['git', 'rev-parse', 'HEAD']);
  if ((await sandbox.command(['git', 'merge-base', '--is-ancestor', change.headSha, target], '/workspace/repo')).exitCode === 0) throw new Error(`Branch ${branch} has no commits that are not already on ${change.targetBranch}`);
  if ((await sandbox.command(['git', 'merge-base', '--is-ancestor', target, change.headSha], '/workspace/repo')).exitCode === 0) {
    await checked(sandbox, ['git', 'merge', '--ff-only', change.headSha]);
    return { mode: 'fast-forward' };
  }
  const merged = await sandbox.command(['git', '-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', '--no-edit', '-m', `Merge branch '${branch}' into ${change.targetBranch}`, change.headSha], '/workspace/repo');
  if (merged.exitCode === 0) return { mode: 'merge' };
  const conflicted = await sandbox.command(['git', 'diff', '--name-only', '--diff-filter=U'], '/workspace/repo');
  await sandbox.command(['git', 'merge', '--abort'], '/workspace/repo');
  return { mode: 'conflict', conflicts: conflicted.stdout.split('\n').map((line) => line.trim()).filter(Boolean), output: `${merged.stdout}\n${merged.stderr}`.slice(0, outputLimit) };
}
