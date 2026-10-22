import type { NotificationReason } from '../shared/notifications';
import { deliverNotificationEmail } from './email';
import { notificationEmail, type NotificationEmailItem } from './email/templates';
import type { AppEnv } from './env';
import { receivable, type DigestEntry, type NotificationBook, type Receivable } from './notifications';
import { securityClient } from './security';

export function unsubscribeUrl(origin: string, userId: string, token: string, reason: NotificationReason | 'all'): string {
  return `${origin}/api/public/notifications/unsubscribe?${new URLSearchParams({ user: userId, token, reason })}`;
}

function reference(entry: DigestEntry): string {
  const { subject } = entry;
  return subject.kind === 'issue' ? `#${subject.number}` : subject.kind === 'proposal' ? 'proposal' : subject.kind === 'revision' ? (subject.sha ?? '').slice(0, 7) : subject.kind === 'release' ? subject.tag ?? 'release' : 'deploy';
}

export async function sendNotificationEmail(env: AppEnv, userId: string, book: NotificationBook, entries: DigestEntry[], digest: boolean): Promise<'sent' | 'empty' | 'unavailable'> {
  const origin = env.APP_ORIGIN ?? book.origin();
  if (!origin || !env.EMAIL || !env.EMAIL_FROM) return 'unavailable';
  const access = securityClient(env);
  const recipient = await access.notificationRecipient(userId);
  if (!recipient?.verified) return 'unavailable';
  const cache = new Map<string, Promise<Receivable>>();
  const allowed = (await Promise.all(entries.map(async entry => await receivable(access, userId, entry.subject, cache) ? entry : null))).filter((entry): entry is DigestEntry => !!entry);
  if (!allowed.length) return 'empty';
  const people = await access.profiles([...new Set(allowed.flatMap(entry => entry.actorId ? [entry.actorId] : []))]).catch(() => ({} as Record<string, { name: string; handle: string | null }>));
  const items: NotificationEmailItem[] = allowed.map(entry => ({
    reason: entry.reason, event: entry.event, repository: entry.subject.repositoryName, title: entry.subject.title, reference: reference(entry),
    ...(entry.actorId && people[entry.actorId] ? { actor: people[entry.actorId]!.handle ? `@${people[entry.actorId]!.handle}` : people[entry.actorId]!.name } : {}),
    ...(entry.excerpt ? { excerpt: entry.excerpt } : {}),
    url: `${origin}/inbox?${new URLSearchParams({ thread: entry.threadId })}`,
  }));
  const leave = unsubscribeUrl(origin, userId, book.token(), digest ? 'all' : allowed[0]!.reason);
  const message = notificationEmail({ email: recipient.email, items, digest, inboxUrl: `${origin}/inbox`, settingsUrl: `${origin}/account/notifications`, unsubscribeUrl: leave }, { edition: env.EDITION === 'self-hosted' ? 'self-hosted' : 'hosted', origin });
  const delivery = await deliverNotificationEmail(env, { email: recipient.email, message, unsubscribeUrl: leave });
  if (delivery.status !== 'sent') { console.warn(JSON.stringify({ event: 'notification_email_failed', code: delivery.code })); return 'unavailable'; }
  book.recordEmail();
  return 'sent';
}
