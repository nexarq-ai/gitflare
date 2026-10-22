import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mission, Repository } from '../src/shared/types';
import type { ArtifactRepo, ArtifactsBinding } from '../src/worker/artifacts';
import { agentCommitMessage, integrateCandidate, recommitWithMessage, type ExecutionEnv, type SandboxRunner } from '../src/worker/execution';
import { commitMessageInput } from '../src/worker/domain';
import { commitMessageProblem, normalizeCommitMessage, suggestedCommitMessage, withMissionTrailer } from '../src/shared/commit-message';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = gitEnv): string {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function localRunner(root: string): SandboxRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const local = (value: string) => value.replace(/^\/workspace(?=\/|$)/, root);
  return {
    calls,
    prepare: async () => {},
    destroy: async () => {},
    command: async (argv, cwd = '/workspace') => {
      calls.push(argv);
      const [command, ...args] = argv.map(local);
      const result = spawnSync(command, args, { cwd: local(cwd), env: gitEnv, encoding: 'utf8' });
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

const author = { ...gitEnv, GIT_AUTHOR_NAME: 'Agent', GIT_AUTHOR_EMAIL: 'agent@gitflare.test', GIT_AUTHOR_DATE: '1760000000 +0000', GIT_COMMITTER_NAME: 'Gitflare', GIT_COMMITTER_EMAIL: 'runner@gitflare.test', GIT_COMMITTER_DATE: '1760000100 +0000' };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gitflare-landing-'));
  directories.push(root);
  const canonical = join(root, 'canonical.git'), fork = join(root, 'fork.git'), work = join(root, 'work'), runner = join(root, 'runner');
  mkdirSync(runner);
  git(root, ['init', '--bare', '-b', 'main', canonical]);
  git(root, ['init', '-b', 'main', work]);
  writeFileSync(join(work, 'batch.mjs'), 'export const batch = 2;\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'Initial'], author);
  const baseSha = git(work, ['rev-parse', 'HEAD']);
  git(work, ['push', canonical, 'main']);
  git(root, ['clone', '--bare', canonical, fork]);
  writeFileSync(join(work, 'batch.mjs'), 'export const batch = 4;\n');
  writeFileSync(join(work, 'notes.md'), 'Batch doubled.\n');
  git(work, ['add', '.']);
  const mission = { id: 'mission-7', title: 'Double the batch size', epoch: 3 } as Mission;
  git(work, ['commit', '-m', agentCommitMessage(mission, { name: 'Batch', role: 'Implementer' })], author);
  const candidateSha = git(work, ['rev-parse', 'HEAD']);
  git(work, ['push', fork, 'HEAD:refs/heads/gitflare-candidate']);
  const artifacts = { get: async (name: string) => ({
    info: async () => ({ name, remote: name === 'canonical' ? canonical : fork, defaultBranch: 'main' }),
    log: async ({ ref }: { ref: string }) => [{ hash: git(name === 'canonical' ? canonical : fork, ['rev-parse', ref]) }],
    [Symbol.dispose]: () => {},
  } as unknown as ArtifactRepo) } as ArtifactsBinding;
  const sandbox = localRunner(runner);
  const env: ExecutionEnv = { ARTIFACTS: artifacts, SANDBOX: { getByName: () => sandbox } };
  const approved = { ...mission, repositoryId: 'repo', prompt: '', status: 'approved', baseSha, candidateSha, integrationForkName: 'fork', runs: [], events: [], changes: [], createdAt: '', updatedAt: '', checks: [{ id: 'integration', name: 'Tests', status: 'passed', candidateSha }] } as Mission & { integrationForkName: string };
  return { root, canonical, runner, sandbox, env, baseSha, candidateSha, mission: approved, repository: { name: 'canonical', defaultBranch: 'main' } as Repository };
}

const landing = (mission: Mission, message: string, overrides: Partial<NonNullable<Mission['landingMessage']>> = {}): Mission => ({ ...mission, landingMessage: { message, candidateSha: mission.candidateSha!, baseSha: mission.baseSha!, epoch: mission.epoch, setBy: 'owner', setAt: '', ...overrides } });

describe('commit message input', () => {
  it('normalizes control characters and blank lines and enforces the limits', () => {
    expect(normalizeCommitMessage('  Fix\tthe  batch\u0007 ', '\r\n\r\nBody line  \r\n\u001b[31mred\r\n\n')).toBe('Fix the batch\n\nBody line\n[31mred');
    expect(commitMessageInput('Subject\n\n\n  Body')).toBe('Subject\n\n  Body');
    expect(commitMessageInput(undefined)).toBeUndefined();
    expect(() => commitMessageInput('   \n\nOnly a body')).toThrow('INVALID_COMMIT_MESSAGE');
    expect(() => commitMessageInput('x'.repeat(201))).toThrow('200 characters');
    expect(commitMessageInput('x'.repeat(200))).toHaveLength(200);
    expect(() => commitMessageInput(`Subject\n\n${'y'.repeat(10_000)}`)).toThrow('10,000 characters');
    expect(() => commitMessageInput(42)).toThrow('INVALID_INPUT');
    expect(commitMessageProblem('Fine')).toBeNull();
  });

  it('keeps one Gitflare mission trailer', () => {
    expect(withMissionTrailer('Subject', 'm-1')).toBe('Subject\n\nGitflare mission m-1');
    expect(withMissionTrailer('Subject\n\nGitflare mission m-1', 'm-1')).toBe('Subject\n\nGitflare mission m-1');
  });

  it('suggests the title with agent summaries, changed files and agents, or the pending message', () => {
    const mission = { title: 'Double the batch', changes: [{ path: 'batch.mjs' }, { path: 'notes.md' }], runs: [{ id: 'r1', name: 'Batch', role: 'Implementer', status: 'completed', changedFiles: ['batch.mjs'], summary: 'Doubled the batch size.' }, { id: 'r2', name: 'Review', role: 'Reviewer', status: 'completed', changedFiles: [], summary: 'Looks fine.' }], candidateSha: 'b'.repeat(40), baseSha: 'a'.repeat(40), epoch: 2 } as unknown as Mission;
    expect(suggestedCommitMessage(mission)).toEqual({ subject: 'Double the batch', body: '- Batch: Doubled the batch size.\n\nChanged files: batch.mjs, notes.md\n\nAgents: Batch (Implementer), Review (Reviewer)' });
    expect(suggestedCommitMessage(landing(mission, 'Chosen\n\nWords'))).toEqual({ subject: 'Chosen', body: 'Words' });
    expect(suggestedCommitMessage(landing(mission, 'Chosen', { epoch: 1 })).subject).toBe('Double the batch');
  });
});

describe('landing with a commit message', () => {
  it('lands the candidate commit unchanged when no message is given', async () => {
    const context = fixture();
    const beforePush = vi.fn(async () => {});
    const landed = await integrateCandidate(context.env, { repository: context.repository, mission: context.mission, beforePush });
    expect(landed.sha).toBe(context.candidateSha);
    expect(git(context.canonical, ['rev-parse', 'main'])).toBe(context.candidateSha);
    expect(git(context.canonical, ['log', '-1', '--format=%B', 'main'])).toBe('Double the batch size\n\nAgent: Batch (Implementer)\nGitflare mission mission-7');
    expect(beforePush).toHaveBeenCalledWith(context.candidateSha);
    expect(context.sandbox.calls.some(argv => argv.includes('commit-tree'))).toBe(false);
  });

  it('lands the approved tree on the same parents with the chosen message', async () => {
    const context = fixture();
    const beforePush = vi.fn(async () => {});
    const landed = await integrateCandidate(context.env, { repository: context.repository, mission: landing(context.mission, 'Double the batch\n\nThe queue drains twice as fast.'), beforePush });
    expect(landed.sha).not.toBe(context.candidateSha);
    expect(git(context.canonical, ['rev-parse', 'main'])).toBe(landed.sha);
    expect(beforePush).toHaveBeenCalledWith(landed.sha);
    expect(git(context.canonical, ['log', '-1', '--format=%B', 'main'])).toBe('Double the batch\n\nThe queue drains twice as fast.\n\nGitflare mission mission-7');
    const fork = join(context.root, 'fork.git');
    expect(git(context.canonical, ['rev-parse', `${landed.sha}^{tree}`])).toBe(git(fork, ['rev-parse', `${context.candidateSha}^{tree}`]));
    expect(git(context.canonical, ['show', '-s', '--format=%P', landed.sha])).toBe(context.baseSha);
    const identity = (repository: string, sha: string) => git(repository, ['show', '-s', '--format=%an <%ae> %ad|%cn <%ce> %cd', '--date=raw', sha]);
    expect(identity(context.canonical, landed.sha)).toBe(identity(fork, context.candidateSha));  });

  it('derives the same commit on a fresh runner so a retry never forks history', async () => {
    const context = fixture();
    git(context.root, ['clone', '--quiet', join(context.root, 'fork.git'), join(context.runner, 'repo')]);
    const sandbox = localRunner(context.runner);
    const first = await recommitWithMessage(sandbox, context.candidateSha, 'Same\n\nGitflare mission mission-7');
    const second = await recommitWithMessage(sandbox, context.candidateSha, 'Same\n\nGitflare mission mission-7');
    expect(second).toBe(first);
  });

  it('ignores a message chosen for another candidate, base or attempt', async () => {
    const context = fixture();
    const landed = await integrateCandidate(context.env, { repository: context.repository, mission: landing(context.mission, 'Stale', { epoch: 2 }) });
    expect(landed.sha).toBe(context.candidateSha);
  });
});
