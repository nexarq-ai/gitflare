import type { ManifestDependencyChanges } from '../../shared/types';
import type { CommandResult } from '../../../runner/sandbox';
import { describeInstall, detectPackageManager, hasInstallableDependencies, INSTALL_ATTEMPTS, INSTALL_TIMEOUT_MS, installFailureExcerpt, isTransientInstallFailure, type InstallMode, type InstallPlan } from '../package-manager';
import { addsStarterPolicyFile, protectionReason, isGeneratedPath, dependencyManifestPaths, LOCKFILES, POLICY_FILE, starterPolicyFileProblem, type PathChange, type RepositoryPolicy } from '../repository-policy';
import { reviewManifest } from '../dependency-changes';
import { commandOutput, timeoutNotice } from '../check-evidence';
import { type SandboxRunner, type AuthorityGuard, unrestricted } from './environment';
import { checked, conflictedPaths, workingTreeChanges } from './sandbox-git';
import { runBounded } from './verify';

const LOCK_HEAD_BYTES = 4096;

export async function readLockHead(sandbox: SandboxRunner, files: string[], revision?: string): Promise<string | null> {
  const lockfile = ['pnpm-lock.yaml', 'yarn.lock'].find((name) => files.includes(name));
  if (!lockfile) return null;
  const source = revision ? `git show ${revision}:${lockfile}` : `cat ${lockfile}`;
  const result = await sandbox.command(['/bin/sh', '-c', `${source} | head -c ${LOCK_HEAD_BYTES}`], '/workspace/repo');
  return result.exitCode === 0 ? result.stdout : null;
}

export async function workingTreeInstall(sandbox: SandboxRunner, files: string[]): Promise<{ plan: InstallPlan | null; packageJson: string | null; lockHead: string | null }> {
  const manifest = files.includes('package.json') ? await sandbox.command(['cat', 'package.json'], '/workspace/repo') : undefined;
  const packageJson = manifest?.exitCode === 0 ? manifest.stdout : null;
  const lockHead = await readLockHead(sandbox, files);
  return { plan: hasInstallableDependencies(files, packageJson) ? detectPackageManager({ files, packageJson, lockHead }) : null, packageJson, lockHead };
}

interface DependencyReview { blocked: string[]; dependencyChanges: ManifestDependencyChanges[] }

export async function reviewChanges(sandbox: SandboxRunner, changes: PathChange[], policy: RepositoryPolicy, baseRef: string, headRef: string): Promise<DependencyReview> {
  const paths = dependencyManifestPaths(changes, policy);
  const blocked = paths.blocked.map((path) => `${path} (${protectionReason(path, policy)})`);
  const { manifests } = paths;
  const dependencyChanges: ManifestDependencyChanges[] = [];
  for (const { path, added } of manifests) {
    const review = reviewManifest(added ? null : await checked(sandbox, ['git', 'show', `${baseRef}:${path}`]), await checked(sandbox, ['git', 'show', `${headRef}:${path}`]));
    if (!review.ok) blocked.push(`${path} ${review.reason}`);
    else if (review.changes.length) dependencyChanges.push({ path, changes: review.changes });
  }
  if (addsStarterPolicyFile(changes, policy)) {
    const problem = starterPolicyFileProblem(await checked(sandbox, ['git', 'show', `${headRef}:${POLICY_FILE}`]));
    if (problem) blocked.push(`${POLICY_FILE}: ${problem}`);
  }
  return { blocked, dependencyChanges };
}

export async function installDependencies(sandbox: SandboxRunner, plan: InstallPlan, assertAuthority: AuthorityGuard = unrestricted, isActive: () => Promise<boolean> = async () => true, mode: InstallMode = 'install'): Promise<void> {
  if (!sandbox.install) throw new Error('This runner cannot install dependencies');
  let result: CommandResult | undefined;
  for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt++) {
    if (!await isActive()) throw new Error('Mission cancelled');
    await assertAuthority();
    result = mode === 'install' ? await sandbox.install(plan) : await sandbox.install(plan, mode);
    if (result.exitCode === 0) return;
    const transient = isTransientInstallFailure(`${result.stderr}\n${result.stdout}`);
    if (attempt === INSTALL_ATTEMPTS || !transient) break;
    console.warn(JSON.stringify({ event: 'dependency_install_retry', installer: plan.installer, attempt, attempts: INSTALL_ATTEMPTS, exitCode: result.exitCode, timedOut: !!result.timedOut }));
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  const failure = installFailureExcerpt(`${result!.stderr}\n${result!.stdout}`);
  const timedOut = result!.timedOut ? ` after the ${Math.round(INSTALL_TIMEOUT_MS / 1000)} s install limit` : '';
  throw new DependencyInstallError(`${mode === 'lockfile' ? 'Lockfile regeneration' : 'Dependency installation'} with ${describeInstall(plan)} failed (${result!.exitCode})${timedOut}: ${failure.headline}\n${failure.excerpt}`.slice(0, 2000));
}

export class DependencyInstallError extends Error {}

export const AGENT_INSTALL_RESERVE_MS = 60_000;

const AGENT_INSTALL_MIN_MS = 150_000;

export async function workingFiles(sandbox: SandboxRunner): Promise<string[]> {
  return (await checked(sandbox, ['git', 'ls-files', '--cached', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
}

export async function agentInstall(sandbox: SandboxRunner, remainingMs: number, assertAuthority: AuthorityGuard = unrestricted, isActive: () => Promise<boolean> = async () => true): Promise<string> {
  if (!sandbox.install) return 'This runner cannot install dependencies.';
  if (remainingMs < AGENT_INSTALL_MIN_MS) return `Only ${Math.round(remainingMs / 1000)} s of agent time is left, too little for an install. Finish without it; Gitflare installs dependencies again during the check.`;
  const files = await workingFiles(sandbox);
  const { plan } = await workingTreeInstall(sandbox, files);
  if (!plan) return 'Nothing to install: there is no package.json, or it declares no dependencies.';
  const trackedLocks = (await checked(sandbox, ['git', 'ls-files'])).split('\n').filter((path) => LOCKFILES.test(path));
  const unlocked: InstallPlan = { ...plan, lockfile: null };
  try {
    await installDependencies(sandbox, unlocked, assertAuthority, isActive);
    return `Installed dependencies with ${describeInstall(unlocked)} through the registry-only proxy. Lockfile changes were discarded; Gitflare regenerates the lockfile after you finish.`;
  } catch (error) {
    if (error instanceof DependencyInstallError) return `${error.message}\nFix package.json and call install_dependencies again.`;
    throw error;
  } finally {
    if (trackedLocks.length) await sandbox.command(['git', 'checkout', 'HEAD', '--', ...trackedLocks], '/workspace/repo');
  }
}

export async function detectedLockfile(sandbox: SandboxRunner, revision: string): Promise<string | null> {
  const tree = await sandbox.command(['git', 'ls-tree', '-r', '--name-only', revision], '/workspace/repo');
  const files = tree.exitCode === 0 ? tree.stdout.split('\n').filter(Boolean) : [];
  if (!files.includes('package.json')) return null;
  const manifest = await sandbox.command(['git', 'show', `${revision}:package.json`], '/workspace/repo');
  return detectPackageManager({ files, packageJson: manifest.exitCode === 0 ? manifest.stdout : null, lockHead: await readLockHead(sandbox, files, revision) })?.lockfile ?? null;
}

export async function keepIntegrationVersion(sandbox: SandboxRunner, paths: string[]): Promise<void> {
  for (const path of paths) {
    const ours = await sandbox.command(['git', 'checkout', '--ours', '--', path], '/workspace/repo');
    await checked(sandbox, ours.exitCode === 0 ? ['git', 'add', '--', path] : ['git', 'rm', '-q', '-f', '--', path]);
  }
  const remaining = await conflictedPaths(sandbox);
  if (remaining.length) throw new Error(`Merge conflicts remain in: ${remaining.join(', ')}`);
  await checked(sandbox, ['git', '-c', 'core.hooksPath=/dev/null', 'commit', '--no-edit']);
}

export class GeneratedFilesFailure extends Error {}

export interface Regeneration { changed: string[]; lockfilePlan: InstallPlan | null; command: string | null }

export async function regenerateFiles(sandbox: SandboxRunner, policy: RepositoryPolicy, generated: string[], lockfile: string | null, assertAuthority: AuthorityGuard, isActive: () => Promise<boolean>): Promise<Regeneration> {
  const files = async () => (await checked(sandbox, ['git', 'ls-files'])).split('\n').filter(Boolean);
  let lockfilePlan: InstallPlan | null = null;
  if (lockfile) {
    lockfilePlan = (await workingTreeInstall(sandbox, await files())).plan;
    if (!lockfilePlan || lockfilePlan.lockfile !== lockfile) throw new GeneratedFilesFailure(`${lockfile} conflicted between agents, but it is not the lockfile of the package manager detected after merging, so it cannot be regenerated.`);
    await installDependencies(sandbox, lockfilePlan, assertAuthority, isActive, 'lockfile');
  }
  const command = generated.length ? policy.generated?.command ?? null : null;
  if (command) {
    const plan = policy.untested ? (await workingTreeInstall(sandbox, await files())).plan : policy.install;
    if (plan) await installDependencies(sandbox, plan, assertAuthority, isActive);
    if (!await isActive()) throw new Error('Mission cancelled');
    await assertAuthority();
    const result = await runBounded(sandbox, command, policy.testTimeoutMs);
    if (result.exitCode !== 0 || result.timedOut) throw new GeneratedFilesFailure(`${timeoutNotice(result, policy, 'Generate command: ')}\`${command}\` failed (exit ${result.exitCode}).\n${commandOutput(result)}`);
  }
  const changed = await workingTreeChanges(sandbox);
  const outside = changed.filter((path) => path !== lockfile && !isGeneratedPath(path, policy.generated?.paths ?? []));
  if (outside.length) throw new GeneratedFilesFailure(`Regenerating generated files changed paths outside the generated paths: ${outside.slice(0, 20).join(', ')}. Only ${[...(policy.generated?.paths ?? []), ...(lockfile ? [lockfile] : [])].join(', ')} may change.`);
  if (changed.length) {
    await checked(sandbox, ['git', 'add', '-A', '--', ...changed]);
    await checked(sandbox, ['git', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Regenerate generated files']);
  }
  return { changed, lockfilePlan, command };
}

export class LockfileFailure extends Error {}

export const LOCKFILE_COMMIT = 'Update lockfile for dependency changes';

export interface LockfileUpdate { lockfile: string; plan: InstallPlan; changed: boolean }

export async function updateLockfile(sandbox: SandboxRunner, restoreFrom: string | null, assertAuthority: AuthorityGuard, isActive: () => Promise<boolean>): Promise<LockfileUpdate | null> {
  const { plan } = await workingTreeInstall(sandbox, (await checked(sandbox, ['git', 'ls-files'])).split('\n').filter(Boolean));
  if (!plan?.lockfile) return null;
  const { lockfile } = plan;
  if (restoreFrom && (await sandbox.command(['git', 'cat-file', '-e', `${restoreFrom}:${lockfile}`], '/workspace/repo')).exitCode === 0) await checked(sandbox, ['git', 'checkout', restoreFrom, '--', lockfile]);
  try { await installDependencies(sandbox, plan, assertAuthority, isActive, 'lockfile'); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('Lockfile regeneration')) throw new LockfileFailure(error.message);
    throw error;
  }
  const changed = await workingTreeChanges(sandbox);
  const outside = changed.filter((path) => path !== lockfile);
  if (outside.length) throw new LockfileFailure(`Regenerating ${lockfile} with ${describeInstall(plan)} in lockfile-only mode also changed ${outside.slice(0, 20).join(', ')}${outside.length > 20 ? ` and ${outside.length - 20} more` : ''}. Only ${lockfile} may change.`);
  if (changed.length) {
    await checked(sandbox, ['git', 'add', '--', lockfile]);
    await checked(sandbox, ['git', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', LOCKFILE_COMMIT]);
  }
  return { lockfile, plan, changed: changed.length > 0 };
}

export function lockfileEvent(update: LockfileUpdate | null, packages: string): string {
  if (!update) return `the repository has no lockfile, so none was generated for the dependency changes (${packages})`;
  if (!update.changed) return `${update.lockfile} already matched the dependency changes (${packages})`;
  return `regenerated ${update.lockfile} with ${describeInstall(update.plan)} in lockfile-only mode for the dependency changes (${packages})`;
}
