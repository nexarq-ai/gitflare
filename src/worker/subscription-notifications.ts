import type { NotificationReason } from '../shared/notifications';
import type { Mission, Release, Repository } from '../shared/types';
import type { AppEnv } from './env';
import { repositorySubject } from './inbox';
import { excerptOf, notify } from './notifications';
import type { SecurityService } from './security';

type Waiter = { waitUntil(promise: Promise<unknown>): void } | undefined;

export async function subscriberRecipients(access: SecurityService, repository: Repository): Promise<{ userId: string; reason: NotificationReason }[]> {
  if (!await access.publicListing(repository.id).catch(() => null)) return [];
  const [ofRepository, ofOwner] = await Promise.all([
    access.subscribersOf({ kind: 'repository', repositoryId: repository.id }).catch(() => [] as string[]),
    access.subscribersOf({ kind: 'person', workspaceId: repository.workspaceId ?? 'legacy' }).catch(() => [] as string[]),
  ]);
  return [...new Set([...ofRepository, ...ofOwner])].map(userId => ({ userId, reason: 'subscribed' as const }));
}

export async function notifyLanded(env: AppEnv, access: SecurityService, repository: Repository, mission: Pick<Mission, 'id' | 'title' | 'landedSha' | 'candidateSha' | 'landingMessage'>, actorId: string): Promise<void> {
  const sha = mission.landedSha ?? mission.candidateSha;
  if (!sha) return;
  const recipients = await subscriberRecipients(access, repository);
  if (!recipients.length) return;
  await notify(env, access, undefined, {
    id: `revision:${repository.id}:${sha}`, event: 'landed', actorId, recipients, origin: env.APP_ORIGIN,
    subject: { ...await repositorySubject(access, repository), kind: 'revision', sha, missionId: mission.id, title: mission.title },
    excerpt: excerptOf(mission.landingMessage?.message),
  });
}

export async function notifyReleased(env: AppEnv, access: SecurityService, ctx: Waiter, repository: Repository, release: Pick<Release, 'tag' | 'name' | 'notes' | 'authorId' | 'publishedAt'>): Promise<void> {
  if (!release.publishedAt) return;
  const recipients = await subscriberRecipients(access, repository);
  if (!recipients.length) return;
  await notify(env, access, ctx, {
    id: `release:${repository.id}:${release.tag}`, event: 'released', actorId: release.authorId, recipients, origin: env.APP_ORIGIN,
    subject: { ...await repositorySubject(access, repository), kind: 'release', tag: release.tag, title: release.name || release.tag },
    excerpt: excerptOf(release.notes),
  });
}
