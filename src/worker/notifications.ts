import { DEFAULT_NOTIFICATION_PREFERENCES, EMAIL_MODES, NOTIFICATION_REASONS, threadKey, type EmailMode, type NotificationEvent, type NotificationItem, type NotificationPreferences, type NotificationReason, type NotificationSubject, type SubscriptionState } from '../shared/notifications';
import { ApiError } from './domain';
import type { SqlStore } from './store';
import type { SecurityService } from './security';
import type { AppEnv } from './env';
import { consume } from './rate-limits';

export const NOTIFICATION_THREADS_KEPT = 500;
export const NOTIFICATION_READ_RETENTION_MS = 90 * 86_400_000;
export const THREAD_SUBSCRIBERS_MAX = 500;
export const REPOSITORY_WATCHERS_MAX = 1_000;
export const EVENT_RECIPIENTS_MAX = 200;
export const MENTIONS_PER_POST = 10;
export const INSTANT_EMAILS_PER_HOUR = 6;
export const EMAILS_PER_DAY = 20;
export const DIGEST_QUEUE_MAX = 200;
export const DIGEST_HOUR_UTC = 8;
export const EXCERPT_MAX = 280;
const REASON_RANK: Record<NotificationReason, number> = { review_requested: 0, mention: 1, approval_needed: 2, deploy_failed: 3, participating: 4, watching: 5 };
const MENTION = /(?:^|[^A-Za-z0-9_@/.`-])@([a-z0-9](?:[a-z0-9-]{0,52}[a-z0-9])?)(?![A-Za-z0-9_-])/gi;

export type NotificationRecord = Omit<NotificationItem, 'route' | 'actor'> & { eventIds: string[] };
export interface DigestEntry { id: string; threadId: string; reason: NotificationReason; event: NotificationEvent; subject: NotificationSubject; actorId?: string; excerpt?: string; at: string }
interface EmailLog { day: string; sent: number; hour: number; hourSent: number }
export type NotificationFilter = 'unread' | 'all' | 'archived';

export function excerptOf(text: string | undefined): string | undefined {
  const value = text?.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
  if (!value) return undefined;
  return value.length > EXCERPT_MAX ? `${value.slice(0, EXCERPT_MAX - 1)}…` : value;
}

export function mentionHandles(text: string | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const match of text.replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ').matchAll(MENTION)) {
    found.add(match[1]!.toLowerCase());
    if (found.size >= MENTIONS_PER_POST) break;
  }
  return [...found];
}

export function normalizePreferences(value: unknown, current: NotificationPreferences = DEFAULT_NOTIFICATION_PREFERENCES): NotificationPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'INVALID_INPUT', 'Send notification preferences as an object.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'email' && key !== 'reasons')) throw new ApiError(400, 'INVALID_INPUT', 'Notification preferences take email and reasons.');
  if (input.email !== undefined && typeof input.email !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', 'email must be true or false.');
  const reasons = { ...current.reasons };
  if (input.reasons !== undefined) {
    if (!input.reasons || typeof input.reasons !== 'object' || Array.isArray(input.reasons)) throw new ApiError(400, 'INVALID_INPUT', 'reasons must map a reason to instant, digest or off.');
    for (const [reason, mode] of Object.entries(input.reasons as Record<string, unknown>)) {
      if (!(NOTIFICATION_REASONS as readonly string[]).includes(reason)) throw new ApiError(400, 'INVALID_INPUT', `Unknown notification reason ${reason.slice(0, 40)}.`);
      if (!(EMAIL_MODES as readonly string[]).includes(mode as string)) throw new ApiError(400, 'INVALID_INPUT', 'Choose instant, digest or off.');
      reasons[reason as NotificationReason] = mode as EmailMode;
    }
  }
  return { email: input.email === undefined ? current.email : input.email as boolean, reasons };
}

export function nextDigestAt(now: number): number {
  const date = new Date(now);
  const target = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), DIGEST_HOUR_UTC);
  return target > now ? target : target + 86_400_000;
}

function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

export class NotificationBook {
  constructor(private store: SqlStore, private now: () => number = Date.now) {}

  claim(userId: string): void {
    const owner = this.store.get<string>('nf-owner');
    if (owner && owner !== userId) throw new ApiError(409, 'NOTIFICATION_OWNER_MISMATCH', 'This notification store belongs to another account.');
    if (!owner) this.store.put('nf-owner', userId);
  }

  preferences(): NotificationPreferences { return normalizePreferences(this.store.get<NotificationPreferences>('nf-prefs') ?? {}, DEFAULT_NOTIFICATION_PREFERENCES); }
  setPreferences(value: unknown): NotificationPreferences { const next = normalizePreferences(value, this.preferences()); this.store.put('nf-prefs', next); return next; }

  token(): string {
    let value = this.store.get<string>('nf-token');
    if (!value) { value = [...crypto.getRandomValues(new Uint8Array(24))].map(byte => byte.toString(16).padStart(2, '0')).join(''); this.store.put('nf-token', value); }
    return value;
  }

  unsubscribe(token: string, reason: NotificationReason | 'all'): NotificationPreferences | null {
    const stored = this.store.get<string>('nf-token');
    if (!stored || !sameToken(stored, token)) return null;
    const current = this.preferences();
    const next: NotificationPreferences = reason === 'all' ? { ...current, email: false } : { ...current, reasons: { ...current.reasons, [reason]: 'off' } };
    this.store.put('nf-prefs', next);
    if (reason === 'all') for (const [key] of this.store.entries('nf-digest:')) this.store.delete(key);
    return next;
  }

  rememberOrigin(origin: string | undefined): void { if (origin && this.store.get<string>('nf-origin') !== origin) this.store.put('nf-origin', origin); }
  origin(): string | undefined { return this.store.get<string>('nf-origin'); }

  deliver(input: { id: string; reason: NotificationReason; event: NotificationEvent; subject: NotificationSubject; actorId?: string; excerpt?: string }): { record: NotificationRecord; fresh: boolean } {
    const id = threadKey(input.subject);
    const existing = this.store.get<NotificationRecord>(`nf-thread:${id}`);
    if (existing?.eventIds.includes(input.id)) return { record: existing, fresh: false };
    const at = new Date(this.now()).toISOString();
    const reasons = [...new Set([input.reason, ...(existing && !existing.readAt ? existing.reasons : [])])].sort((a, b) => REASON_RANK[a] - REASON_RANK[b]);
    const record: NotificationRecord = {
      id, reason: reasons[0]!, reasons, event: input.event, subject: input.subject, ...(input.actorId ? { actorId: input.actorId } : {}), ...(input.excerpt ? { excerpt: input.excerpt } : {}),
      count: existing && !existing.readAt ? existing.count + 1 : 1, createdAt: existing?.createdAt ?? at, updatedAt: at, eventIds: [input.id, ...(existing?.eventIds ?? [])].slice(0, 20),
    };
    if (existing) this.store.delete(`nf-order:${existing.updatedAt}:${id}`);
    this.store.put(`nf-thread:${id}`, record);
    this.store.put(`nf-order:${at}:${id}`, id);
    this.prune();
    return { record, fresh: true };
  }

  private prune(): void {
    const order = this.store.entries<string>('nf-order:');
    const cutoff = new Date(this.now() - NOTIFICATION_READ_RETENTION_MS).toISOString();
    order.forEach(([key, id], index) => {
      const record = this.store.get<NotificationRecord>(`nf-thread:${id}`);
      const expired = !!record?.readAt && record.updatedAt < cutoff;
      if (index < order.length - NOTIFICATION_THREADS_KEPT || expired || !record) { this.store.delete(key); this.store.delete(`nf-thread:${id}`); }
    });
  }

  list(filter: NotificationFilter, limit = NOTIFICATION_THREADS_KEPT): NotificationRecord[] {
    const records: NotificationRecord[] = [];
    for (const [, id] of this.store.entries<string>('nf-order:').reverse()) {
      const record = this.store.get<NotificationRecord>(`nf-thread:${id}`);
      if (!record) continue;
      if (filter === 'archived' ? !record.archivedAt : record.archivedAt || filter === 'unread' && record.readAt) continue;
      records.push(record);
      if (records.length >= limit) break;
    }
    return records;
  }

  mark(action: 'read' | 'unread' | 'archive' | 'unarchive' | 'read-all', ids: string[]): number {
    const at = new Date(this.now()).toISOString();
    const targets = action === 'read-all' ? this.list('unread').map(record => record.id) : ids;
    let changed = 0;
    for (const id of targets.slice(0, NOTIFICATION_THREADS_KEPT)) {
      const record = this.store.get<NotificationRecord>(`nf-thread:${id}`);
      if (!record) continue;
      const next = { ...record };
      if (action === 'read' || action === 'read-all') next.readAt ??= at;
      if (action === 'unread') delete next.readAt;
      if (action === 'archive') { next.archivedAt = at; next.readAt ??= at; }
      if (action === 'unarchive') delete next.archivedAt;
      if (JSON.stringify(next) !== JSON.stringify(record)) { this.store.put(`nf-thread:${id}`, next); changed++; }
    }
    return changed;
  }

  forget(ids: string[]): void {
    for (const id of ids) {
      const record = this.store.get<NotificationRecord>(`nf-thread:${id}`);
      if (!record) continue;
      this.store.delete(`nf-order:${record.updatedAt}:${id}`);
      this.store.delete(`nf-thread:${id}`);
    }
  }

  emailMode(reason: NotificationReason): EmailMode {
    const preferences = this.preferences();
    return preferences.email ? preferences.reasons[reason] : 'off';
  }

  private emailLog(): EmailLog {
    const now = this.now();
    const day = new Date(now).toISOString().slice(0, 10), hour = Math.floor(now / 3_600_000);
    const log = this.store.get<EmailLog>('nf-email-log');
    if (!log || log.day !== day) return { day, sent: 0, hour, hourSent: 0 };
    return log.hour === hour ? log : { ...log, hour, hourSent: 0 };
  }

  sentToday(): number { return this.emailLog().sent; }

  instantAllowed(): boolean { const log = this.emailLog(); return log.sent < EMAILS_PER_DAY && log.hourSent < INSTANT_EMAILS_PER_HOUR; }
  dailyAllowed(): boolean { return this.emailLog().sent < EMAILS_PER_DAY; }

  recordEmail(): void { const log = this.emailLog(); this.store.put('nf-email-log', { ...log, sent: log.sent + 1, hourSent: log.hourSent + 1 } satisfies EmailLog); }

  queueDigest(entry: DigestEntry): number {
    const queued = this.store.entries<DigestEntry>('nf-digest:');
    if (queued.some(([, value]) => value.id === entry.id)) return this.digestAt() ?? nextDigestAt(this.now());
    if (queued.length >= DIGEST_QUEUE_MAX) this.store.delete(queued[0]![0]);
    this.store.put(`nf-digest:${entry.at}:${entry.id}`, entry);
    const due = this.digestAt() ?? nextDigestAt(this.now());
    this.store.put('nf-digest-at', due);
    return due;
  }

  digestAt(): number | undefined { return this.store.get<number>('nf-digest-at'); }

  takeDigest(): DigestEntry[] | null {
    const due = this.digestAt();
    if (due === undefined || due > this.now()) return null;
    const entries = this.store.entries<DigestEntry>('nf-digest:');
    for (const [key] of entries) this.store.delete(key);
    this.store.delete('nf-digest-at');
    return entries.map(([, value]) => value);
  }

  postponeDigest(entries: DigestEntry[]): void {
    for (const entry of entries) this.store.put(`nf-digest:${entry.at}:${entry.id}`, entry);
    if (entries.length) this.store.put('nf-digest-at', nextDigestAt(this.now() + 60_000));
  }

  inboxArchive(rows: { id: string; version: string }[], archived: boolean): void {
    for (const row of rows.slice(0, 200)) {
      if (archived) this.store.put(`inbox-archive:${row.id}`, { version: row.version, at: new Date(this.now()).toISOString() });
      else this.store.delete(`inbox-archive:${row.id}`);
    }
    const kept = this.store.entries<{ at: string }>('inbox-archive:').sort((a, b) => a[1].at.localeCompare(b[1].at));
    for (const [key] of kept.slice(0, Math.max(0, kept.length - 2_000))) this.store.delete(key);
  }

  inboxArchived(): Record<string, string> {
    return Object.fromEntries(this.store.entries<{ version: string }>('inbox-archive:').map(([key, value]) => [key.slice('inbox-archive:'.length), value.version]));
  }
}

export interface SubscriptionRecord { state: Exclude<SubscriptionState, 'none'>; reason: string; at: string }

export class SubscriptionBook {
  constructor(private store: SqlStore, private now: () => number = Date.now) {}

  audience(thread: string, add: { userId: string; reason: string }[]): { subscribed: string[]; ignored: string[]; watchers: string[] } {
    const prefix = `nsub:${thread}:`;
    const entries = this.store.entries<SubscriptionRecord>(prefix);
    let count = entries.length;
    for (const { userId, reason } of add) {
      if (count >= THREAD_SUBSCRIBERS_MAX || this.store.get(`${prefix}${userId}`)) continue;
      this.store.put(`${prefix}${userId}`, { state: 'subscribed', reason, at: new Date(this.now()).toISOString() } satisfies SubscriptionRecord);
      count++;
    }
    const all = this.store.entries<SubscriptionRecord>(prefix);
    return {
      subscribed: all.filter(([, value]) => value.state === 'subscribed').map(([key]) => key.slice(prefix.length)),
      ignored: all.filter(([, value]) => value.state === 'ignored').map(([key]) => key.slice(prefix.length)),
      watchers: this.watchers(),
    };
  }

  subscription(thread: string, userId: string): SubscriptionState { return this.store.get<SubscriptionRecord>(`nsub:${thread}:${userId}`)?.state ?? 'none'; }

  setSubscription(thread: string, userId: string, state: SubscriptionState): SubscriptionState {
    const key = `nsub:${thread}:${userId}`;
    if (state === 'none') { this.store.delete(key); return 'none'; }
    if (!this.store.get(key) && this.store.entries(`nsub:${thread}:`).length >= THREAD_SUBSCRIBERS_MAX) throw new ApiError(409, 'SUBSCRIPTION_LIMIT', 'This thread has reached its subscriber limit.');
    this.store.put(key, { state, reason: 'manual', at: new Date(this.now()).toISOString() } satisfies SubscriptionRecord);
    return state;
  }

  setWatcher(userId: string, on: boolean): void {
    if (!on) { this.store.delete(`nwatch:${userId}`); return; }
    if (!this.store.get(`nwatch:${userId}`) && this.store.entries('nwatch:').length >= REPOSITORY_WATCHERS_MAX) return;
    this.store.put(`nwatch:${userId}`, { at: new Date(this.now()).toISOString() });
  }

  watchers(): string[] { return this.store.entries('nwatch:').slice(0, REPOSITORY_WATCHERS_MAX).map(([key]) => key.slice('nwatch:'.length)); }
}

export function notificationStore(userId: string): string { return `notifications:${userId}`; }

export type Receivable = 'member' | 'public' | null | undefined;

export async function receivable(access: Pick<SecurityService, 'recipientAccess'>, userId: string, subject: NotificationSubject, cache = new Map<string, Promise<Receivable>>()): Promise<Receivable> {
  const outsideAuthor = subject.kind === 'proposal' && subject.outsideAuthorId === userId;
  const allowPublic = subject.kind === 'issue' || outsideAuthor;
  const key = `${userId}:${subject.workspaceId}:${subject.repositoryId}:${allowPublic}`;
  let found = cache.get(key);
  if (!found) { found = access.recipientAccess(userId, subject.workspaceId, subject.repositoryId, 'read', allowPublic).catch(() => undefined); cache.set(key, found); }
  const result = await found;
  if (subject.kind === 'proposal' && result === 'public' && !outsideAuthor) return null;
  return result;
}

export function notificationRoute(subject: NotificationSubject, via: 'member' | 'public'): string {
  if (subject.kind === 'issue') return via === 'public' && subject.publicPath ? `${subject.publicPath}/issues/${subject.number}` : `repository/${subject.repositoryId}/issues/${subject.number}`;
  if (subject.kind === 'proposal') return via === 'public' && subject.forkRepositoryId ? `repository/${subject.forkRepositoryId}/pulls` : `mission/${subject.missionId}/discussion`;
  return `repository/${subject.repositoryId}/settings/deploys`;
}

export interface PublishInput {
  id: string;
  event: NotificationEvent;
  subject: NotificationSubject;
  actorId?: string;
  excerpt?: string;
  recipients?: { userId: string; reason: NotificationReason }[];
  mentions?: string[];
  subscribe?: { userId: string; reason: string }[];
  thread?: boolean;
  watchers?: boolean;
  origin?: string;
}

export interface PublishTargets {
  audience(thread: string, add: { userId: string; reason: string }[]): Promise<{ subscribed: string[]; ignored: string[]; watchers: string[] }>;
  deliver(userId: string, input: Omit<PublishInput, 'recipients' | 'mentions' | 'subscribe' | 'thread' | 'watchers'> & { reason: NotificationReason; via: 'member' | 'public' }): Promise<unknown>;
}

export async function publishNotification(access: Pick<SecurityService, 'recipientAccess' | 'userIdsByHandles'>, targets: PublishTargets, input: PublishInput): Promise<string[]> {
  const mentioned = input.mentions?.length ? Object.values(await access.userIdsByHandles(input.mentions)) : [];
  const explicit = [...(input.recipients ?? []), ...mentioned.map(userId => ({ userId, reason: 'mention' as const }))];
  const subscribe = [...(input.subscribe ?? []), ...mentioned.map(userId => ({ userId, reason: 'mentioned' }))];
  const audience = input.thread || input.watchers || subscribe.length ? await targets.audience(threadKey(input.subject), subscribe) : { subscribed: [], ignored: [], watchers: [] };
  const chosen = new Map<string, NotificationReason>();
  const offer = (userId: string, reason: NotificationReason) => {
    if (!userId || userId === input.actorId) return;
    const current = chosen.get(userId);
    if (!current || REASON_RANK[reason] < REASON_RANK[current]) chosen.set(userId, reason);
  };
  for (const { userId, reason } of explicit) offer(userId, reason);
  const ignored = new Set(audience.ignored);
  if (input.thread) for (const userId of audience.subscribed) offer(userId, 'participating');
  if (input.watchers) for (const userId of audience.watchers) if (!ignored.has(userId)) offer(userId, 'watching');
  for (const userId of ignored) if (chosen.get(userId) === 'participating' || chosen.get(userId) === 'watching') chosen.delete(userId);
  const cache = new Map<string, Promise<Receivable>>();
  const delivered: string[] = [];
  const { recipients: _recipients, mentions: _mentions, subscribe: _subscribe, thread: _thread, watchers: _watchers, ...item } = input;
  await Promise.all([...chosen].slice(0, EVENT_RECIPIENTS_MAX).map(async ([userId, reason]) => {
    const via = await receivable(access, userId, input.subject, cache);
    if (!via) return;
    try { await targets.deliver(userId, { ...item, reason, via }); delivered.push(userId); }
    catch (error) { console.warn(JSON.stringify({ event: 'notification_delivery_failed', message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' })); }
  }));
  return delivered.sort();
}

type Waiter = { waitUntil(promise: Promise<unknown>): void } | undefined;

export function notify(env: AppEnv, access: SecurityService, ctx: Waiter, input: PublishInput): Promise<void> {
  const work = (async () => {
    if (input.actorId && await consume(env, 'NOTIFICATION_RATE_LIMIT', `actor:${input.actorId}`)) {
      if (!input.recipients?.length) return;
      input = { ...input, mentions: [], thread: false, watchers: false };
    }
    await publishNotification(access, coordinatorTargets(env), input);
  })().catch(error => console.warn(JSON.stringify({ event: 'notification_publish_failed', message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' })));
  if (ctx) { ctx.waitUntil(work); return Promise.resolve(); }
  return work;
}

export function coordinatorTargets(env: AppEnv): PublishTargets {
  return {
    audience: (thread, add) => env.GITFLARE_COORDINATOR.getByName(`repository:${thread.split(':')[1]}`).notificationAudience(thread, add),
    deliver: (userId, input) => env.GITFLARE_COORDINATOR.getByName(notificationStore(userId)).deliverNotification(userId, input),
  };
}
