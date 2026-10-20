import type { CodeownerGroup, NotificationEvent, NotificationReason, NotificationSubject, ReviewRequests } from '../shared/notifications';
import type { BranchRule, Mission, Repository } from '../shared/types';
import { proposalAuthor } from '../shared/pull-requests';
import type { AppEnv } from './env';
import { ownerHandleGroups, readCodeowners, resolveOwnerGroups } from './codeowners';
import { repositorySubject } from './inbox';
import { excerptOf, mentionHandles, notify, type PublishInput } from './notifications';
import { securityClient, type CodeownerRequirement, type SecurityService } from './security';

type Waiter = { waitUntil(promise: Promise<unknown>): void } | undefined;

export async function codeownerGroups(env: AppEnv, access: Pick<SecurityService, 'userIdsByHandles'>, repository: Repository, mission: Pick<Mission, 'baseSha' | 'changes'>): Promise<{ source: string | null; groups: CodeownerGroup[] }> {
  if (!env.ARTIFACTS || repository.provider !== 'artifacts' || !mission.baseSha || !mission.changes.length) return { source: null, groups: [] };
  const codeowners = await readCodeowners(env.ARTIFACTS, repository.name, mission.baseSha);
  if (!codeowners.rules.length) return { source: codeowners.source, groups: [] };
  return { source: codeowners.source, groups: await resolveOwnerGroups(ownerHandleGroups(codeowners, mission.changes.map(change => change.path)), handles => access.userIdsByHandles(handles)) };
}

export async function codeownerRequirement(env: AppEnv, access: Pick<SecurityService, 'userIdsByHandles'>, repository: Repository, mission: Mission, rule: Pick<BranchRule, 'codeowners'> | undefined): Promise<CodeownerRequirement | undefined> {
  if (!rule?.codeowners) return undefined;
  const { groups } = await codeownerGroups(env, access, repository, mission);
  return { groups: groups.map(group => group.userIds), repositoryId: repository.id, ...(proposalAuthor(mission) ? { creatorId: proposalAuthor(mission) } : {}) };
}

export async function proposalSubject(access: SecurityService, repository: Repository, mission: Mission): Promise<NotificationSubject> {
  const source = mission.branchChange?.source;
  return { ...await repositorySubject(access, repository), kind: 'proposal', missionId: mission.id, title: mission.title, ...(source ? { outsideAuthorId: source.authorId, forkRepositoryId: source.repositoryId } : {}) };
}

export async function notifyProposal(env: AppEnv, access: SecurityService, ctx: Waiter, repository: Repository, mission: Mission, input: Omit<PublishInput, 'subject' | 'origin'>): Promise<void> {
  await notify(env, access, ctx, { ...input, subject: await proposalSubject(access, repository, mission), origin: env.APP_ORIGIN });
}

export function proposalOpened(mission: Mission, actorId: string): Omit<PublishInput, 'subject' | 'origin'> {
  const author = proposalAuthor(mission) ?? actorId;
  return { id: `proposal:${mission.repositoryId}:${mission.id}:opened`, event: 'opened', actorId, excerpt: excerptOf(mission.branchChange?.description ?? mission.prompt), mentions: mentionHandles(mission.branchChange?.description), subscribe: [{ userId: author, reason: 'author' }], watchers: true };
}

const REVIEW_EVENTS: Record<string, NotificationEvent> = { comment: 'commented', request_changes: 'changes_requested', approve: 'approved' };

export function proposalReviewed(mission: Mission, actorId: string, action: string, body: string | undefined, summary: boolean): Omit<PublishInput, 'subject' | 'origin'> | null {
  const review = [...mission.reviews ?? []].reverse().find(item => item.authorId === actorId && item.kind === action);
  if (!review) return null;
  const event = summary && action === 'comment' ? 'reviewed' : REVIEW_EVENTS[action] ?? 'commented';
  return { id: `proposal-review:${review.id}`, event, actorId, excerpt: excerptOf(body), mentions: mentionHandles(body), subscribe: [{ userId: actorId, reason: 'reviewer' }], thread: true };
}

export async function afterChecks(env: AppEnv, repositoryId: string, missionId: string, epoch: number): Promise<void> {
  const records = env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`);
  const [mission, repository] = await Promise.all([records.getMission(missionId), records.getRepository(repositoryId)]);
  if (!mission || !repository || mission.epoch !== epoch || !['needs_review', 'failed'].includes(mission.status)) return;
  const access = securityClient(env);
  const thread = `proposal:${repositoryId}:${missionId}`;
  if (mission.status === 'failed') {
    await notifyProposal(env, access, undefined, repository, mission, { id: `${thread}:checks:${epoch}:failed`, event: 'checks_failed', thread: true });
    return;
  }
  if (!mission.candidateSha || !mission.baseSha) return;
  const author = proposalAuthor(mission);
  const { source, groups } = await codeownerGroups(env, access, repository, mission);
  const requests: ReviewRequests = { epoch, candidateSha: mission.candidateSha, baseSha: mission.baseSha, source, groups, requestedAt: new Date().toISOString() };
  await records.setReviewRequests(missionId, requests);
  const owners = [...new Set(groups.flatMap(group => group.userIds))].filter(userId => userId !== author);
  const workspaceId = repository.workspaceId ?? 'legacy';
  const reviewers = owners.length ? [] : (await access.membersWith(workspaceId, repositoryId, 'review').catch(() => [] as string[])).filter(userId => userId !== author);
  const recipients: { userId: string; reason: NotificationReason }[] = [...owners.map(userId => ({ userId, reason: 'review_requested' as const })), ...reviewers.map(userId => ({ userId, reason: 'approval_needed' as const }))];
  await notifyProposal(env, access, undefined, repository, mission, {
    id: `${thread}:checks:${epoch}:${mission.candidateSha}`, event: owners.length ? 'review_requested' : 'checks_passed',
    excerpt: owners.length ? `Code owners of ${groups.flatMap(group => group.paths).slice(0, 3).join(', ')} are asked to review.` : undefined,
    recipients, subscribe: owners.map(userId => ({ userId, reason: 'requested' })), thread: true,
  });
}

export async function afterLanding(env: AppEnv, repositoryId: string, missionId: string, actorId: string): Promise<void> {
  const records = env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`);
  const [mission, repository] = await Promise.all([records.getMission(missionId), records.getRepository(repositoryId)]);
  if (!mission || !repository || mission.status !== 'integrated') return;
  await notifyProposal(env, securityClient(env), undefined, repository, mission, { id: `proposal:${repositoryId}:${missionId}:landed`, event: 'landed', actorId, thread: true });
}

export async function awaitingChecks(env: AppEnv, access: SecurityService, ctx: Waiter, repository: Repository, mission: Mission): Promise<void> {
  const maintainers = await access.membersWith(repository.workspaceId ?? 'legacy', repository.id, 'land').catch(() => [] as string[]);
  await notifyProposal(env, access, ctx, repository, mission, { ...proposalOpened(mission, proposalAuthor(mission) ?? ''), id: `proposal:${repository.id}:${mission.id}:awaiting:${mission.branchChange?.headSha}`, event: 'awaiting_checks', recipients: maintainers.map(userId => ({ userId, reason: 'approval_needed' as const })) });
}

export async function deployFailed(env: AppEnv, repositoryId: string, deploymentId: string, userId: string): Promise<void> {
  const records = env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`);
  const [deployment, repository] = await Promise.all([records.getDeployment(deploymentId), records.getRepository(repositoryId)]);
  if (!deployment || !repository || deployment.status !== 'failed') return;
  const access = securityClient(env);
  const title = `${deployment.environment} deploy${deployment.commitSha ? ` of ${deployment.commitSha.slice(0, 7)}` : ''}`;
  await notify(env, access, undefined, {
    id: `deployment:${repositoryId}:${deploymentId}:failed`, event: 'deploy_failed', subject: { ...await repositorySubject(access, repository), kind: 'deployment', deploymentId, title },
    excerpt: excerptOf(deployment.error), recipients: [{ userId, reason: 'deploy_failed' }], origin: env.APP_ORIGIN,
  });
}
