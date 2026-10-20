import { INBOX_KINDS, NOTIFICATION_REASONS, threadKey, type InboxKind, type InboxRow, type InboxView, type NotificationItem, type NotificationList, type NotificationReason, type NotificationSettings, type NotificationSubject, type SubscriptionState } from '../shared/notifications';
import type { Advisory, Issue, MissionSummary, Repository } from '../shared/types';
import { proposalAuthor, waitingForMaintainer } from '../shared/pull-requests';
import { repositoryLabel } from '../shared/repository-names';
import { ApiError, assertMutationOrigin, readJson, requireString } from './domain';
import type { AppEnv } from './env';
import { catalogName } from './capacity';
import { notificationRoute, notificationStore, receivable, type NotificationFilter, type NotificationRecord, type Receivable } from './notifications';
import { publicPrincipal, type Action, type Principal, type SecurityService } from './security';
import { resolvePublicRepository } from './public-repositories';
import { unsubscribeUrl } from './notification-email';
import { consume, rateLimitedResponse } from './rate-limits';

const PAGE_MAX = 50;
const INBOX_REPOSITORIES_MAX = 100;
const MARK_ACTIONS = ['read', 'unread', 'archive', 'unarchive', 'read-all'] as const;
const FILTERS: NotificationFilter[] = ['unread', 'all', 'archived'];

function accountPrincipal(p: Principal): void {
  if (p.kind !== undefined || p.credentialId) throw new ApiError(403, 'ACCOUNT_REQUIRED', 'Notifications belong to a signed-in account, not a token.');
}

function pageArgs(url: URL): { offset: number; limit: number } {
  const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 20);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) throw new ApiError(400, 'INVALID_INPUT', `offset must be 0 or more and limit 1 to ${PAGE_MAX}.`);
  return { offset, limit };
}

function idList(value: unknown, field = 'ids'): string[] {
  if (!Array.isArray(value) || value.length > 200 || value.some(id => typeof id !== 'string' || !id || id.length > 300)) throw new ApiError(400, 'INVALID_INPUT', `${field} must be a list of up to 200 identifiers.`);
  return [...new Set(value as string[])];
}

export async function repositorySubject(access: Pick<SecurityService, 'handleOf' | 'publicListing'>, repository: Repository): Promise<Pick<NotificationSubject, 'workspaceId' | 'repositoryId' | 'repositoryName' | 'publicPath'>> {
  const workspaceId = repository.workspaceId ?? 'legacy';
  const [handle, listing] = await Promise.all([access.handleOf(workspaceId).catch(() => null), access.publicListing(repository.id).catch(() => null)]);
  const label = repositoryLabel(repository);
  return { workspaceId, repositoryId: repository.id, repositoryName: handle ? `${handle}/${label}` : label, ...(handle && listing ? { publicPath: `${handle}/${label}` } : {}) };
}

function coordinator(env: AppEnv, name: string) { return env.GITFLARE_COORDINATOR.getByName(name); }

async function notificationList(env: AppEnv, access: SecurityService, p: Principal, url: URL): Promise<NotificationList> {
  const filter = (url.searchParams.get('filter') ?? 'unread') as NotificationFilter;
  if (!FILTERS.includes(filter)) throw new ApiError(400, 'INVALID_INPUT', 'Filter by unread, all or archived.');
  const reason = url.searchParams.get('reason');
  if (reason && !(NOTIFICATION_REASONS as readonly string[]).includes(reason)) throw new ApiError(400, 'INVALID_INPUT', 'Unknown notification reason.');
  const repository = url.searchParams.get('repository'), thread = url.searchParams.get('thread'), age = url.searchParams.get('age');
  const days = age === null ? null : Number(age);
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) throw new ApiError(400, 'INVALID_INPUT', 'age is a number of days from 1 to 365.');
  const since = days === null ? '' : new Date(Date.now() - days * 86_400_000).toISOString();
  const { offset, limit } = pageArgs(url);
  const store = coordinator(env, notificationStore(p.userId));
  const [records, unreadRecords]: [NotificationRecord[], NotificationRecord[] | null] = await Promise.all([store.notifications(p.userId, filter), filter === 'unread' ? Promise.resolve(null) : store.notifications(p.userId, 'unread')]);
  const cache = new Map<string, Promise<Receivable>>();
  const assess = (list: NotificationRecord[]) => Promise.all(list.map(async record => ({ record, via: await receivable(access, p.userId, record.subject, cache) })));
  const checked = async (list: NotificationRecord[]) => (await assess(list)).filter(entry => !!entry.via) as { record: NotificationRecord; via: 'member' | 'public' }[];
  const assessed = await assess(records);
  const visible = assessed.filter(entry => !!entry.via) as { record: NotificationRecord; via: 'member' | 'public' }[];
  const hidden = assessed.filter(entry => entry.via === null).map(entry => entry.record.id);
  if (hidden.length) await Promise.resolve().then(() => store.forgetNotifications(p.userId, hidden)).catch(() => {});
  const unread = filter === 'unread' ? visible.length : (await checked(unreadRecords ?? [])).length;
  const matching = visible.filter(({ record }) => (!reason || record.reasons.includes(reason as NotificationReason)) && (!repository || record.subject.repositoryId === repository) && (!thread || record.id === thread) && record.updatedAt >= since);
  const page = matching.slice(offset, offset + limit);
  const people = await access.profiles([...new Set(page.flatMap(({ record }) => record.actorId ? [record.actorId] : []))]).catch(() => ({} as Record<string, { name: string; handle: string | null }>));
  const items: NotificationItem[] = page.map(({ record, via }) => {
    const { eventIds: _eventIds, ...item } = record;
    return { ...item, ...(record.actorId ? { actor: people[record.actorId] ?? null } : {}), route: notificationRoute(record.subject, via) };
  });
  return { items, unread, total: matching.length, offset, nextOffset: offset + items.length < matching.length ? offset + items.length : null };
}

async function notificationSettings(env: AppEnv, access: SecurityService, p: Principal): Promise<NotificationSettings> {
  const [stored, recipient] = await Promise.all([coordinator(env, notificationStore(p.userId)).notificationPreferences(p.userId), access.notificationRecipient(p.userId).catch(() => null)]);
  return { preferences: stored.preferences, email: { address: recipient?.email ?? null, verified: !!recipient?.verified, configured: !!env.EMAIL && !!env.EMAIL_FROM, nextDigestAt: stored.nextDigestAt, sentToday: stored.sentToday, dailyLimit: 20 } };
}

type ThreadTarget = { thread: string; workspaceId: string; repositoryId: string };

async function threadTarget(env: AppEnv, access: SecurityService, p: Principal, input: Record<string, unknown> | URLSearchParams): Promise<ThreadTarget> {
  const get = (name: string) => input instanceof URLSearchParams ? input.get(name) ?? undefined : input[name];
  const kind = get('kind');
  if (kind !== 'issue' && kind !== 'proposal') throw new ApiError(400, 'INVALID_INPUT', 'Choose an issue or a proposal thread.');
  const numberValue = Number(get('number'));
  if (kind === 'issue' && (!Number.isInteger(numberValue) || numberValue < 1)) throw new ApiError(400, 'INVALID_INPUT', 'Pass the issue number.');
  const missionId = kind === 'proposal' ? requireString(get('missionId'), 'Proposal', 100) : undefined;
  if (missionId && !/^[a-zA-Z0-9-]+$/.test(missionId)) throw new ApiError(400, 'INVALID_INPUT', 'Pass a proposal ID.');
  let repository: Repository | undefined; let principal = p;
  if (get('handle') !== undefined) {
    if (kind !== 'issue') throw new ApiError(400, 'INVALID_INPUT', 'Public addresses take issue threads only.');
    const target = await resolvePublicRepository(env, access, String(get('handle')).toLowerCase(), requireString(get('repository'), 'Repository', 100));
    if (!target || 'redirect' in target) throw new ApiError(404, 'NOT_FOUND', 'This repository could not be found.');
    repository = target.repository;
    principal = p.kind === undefined && p.sessionId ? await access.participant(p, target.workspaceId) : publicPrincipal(target.workspaceId);
    await access.check(principal, 'read', 'repository', repository.id).catch(() => { throw new ApiError(404, 'NOT_FOUND', 'This repository could not be found.'); });
  } else {
    repository = await coordinator(env, catalogName(p.workspaceId)).getRepository(requireString(get('repositoryId'), 'Repository', 100));
    if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
    await access.authorize(p, 'read', 'repository', repository.id, missionId);
  }
  const records = coordinator(env, `repository:${repository.id}`);
  if (kind === 'issue' && !await records.getIssue(numberValue)) throw new ApiError(404, 'ISSUE_NOT_FOUND', 'This issue could not be found.');
  if (missionId && !await records.getMission(missionId)) throw new ApiError(404, 'MISSION_NOT_FOUND', 'This proposal could not be found.');
  return { thread: threadKey({ kind, repositoryId: repository.id, number: numberValue, missionId }), workspaceId: repository.workspaceId ?? 'legacy', repositoryId: repository.id };
}

function inboxRoute(kind: InboxKind, repositoryId: string, id: string | number): string {
  return kind === 'new_issue' ? `repository/${repositoryId}/issues/${id}` : `mission/${id}/${kind === 'awaiting_checks' ? 'overview' : 'changes'}`;
}

export async function inboxRows(env: AppEnv, access: SecurityService, p: Principal): Promise<InboxRow[]> {
  const repositories = (await coordinator(env, catalogName(p.workspaceId)).listRepositories()).slice(0, INBOX_REPOSITORIES_MAX);
  const resources = repositories.map(repository => ({ resourceType: 'repository', resourceId: repository.id }));
  const allowed = async (action: Action) => access.checkMany(p, action, resources).catch(() => resources.map(() => false));
  const [triage, review, land] = await Promise.all([allowed('triage'), allowed('review'), allowed('land')]);
  const rows: InboxRow[] = [];
  const needsApprovals: { row: InboxRow; mission: MissionSummary; requested: boolean }[] = [];
  await Promise.all(repositories.map(async (repository, index) => {
    if (!triage[index] && !review[index] && !land[index]) return;
    const records = coordinator(env, `repository:${repository.id}`);
    const name = repositoryLabel(repository);
    const [missions, issues] = await Promise.all([review[index] || land[index] ? records.listMissionSummaries() : Promise.resolve([] as MissionSummary[]), triage[index] ? Promise.resolve().then(() => records.listIssues({ state: 'open' })).then(page => page.items, () => [] as Issue[]) : Promise.resolve([] as Issue[])]);
    for (const mission of missions) {
      const author = proposalAuthor(mission);
      const base = { repositoryId: repository.id, repositoryName: name, title: mission.title, missionId: mission.id, ...(author ? { authorId: author } : {}), ...(mission.branchChange?.source ? { outside: true } : {}), updatedAt: mission.updatedAt };
      if (land[index] && waitingForMaintainer(mission)) {
        rows.push({ ...base, id: `awaiting_checks:${mission.id}`, kind: 'awaiting_checks', version: `${mission.epoch}:${mission.branchChange!.headSha}`, route: inboxRoute('awaiting_checks', repository.id, mission.id), actions: ['run_checks', 'open'] });
        continue;
      }
      if (!review[index] || mission.status !== 'needs_review' || mission.openChangeRequests > 0 || author === p.userId || !mission.candidateSha || !mission.baseSha) continue;
      const requests = mission.reviewRequests && mission.reviewRequests.epoch === mission.epoch && mission.reviewRequests.candidateSha === mission.candidateSha ? mission.reviewRequests : undefined;
      const mine = requests?.groups.filter(group => group.userIds.includes(p.userId)) ?? [];
      const kind: InboxKind = mine.length ? 'review_requested' : 'needs_review';
      needsApprovals.push({ mission, requested: !!mine.length, row: { ...base, id: `${kind}:${mission.id}`, kind, version: `${mission.epoch}:${mission.candidateSha}`, route: inboxRoute(kind, repository.id, mission.id), actions: ['open'], ...(mine.length ? { owners: [...new Set(mine.flatMap(group => group.handles))] } : {}) } });
    }
    if (land[index] && p.kind === undefined && !p.credentialId) {
      const reports = await Promise.resolve().then(() => records.listAdvisories() as Promise<Advisory[]>).catch(() => [] as Advisory[]);
      for (const advisory of reports) {
        if (advisory.state !== 'draft' || advisory.source !== 'report' || advisory.acknowledgedAt) continue;
        rows.push({ id: `security_report:${repository.id}:${advisory.id}`, kind: 'security_report', version: advisory.updatedAt, repositoryId: repository.id, repositoryName: name, title: advisory.title, advisoryId: advisory.id, ...(advisory.reporterId ? { authorId: advisory.reporterId } : {}), updatedAt: advisory.updatedAt, route: `repository/${repository.id}/security/${advisory.id}`, actions: ['open'] });
      }
    }
    for (const issue of issues) {
      if (issue.labels.length || issue.assignees.length || issue.authorId === p.userId) continue;
      rows.push({ id: `new_issue:${repository.id}:${issue.number}`, kind: 'new_issue', version: issue.updatedAt, repositoryId: repository.id, repositoryName: name, title: issue.title, number: issue.number, authorId: issue.authorId, updatedAt: issue.updatedAt, route: inboxRoute('new_issue', repository.id, issue.number), actions: ['open'] });
    }
  }));
  const approvals = await access.approvers(p, needsApprovals.map(({ mission }) => ({ missionId: mission.id, candidateSha: mission.candidateSha!, baseSha: mission.baseSha!, epoch: mission.epoch }))).catch(() => needsApprovals.map(() => [] as string[]));
  needsApprovals.forEach(({ row }, index) => { if (!approvals[index]?.includes(p.userId)) rows.push(row); });
  const order: Record<InboxKind, number> = { security_report: 0, review_requested: 1, awaiting_checks: 2, needs_review: 3, new_issue: 4 };
  return rows.sort((a, b) => order[a.kind] - order[b.kind] || b.updatedAt.localeCompare(a.updatedAt));
}

async function inboxView(env: AppEnv, access: SecurityService, p: Principal, url: URL): Promise<InboxView> {
  const kind = url.searchParams.get('kind'), repository = url.searchParams.get('repository'), age = url.searchParams.get('age');
  if (kind && !(INBOX_KINDS as readonly string[]).includes(kind)) throw new ApiError(400, 'INVALID_INPUT', `Filter by ${INBOX_KINDS.join(', ')}.`);
  const days = age === null ? null : Number(age);
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) throw new ApiError(400, 'INVALID_INPUT', 'age is a number of days from 1 to 365.');
  const archivedOnly = url.searchParams.get('archived') === 'true';
  const { offset, limit } = pageArgs(url);
  const [rows, archived] = await Promise.all([inboxRows(env, access, p), coordinator(env, notificationStore(p.userId)).inboxArchived(p.userId)]);
  const since = days === null ? '' : new Date(Date.now() - days * 86_400_000).toISOString();
  const archivedCount = rows.filter(row => archived[row.id] === row.version).length;
  const matching = rows.filter(row => (archived[row.id] === row.version) === archivedOnly && (!kind || row.kind === kind) && (!repository || row.repositoryId === repository) && row.updatedAt >= since);
  const page = matching.slice(offset, offset + limit);
  const people = await access.profiles([...new Set(page.flatMap(row => row.authorId ? [row.authorId] : []))]).catch(() => ({} as Record<string, { name: string; handle: string | null }>));
  const repositories = [...new Map(rows.map(row => [row.repositoryId, { id: row.repositoryId, name: row.repositoryName }])).values()];
  return { rows: page.map(row => ({ ...row, ...(row.authorId ? { author: people[row.authorId] ?? null } : {}) })), archived: archivedCount, repositories, total: matching.length, offset, nextOffset: offset + page.length < matching.length ? offset + page.length : null };
}

export async function notificationsApi(request: Request, env: AppEnv, principal: Principal, access: SecurityService): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!['/api/notifications', '/api/notifications/settings', '/api/notifications/subscription', '/api/inbox'].includes(path)) return null;
  accountPrincipal(principal);
  const store = coordinator(env, notificationStore(principal.userId));
  if (request.method === 'GET') {
    if (path === '/api/notifications') return Response.json(await notificationList(env, access, principal, url), { headers: { 'Cache-Control': 'no-store' } });
    if (path === '/api/notifications/settings') return Response.json(await notificationSettings(env, access, principal), { headers: { 'Cache-Control': 'no-store' } });
    if (path === '/api/inbox') return Response.json(await inboxView(env, access, principal, url), { headers: { 'Cache-Control': 'no-store' } });
    const target = await threadTarget(env, access, principal, url.searchParams);
    return Response.json({ thread: target.thread, state: await coordinator(env, `repository:${target.repositoryId}`).notificationSubscription(target.thread, principal.userId) });
  }
  if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST.');
  assertMutationOrigin(request);
  const body = await readJson(request, 32_768);
  if (path === '/api/notifications/settings') {
    await store.setNotificationPreferences(principal.userId, body);
    return Response.json(await notificationSettings(env, access, principal));
  }
  if (path === '/api/notifications/subscription') {
    const state = body.state as SubscriptionState;
    if (!['subscribed', 'ignored', 'none'].includes(state)) throw new ApiError(400, 'INVALID_INPUT', 'Choose subscribed, ignored or none.');
    const target = await threadTarget(env, access, principal, body);
    return Response.json({ thread: target.thread, state: await coordinator(env, `repository:${target.repositoryId}`).setNotificationSubscription(target.thread, principal.userId, state) });
  }
  if (path === '/api/inbox') {
    if (body.action !== 'archive' && body.action !== 'unarchive') throw new ApiError(400, 'INVALID_INPUT', 'Choose archive or unarchive.');
    const ids = new Set(idList(body.ids));
    const rows = (await inboxRows(env, access, principal)).filter(row => ids.has(row.id));
    await store.archiveInboxRows(principal.userId, rows.map(row => ({ id: row.id, version: row.version })), body.action === 'archive');
    return Response.json(await inboxView(env, access, principal, url));
  }
  const action = body.action as typeof MARK_ACTIONS[number];
  if (!MARK_ACTIONS.includes(action)) throw new ApiError(400, 'INVALID_INPUT', `Choose ${MARK_ACTIONS.join(', ')}.`);
  const changed = await store.markNotifications(principal.userId, action, action === 'read-all' ? [] : idList(body.ids));
  url.searchParams.set('filter', typeof body.filter === 'string' && FILTERS.includes(body.filter as NotificationFilter) ? body.filter : 'unread');
  return Response.json({ changed, ...await notificationList(env, access, principal, url) });
}

function unsubscribePage(title: string, message: string, form?: string): Response {
  const escape = (value: string) => value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)} · Gitflare</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,sans-serif;background:#08090b;color:#eceef1}@media (prefers-color-scheme:light){body{background:#f4f4f2;color:#18181b}main{background:#fff!important;border-color:#e4e4e1!important}p{color:#3f3f46!important}}main{max-width:420px;margin:16px;padding:32px;border:1px solid #1f2126;border-radius:18px;background:#101114}h1{margin:0 0 12px;font-size:22px}p{margin:0 0 20px;line-height:1.5;color:#c3c7cf}button{font:inherit;font-weight:600;padding:10px 20px;border-radius:999px;border:0;background:#f6821f;color:#0b0c0e;cursor:pointer}</style></head><body><main><h1>${escape(title)}</h1><p>${escape(message)}</p>${form ?? ''}</main></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } });
}

export async function unsubscribeApi(request: Request, env: AppEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/public/notifications/unsubscribe') return null;
  const limited = await consume(env, 'PUBLIC_READ_RATE_LIMIT', `ip:${request.headers.get('CF-Connecting-IP') ?? 'local'}`);
  if (limited) return rateLimitedResponse(limited, 'requests');
  const userId = url.searchParams.get('user') ?? '', token = url.searchParams.get('token') ?? '', reason = url.searchParams.get('reason') ?? 'all';
  const valid = /^[A-Za-z0-9-]{1,64}$/.test(userId) && /^[a-f0-9]{48}$/.test(token) && (reason === 'all' || (NOTIFICATION_REASONS as readonly string[]).includes(reason));
  if (request.method === 'GET') {
    if (!valid) return unsubscribePage('Link not valid', 'This unsubscribe link is incomplete. Change email notifications in Account → Notifications.');
    const what = reason === 'all' ? 'all Gitflare notification email' : `${reason.replace('_', ' ')} email`;
    return unsubscribePage('Unsubscribe', `Stop ${what} for this account? In-app notifications stay on.`, `<form method="post" action="${unsubscribeUrl('', userId, token, reason as NotificationReason)}"><button type="submit">Unsubscribe</button></form>`);
  }
  if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST.');
  const changed = valid ? await Promise.resolve().then(() => coordinator(env, notificationStore(userId)).unsubscribeNotifications(userId, token, reason as NotificationReason | 'all')).catch(() => null) : null;
  if (!changed) return unsubscribePage('Link not valid', 'This unsubscribe link is no longer valid. Change email notifications in Account → Notifications.');
  return unsubscribePage('Unsubscribed', reason === 'all' ? 'Gitflare will not send you notification email. Turn it back on in Account → Notifications.' : 'That kind of notification no longer reaches your email. Change it any time in Account → Notifications.');
}
