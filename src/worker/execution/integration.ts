import type { Mission, Repository } from '../../shared/types';
import { activeLandingMessage, withMissionTrailer } from '../../shared/commit-message';
import { validGitSha } from '../artifacts';
import { failureLine } from '../domain';
import { type SandboxRunner, type ExecutionEnv, type AuthorityGuard, unrestricted } from './environment';
import { checked, clone, fetchRef } from './sandbox-git';

export interface IntegrationInput {
  integrationAttemptId?: string;
  beforePush?: (landedSha: string) => Promise<void>;
  repository: Repository;
  mission: Mission & { integrationForkName?: string };
  assertAuthority?: AuthorityGuard;
}

const RUNNER_FAILURE = /^(?:Runner (?:preparation failed|was killed)|Git (?:clone|fetch) |Command failed \(\d+\)|Sandbox (?:command exceeded|is not)|Container stopped)/;

export class IntegrationFailure extends Error {
  constructor(public readonly outcome: 'not_pushed' | 'unknown', message: string) {
    super(message);
    this.name = 'IntegrationFailure';
  }
}

export async function integrateCandidate(env: ExecutionEnv, { repository, mission, assertAuthority = unrestricted, beforePush, integrationAttemptId }: IntegrationInput): Promise<{ sha: string; branch: string; integratedAt: string }> {
  let sandbox: SandboxRunner | undefined;
  let pushAttempted = false;
  let phase = 'validation';
  try {
    if (mission.authorization && assertAuthority === unrestricted) throw new IntegrationFailure('not_pushed', 'Integration authority guard is required');
    if (!env.ARTIFACTS || !env.SANDBOX) throw new IntegrationFailure('not_pushed', 'Artifacts and sandbox are required for integration');
    const { baseSha, candidateSha, integrationForkName } = mission;
    if (!['approved', 'integrating'].includes(mission.status) || !baseSha || !candidateSha || !validGitSha(baseSha) || !validGitSha(candidateSha) || !integrationForkName) throw new IntegrationFailure('not_pushed', 'An approved exact candidate is required');
    if (!mission.checks.some((check) => check.candidateSha === candidateSha && check.status === 'passed') || mission.checks.some((check) => check.status !== 'passed')) throw new IntegrationFailure('not_pushed', 'Candidate checks are not passing');
    phase = 'authorization';
    await assertAuthority();
    phase = 'canonical state check';
    using canonical = await env.ARTIFACTS.get(repository.name);
    const info = await canonical.info();
    const before = (await canonical.log({ ref: repository.defaultBranch, limit: 1 }))[0]?.hash;
    if (before === candidateSha) return { sha: candidateSha, branch: repository.defaultBranch, integratedAt: new Date().toISOString() };
    if (before !== baseSha) throw new IntegrationFailure('not_pushed', 'Canonical branch changed after approval');
    using candidate = await env.ARTIFACTS.get(integrationForkName);
    const fork = await candidate.info();
    sandbox = env.SANDBOX.getByName(`integrate-${mission.id}-${mission.epoch}${integrationAttemptId ? `-${integrationAttemptId}` : ''}`);
    phase = 'runner preparation';
    await assertAuthority();
    await sandbox.prepare([{ ...info, write: true }, { ...fork, write: false }]);
    phase = 'candidate fetch';
    await clone(sandbox, info, baseSha);
    if (await fetchRef(sandbox, fork.remote, 'refs/heads/gitflare-candidate') !== candidateSha) throw new IntegrationFailure('not_pushed', 'Candidate fork changed after approval');
    const message = activeLandingMessage(mission);
    let landedSha = candidateSha;
    if (message) {
      phase = 'commit message';
      landedSha = await recommitWithMessage(sandbox, candidateSha, withMissionTrailer(message, mission.id));
    }
    phase = 'ancestry verification';
    await checked(sandbox, ['git', 'merge-base', '--is-ancestor', baseSha, landedSha]);
    phase = 'authorization';
    await assertAuthority();
    phase = 'canonical push';
    await beforePush?.(landedSha);
    pushAttempted = true;
    const push = await sandbox.command(['git', 'push', '--porcelain', `--force-with-lease=refs/heads/${repository.defaultBranch}:${baseSha}`, 'origin', `${landedSha}:refs/heads/${repository.defaultBranch}`], '/workspace/repo');
    phase = 'canonical confirmation';
    const head = (await canonical.log({ ref: repository.defaultBranch, limit: 1 }))[0]?.hash;
    if (head !== landedSha) {
      const rejected = push.stdout.split('\n').some(line => /^!\t[^\t]+\t\[(?:remote )?rejected\]/.test(line));
      if (push.exitCode !== 0 && rejected) throw new IntegrationFailure('not_pushed', 'The canonical repository rejected the push');
      throw new IntegrationFailure('unknown', 'Canonical head could not be confirmed after integration');
    }
    return { sha: landedSha, branch: repository.defaultBranch, integratedAt: new Date().toISOString() };
  } catch (error) {
    if (error instanceof IntegrationFailure) throw error;
    const detail = error instanceof Error && RUNNER_FAILURE.test(error.message) ? `: ${failureLine(error.message)}` : '';
    throw new IntegrationFailure(pushAttempted ? 'unknown' : 'not_pushed', `Integration failed during ${phase}${detail}.`);
  } finally {
    try { await sandbox?.destroy(); }
    catch { console.error('runner.integration.cleanup.failed', mission.id); }
  }
}

// Identities and dates are copied so a retry on a fresh runner derives the same commit
export async function recommitWithMessage(sandbox: SandboxRunner, candidateSha: string, message: string): Promise<string> {
  const tree = await checked(sandbox, ['git', 'rev-parse', `${candidateSha}^{tree}`]);
  const parents = (await checked(sandbox, ['git', 'show', '-s', '--format=%P', candidateSha])).split(/\s+/).filter(Boolean);
  const [authorName, authorEmail, authorDate, committerName, committerEmail, committerDate] = (await checked(sandbox, ['git', 'show', '-s', '--date=raw', '--format=%an%x00%ae%x00%ad%x00%cn%x00%ce%x00%cd', candidateSha])).split('\0');
  const identity = [`GIT_AUTHOR_NAME=${authorName}`, `GIT_AUTHOR_EMAIL=${authorEmail}`, `GIT_AUTHOR_DATE=${authorDate}`, `GIT_COMMITTER_NAME=${committerName}`, `GIT_COMMITTER_EMAIL=${committerEmail}`, `GIT_COMMITTER_DATE=${committerDate}`];
  const landed = await checked(sandbox, ['env', ...identity, 'git', 'commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', message]);
  if (!validGitSha(landed)) throw new IntegrationFailure('not_pushed', 'The landing commit could not be created');
  const landedTree = await checked(sandbox, ['git', 'rev-parse', `${landed}^{tree}`]);
  const landedParents = (await checked(sandbox, ['git', 'show', '-s', '--format=%P', landed])).split(/\s+/).filter(Boolean);
  if (landedTree !== tree || landedParents.join(' ') !== parents.join(' ')) throw new IntegrationFailure('not_pushed', 'The landing commit does not match the approved tree');
  return landed;
}
