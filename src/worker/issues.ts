import { ISSUE_HIDE_REASONS, ISSUE_LOCK_REASONS, type Issue, type IssueCloseReason, type IssueComment, type IssueDetail, type IssueHideReason, type IssueLabelDefinition, type IssueList, type IssueLockReason, type IssuePerson, type IssueState, type IssueTemplates, type Repository } from '../shared/types';
import { ApiError, assertMutationOrigin, publicError, readJson, requireIdempotencyKey, requireString } from './domain';
import type { Action, Principal } from './security';

export const ISSUE_LIMIT = 5_000;
export const ISSUE_COMMENT_LIMIT = 500;
export const ISSUE_REQUEST_MAX_BYTES = 131_072;
export const ISSUE_BODY_MAX = 20_000;
export const ISSUE_COMMENT_MAX = 10_000;
export const ISSUE_SYSTEM_AUTHOR = 'gitflare';
export const ISSUE_LABEL_DEFINITIONS_MAX = 100;
export const LABEL_COLOR = /^#[0-9a-f]{6}$/;
export const LABEL_COLORS = ['#d73a4a', '#e99695', '#f9a825', '#fbca04', '#0e8a16', '#1d76db', '#5319e7', '#b60205', '#0075ca', '#6b7280'] as const;
const PAGE_LIMIT = 50;
const identifier = /^[a-zA-Z0-9-]{1,100}$/;
const TEMPLATE_FILE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}\.md$/;
const LABEL_DEFINITIONS_KEY = 'issue-label-definitions';

export interface IssueStore { get<T>(key: string): T | undefined; put<T>(key: string, value: T): void; list<T>(prefix: string): T[] }
export interface IssueActor { userId: string; moderator: boolean }
export interface IssueQuery { state?: IssueState | 'all'; label?: string; q?: string; offset?: number; limit?: number }
export type IssueChange =
  | { action: 'create'; repositoryId: string; title: string; body: string; labels: string[]; assignees: string[]; missionIds: string[]; template?: string; templateLabels?: string[] }
  | { action: 'comment'; number: number; body: string; commentId?: string }
  | { action: 'update'; number: number; title?: string; body?: string; labels?: string[]; assignees?: string[]; missionIds?: string[] }
  | { action: 'close'; number: number; reason: IssueCloseReason }
  | { action: 'reopen'; number: number }
  | { action: 'lock'; number: number; reason: IssueLockReason }
  | { action: 'unlock'; number: number }
  | { action: 'hide'; number: number; commentId: string; reason: IssueHideReason }
  | { action: 'unhide'; number: number; commentId: string };
export type IssueAction = IssueChange['action'];
export const ISSUE_ACTIONS: readonly IssueAction[] = ['create', 'comment', 'update', 'close', 'reopen', 'lock', 'unlock', 'hide', 'unhide'];
export type IssueLabelChange =
  | { action: 'create'; name: string; color: string; description: string }
  | { action: 'update'; name: string; newName?: string; color?: string; description?: string }
  | { action: 'delete'; name: string };

const pad = (value: number) => String(value).padStart(6, '0');
const issueKey = (number: number) => `issue:${pad(number)}`;
const commentPrefix = (number: number) => `issue-comment:${pad(number)}:`;

function text(value: unknown, field: string, max: number, min = 0): string {
  if (value === undefined && min === 0) return '';
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_INPUT', `${field} must be text.`);
  if (value.trim().length < min || value.length > max) throw new ApiError(400, 'INVALID_INPUT', `${field} must contain between ${min} and ${max} characters.`);
  return min ? value.trim() : value;
}

function list(value: unknown, field: string, max: number, item: (entry: unknown) => string): string[] {
  if (!Array.isArray(value) || value.length > max) throw new ApiError(400, 'INVALID_INPUT', `${field} must be a list of at most ${max} entries.`);
  const seen = new Set<string>(), result: string[] = [];
  for (const entry of value) { const normalized = item(entry); if (!seen.has(normalized.toLowerCase())) { seen.add(normalized.toLowerCase()); result.push(normalized); } }
  return result;
}

export function issueLabel(entry: unknown): string {
  if (typeof entry !== 'string') throw new ApiError(400, 'INVALID_LABEL', 'Labels must be text.');
  const label = entry.trim().replace(/\s+/g, ' ');
  if (!label || label.length > 40 || /[\u0000-\u001f\u007f,]/.test(label)) throw new ApiError(400, 'INVALID_LABEL', 'Each label must contain 1 to 40 characters without commas.');
  return label;
}

export function issueLabels(value: unknown): string[] { return list(value, 'Labels', 10, issueLabel); }

function identifiers(value: unknown, field: string, max: number): string[] {
  return list(value, field, max, (entry) => { if (typeof entry !== 'string' || !identifier.test(entry)) throw new ApiError(400, 'INVALID_INPUT', `${field} must contain valid identifiers.`); return entry; });
}

function choice<T extends string>(value: unknown, options: readonly T[], field: string): T {
  if (!(options as readonly unknown[]).includes(value)) throw new ApiError(400, 'INVALID_INPUT', `${field} must be one of: ${options.join(', ')}.`);
  return value as T;
}

export function issueNumber(value: unknown): number {
  const number = typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(number) || (number as number) < 1 || (number as number) > ISSUE_LIMIT) throw new ApiError(400, 'INVALID_ISSUE_NUMBER', 'Provide a valid issue number.');
  return number as number;
}

export function parseIssueChange(action: IssueAction, body: Record<string, unknown>, context: { repositoryId: string; number?: number }): IssueChange {
  if (action === 'create') {
    if (body.template !== undefined && (typeof body.template !== 'string' || !TEMPLATE_FILE.test(body.template))) throw new ApiError(400, 'INVALID_INPUT', 'Template must be a template file name such as bug_report.md.');
    return {
      action, repositoryId: context.repositoryId, title: text(body.title, 'Title', 200, 1), body: text(body.body, 'Description', ISSUE_BODY_MAX),
      labels: body.labels === undefined ? [] : issueLabels(body.labels), assignees: body.assignees === undefined ? [] : identifiers(body.assignees, 'Assignees', 10), missionIds: body.missionIds === undefined ? [] : identifiers(body.missionIds, 'Linked missions', 20),
      ...(body.template === undefined ? {} : { template: body.template as string }),
    };
  }
  const number = issueNumber(context.number);
  if (action === 'comment') return { action, number, body: text(body.body, 'Comment', ISSUE_COMMENT_MAX, 1), ...(body.commentId === undefined ? {} : { commentId: requireString(body.commentId, 'Comment', 100) }) };
  if (action === 'close') {
    const reason = body.reason ?? 'completed';
    if (reason !== 'completed' && reason !== 'not_planned') throw new ApiError(400, 'INVALID_CLOSE_REASON', 'Close as completed or not planned.');
    return { action, number, reason };
  }
  if (action === 'reopen' || action === 'unlock') return { action, number };
  if (action === 'lock') return { action, number, reason: choice(body.reason ?? 'off-topic', ISSUE_LOCK_REASONS, 'Lock reason') };
  if (action === 'hide') return { action, number, commentId: requireString(body.commentId, 'Comment', 100), reason: choice(body.reason ?? 'spam', ISSUE_HIDE_REASONS, 'Hide reason') };
  if (action === 'unhide') return { action, number, commentId: requireString(body.commentId, 'Comment', 100) };
  const change: IssueChange = {
    action, number,
    ...(body.title === undefined ? {} : { title: text(body.title, 'Title', 200, 1) }),
    ...(body.body === undefined ? {} : { body: text(body.body, 'Description', ISSUE_BODY_MAX) }),
    ...(body.labels === undefined ? {} : { labels: issueLabels(body.labels) }),
    ...(body.assignees === undefined ? {} : { assignees: identifiers(body.assignees, 'Assignees', 10) }),
    ...(body.missionIds === undefined ? {} : { missionIds: identifiers(body.missionIds, 'Linked missions', 20) }),
  };
  if (Object.keys(change).length === 2) throw new ApiError(400, 'EMPTY_ISSUE_UPDATE', 'Change the title, description, labels, assignees, or linked missions.');
  return change;
}

export function requiresModeration(change: IssueChange, issue: Issue | undefined, userId: string): boolean {
  if (change.action === 'create') return change.labels.length > 0 || change.assignees.length > 0;
  if (change.action === 'comment') return false;
  if (change.action === 'update') return change.labels !== undefined || change.assignees !== undefined || issue?.authorId !== userId;
  return true;
}

export function issueFingerprint(change: IssueChange, actor: IssueActor): string { return JSON.stringify(['issue', change, actor.userId]); }

function required(store: IssueStore, number: number): Issue {
  const issue = store.get<Issue>(issueKey(number));
  if (!issue) throw new ApiError(404, 'ISSUE_NOT_FOUND', 'This issue could not be found.');
  return issue;
}

function assertMissions(store: IssueStore, ids: string[]): void {
  for (const id of ids) if (!store.get(`mission:${id}`)) throw new ApiError(404, 'MISSION_NOT_FOUND', 'Every linked mission must belong to this repository.');
}

function addComment(store: IssueStore, issue: Issue, authorId: string, body: string, now: string): void {
  const key = `${commentPrefix(issue.number)}${pad(issue.commentCount + 1)}`;
  store.put(key, { key, id: crypto.randomUUID(), authorId, body, createdAt: now });
  issue.commentCount++;
}

function findComment(store: IssueStore, number: number, id: string): IssueComment & { key: string } {
  const comment = store.list<IssueComment & { key: string }>(commentPrefix(number)).find((item) => item.id === id);
  if (!comment) throw new ApiError(404, 'COMMENT_NOT_FOUND', 'This comment could not be found.');
  return comment;
}

export function linkIssueMission(store: IssueStore, number: number, missionId: string, now = new Date().toISOString()): void {
  const issue = required(store, number);
  if (issue.missionIds.includes(missionId)) return;
  if (issue.missionIds.length >= 20) throw new ApiError(409, 'ISSUE_MISSION_LIMIT', 'An issue can link at most 20 missions. Unlink one first.');
  issue.missionIds.push(missionId);
  issue.updatedAt = now;
  store.put(issueKey(number), issue);
}

export function recordIssueOutcome(store: IssueStore, number: number, state: IssueState, body: string, now = new Date().toISOString()): boolean {
  const issue = store.get<Issue>(issueKey(number));
  if (!issue || issue.state === state || (state === 'open' && issue.closedReason !== 'completed')) return false;
  if (state === 'closed') Object.assign(issue, { state, closedReason: 'completed', closedAt: now });
  else { issue.state = 'open'; delete issue.closedReason; delete issue.closedAt; }
  if (issue.commentCount < ISSUE_COMMENT_LIMIT) addComment(store, issue, ISSUE_SYSTEM_AUTHOR, body, now);
  issue.updatedAt = now;
  store.put(issueKey(number), issue);
  return true;
}

function mergedLabels(labels: string[], extra: string[] = []): string[] {
  const seen = new Set<string>();
  return [...labels, ...extra].filter((label) => !seen.has(label.toLowerCase()) && !!seen.add(label.toLowerCase())).slice(0, 10);
}

export function applyIssueChange(store: IssueStore, change: IssueChange, actor: IssueActor, now = new Date().toISOString()): number {
  const issue = change.action === 'create' ? undefined : required(store, change.number);
  if (requiresModeration(change, issue, actor.userId) && !actor.moderator) throw new ApiError(403, 'FORBIDDEN', 'Closing, reopening, locking, hiding, labeling, assigning, and editing other people’s issues require triage access.');
  if (issue?.locked && !actor.moderator) throw new ApiError(409, 'ISSUE_LOCKED', 'This issue is locked. Only people who triage this repository can comment or edit it.');
  if (change.action === 'create') {
    const number = (store.get<number>('issue-count') ?? 0) + 1;
    if (number > ISSUE_LIMIT) throw new ApiError(409, 'ISSUE_LIMIT', `A repository can hold at most ${ISSUE_LIMIT} issues.`);
    assertMissions(store, change.missionIds);
    store.put('issue-count', number);
    store.put(issueKey(number), { repositoryId: change.repositoryId, number, title: change.title, body: change.body, state: 'open', labels: mergedLabels(change.labels, change.templateLabels), assignees: change.assignees, missionIds: change.missionIds, authorId: actor.userId, createdAt: now, updatedAt: now, commentCount: 0 } satisfies Issue);
    return number;
  }
  const current = issue!;
  if (change.action === 'comment') {
    if (change.commentId) {
      const comment = findComment(store, current.number, change.commentId);
      if (comment.authorId !== actor.userId) throw new ApiError(403, 'FORBIDDEN', 'Only the comment author can edit it.');
      if (comment.hidden && !actor.moderator) throw new ApiError(409, 'COMMENT_HIDDEN', 'This comment was hidden by a moderator and cannot be edited.');
      store.put(comment.key, { ...comment, body: change.body, editedAt: now });
    } else {
      if (current.commentCount >= ISSUE_COMMENT_LIMIT) throw new ApiError(409, 'COMMENT_LIMIT', `An issue can hold at most ${ISSUE_COMMENT_LIMIT} comments.`);
      addComment(store, current, actor.userId, change.body, now);
    }
  } else if (change.action === 'close') {
    if (current.state === 'closed') throw new ApiError(409, 'ISSUE_ALREADY_CLOSED', 'This issue is already closed.');
    Object.assign(current, { state: 'closed', closedReason: change.reason, closedAt: now });
  } else if (change.action === 'reopen') {
    if (current.state === 'open') throw new ApiError(409, 'ISSUE_ALREADY_OPEN', 'This issue is already open.');
    current.state = 'open'; delete current.closedReason; delete current.closedAt;
  } else if (change.action === 'lock') {
    if (current.locked) throw new ApiError(409, 'ISSUE_ALREADY_LOCKED', 'This issue is already locked.');
    current.locked = { by: actor.userId, at: now, reason: change.reason };
  } else if (change.action === 'unlock') {
    if (!current.locked) throw new ApiError(409, 'ISSUE_NOT_LOCKED', 'This issue is not locked.');
    delete current.locked;
  } else if (change.action === 'hide' || change.action === 'unhide') {
    const comment = findComment(store, current.number, change.commentId);
    const { hidden: _hidden, ...rest } = comment;
    store.put(comment.key, change.action === 'hide' ? { ...rest, hidden: { by: actor.userId, at: now, reason: change.reason } } : rest);
  } else {
    if (change.missionIds) assertMissions(store, change.missionIds.filter((id) => !current.missionIds.includes(id)));
    const { action: _action, number: _number, ...fields } = change;
    Object.assign(current, fields);
  }
  current.updatedAt = now;
  store.put(issueKey(current.number), current);
  return current.number;
}

export function readIssue(store: IssueStore, number: number): IssueDetail | undefined {
  const issue = store.get<Issue>(issueKey(number));
  if (!issue) return undefined;
  return { ...issue, comments: store.list<IssueComment & { key?: string }>(commentPrefix(number)).map(({ key: _key, ...comment }) => comment) };
}

export function listLabelDefinitions(store: IssueStore): IssueLabelDefinition[] { return store.get<IssueLabelDefinition[]>(LABEL_DEFINITIONS_KEY) ?? []; }

export function listIssues(store: IssueStore, query: IssueQuery = {}): IssueList {
  const all = store.list<Issue>('issue:').reverse();
  const term = query.q?.trim().toLowerCase();
  const label = query.label?.trim().toLowerCase();
  const matching = all.filter((issue) => (!label || issue.labels.some((item) => item.toLowerCase() === label)) && (!term || issue.title.toLowerCase().includes(term) || issue.body.toLowerCase().includes(term) || `#${issue.number}` === term || String(issue.number) === term));
  const state = query.state ?? 'open';
  const filtered = state === 'all' ? matching : matching.filter((issue) => issue.state === state);
  const offset = query.offset ?? 0, limit = Math.min(query.limit ?? PAGE_LIMIT, PAGE_LIMIT);
  const items = filtered.slice(offset, offset + limit);
  const definitions = listLabelDefinitions(store);
  const labels = [...new Map([...definitions.map((item) => item.name), ...all.flatMap((issue) => issue.labels)].map((item) => [item.toLowerCase(), item])).values()].sort((a, b) => a.localeCompare(b));
  return { items, total: filtered.length, openCount: matching.filter((issue) => issue.state === 'open').length, closedCount: matching.filter((issue) => issue.state === 'closed').length, labels, labelDefinitions: definitions, offset, nextOffset: offset + items.length < filtered.length ? offset + items.length : null };
}

function labelColor(value: unknown, name: string): string {
  if (value === undefined) return LABEL_COLORS[[...name.toLowerCase()].reduce((sum, char) => sum + char.charCodeAt(0), 0) % LABEL_COLORS.length]!;
  if (typeof value !== 'string' || !LABEL_COLOR.test(value.toLowerCase())) throw new ApiError(400, 'INVALID_LABEL_COLOR', 'Label colours are six-digit hex values such as #1d76db.');
  return value.toLowerCase();
}

export function parseLabelChange(body: Record<string, unknown>): IssueLabelChange {
  const name = issueLabel(body.name);
  const description = (value: unknown) => text(value, 'Label description', 100).trim();
  if (body.action === 'create') return { action: 'create', name, color: labelColor(body.color, name), description: description(body.description) };
  if (body.action === 'delete') return { action: 'delete', name };
  if (body.action !== 'update') throw new ApiError(400, 'INVALID_INPUT', 'Choose create, update or delete.');
  const change: IssueLabelChange = { action: 'update', name, ...(body.newName === undefined ? {} : { newName: issueLabel(body.newName) }), ...(body.color === undefined ? {} : { color: labelColor(body.color, name) }), ...(body.description === undefined ? {} : { description: description(body.description) }) };
  if (Object.keys(change).length === 2) throw new ApiError(400, 'EMPTY_LABEL_UPDATE', 'Change the name, colour or description.');
  return change;
}

export function applyLabelChange(store: IssueStore, change: IssueLabelChange): IssueLabelDefinition[] {
  const definitions = listLabelDefinitions(store);
  const index = definitions.findIndex((item) => item.name.toLowerCase() === change.name.toLowerCase());
  const relabel = (from: string, to: string | null) => {
    for (const issue of store.list<Issue>('issue:')) {
      if (!issue.labels.some((label) => label.toLowerCase() === from.toLowerCase())) continue;
      issue.labels = mergedLabels(issue.labels.flatMap((label) => label.toLowerCase() !== from.toLowerCase() ? [label] : to === null ? [] : [to]));
      store.put(issueKey(issue.number), issue);
    }
  };
  if (change.action === 'create') {
    if (index >= 0) throw new ApiError(409, 'LABEL_EXISTS', `The label ${definitions[index]!.name} already exists.`);
    if (definitions.length >= ISSUE_LABEL_DEFINITIONS_MAX) throw new ApiError(409, 'LABEL_LIMIT', `A repository can define at most ${ISSUE_LABEL_DEFINITIONS_MAX} labels.`);
    definitions.push({ name: change.name, color: change.color, description: change.description });
  } else {
    if (index < 0) throw new ApiError(404, 'LABEL_NOT_FOUND', 'This label is not defined for this repository.');
    const current = definitions[index]!;
    if (change.action === 'delete') { definitions.splice(index, 1); relabel(current.name, null); }
    else {
      if (change.newName && change.newName.toLowerCase() !== current.name.toLowerCase() && definitions.some((item) => item.name.toLowerCase() === change.newName!.toLowerCase())) throw new ApiError(409, 'LABEL_EXISTS', `The label ${change.newName} already exists.`);
      if (change.newName && change.newName !== current.name) relabel(current.name, change.newName);
      definitions[index] = { name: change.newName ?? current.name, color: change.color ?? current.color, description: change.description ?? current.description };
    }
  }
  definitions.sort((a, b) => a.name.localeCompare(b.name));
  store.put(LABEL_DEFINITIONS_KEY, definitions);
  return definitions;
}

export function issueForViewer(issue: IssueDetail, moderator: boolean, publicView: boolean): IssueDetail {
  const strip = <T extends { by?: string }>(value: T | undefined): T | undefined => value && (moderator ? value : (({ by: _by, ...rest }) => rest as T)(value));
  return {
    ...issue,
    ...(publicView ? { missionIds: [] } : {}),
    ...(issue.locked ? { locked: strip(issue.locked) } : {}),
    comments: issue.comments.map((comment) => comment.hidden && !moderator ? { ...comment, body: '', hidden: strip(comment.hidden)! } : comment),
  };
}

export function issuePeopleIds(issue: Issue | IssueDetail, moderator = true): string[] {
  const ids = [issue.authorId, ...issue.assignees, ...('comments' in issue ? issue.comments.map((comment) => comment.authorId) : [])];
  if (moderator) ids.push(...('comments' in issue ? issue.comments.flatMap((comment) => comment.hidden?.by ? [comment.hidden.by] : []) : []), ...(issue.locked?.by ? [issue.locked.by] : []));
  return [...new Set(ids.filter((id) => id !== ISSUE_SYSTEM_AUTHOR))];
}

export interface IssueAccess {
  authorize(principal: Principal, action: Action, resourceType?: string, resourceId?: string): Promise<void>;
  check(principal: Principal, action: Action, resourceType?: string, resourceId?: string): Promise<void>;
  snapshot(principal: Principal): Promise<{ members: { userId: string }[] }>;
}
export interface IssueCoordinator {
  listIssues(query: IssueQuery): Promise<IssueList>;
  getIssue(number: number): Promise<IssueDetail | undefined>;
  changeIssue(key: string, change: IssueChange, actor: IssueActor): Promise<IssueDetail>;
  issueLabels(): Promise<IssueLabelDefinition[]>;
  changeIssueLabels(key: string, change: IssueLabelChange): Promise<IssueLabelDefinition[]>;
}
export interface IssueServices {
  people(ids: string[]): Promise<Record<string, IssuePerson>>;
  templates(): Promise<IssueTemplates>;
  beforeWrite?(change: IssueChange, body: Record<string, unknown>): Promise<void>;
  afterWrite?(change: IssueChange, issue: IssueDetail, actorId: string): Promise<void>;
  report?(number: number, body: Record<string, unknown>): Promise<Response>;
}
export interface IssueTarget { principal: Principal; repositoryId: string; publicView: boolean }

const ROUTE = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/(issues|issue-labels|issue-templates)(?:\/(\d{1,6})(?:\/([a-z]+))?)?$/;

export async function allowed(access: IssueAccess, principal: Principal, action: Action, repositoryId: string): Promise<boolean> {
  try { await access.check(principal, action, 'repository', repositoryId); return true; }
  catch (error) { if (publicError(error).code === 'FORBIDDEN') return false; throw error; }
}

async function withPeople<T extends object>(value: T, ids: string[], services: IssueServices): Promise<T & { people: Record<string, IssuePerson> }> {
  return { ...value, people: await services.people(ids) };
}

export async function issueRoute(request: Request, url: URL, target: IssueTarget, resource: 'issues' | 'issue-labels' | 'issue-templates', numberText: string | undefined, operation: string | undefined, access: IssueAccess, coordinator: IssueCoordinator, services: IssueServices): Promise<Response> {
  const { principal, repositoryId, publicView } = target;
  const read = () => publicView ? access.check(principal, 'read', 'repository', repositoryId) : access.authorize(principal, 'read', 'repository', repositoryId);
  if (resource === 'issue-templates') {
    if (request.method !== 'GET' || numberText) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Issue templates are read-only.');
    await read();
    return Response.json(await services.templates());
  }
  if (resource === 'issue-labels') {
    if (numberText) throw new ApiError(404, 'NOT_FOUND', 'This API route could not be found.');
    if (request.method === 'GET') { await read(); return Response.json({ labels: await coordinator.issueLabels() }); }
    if (request.method !== 'POST' || publicView) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use a supported label operation.');
    assertMutationOrigin(request);
    const key = requireIdempotencyKey(request);
    const change = parseLabelChange(await readJson(request));
    await access.authorize(principal, 'triage', 'repository', repositoryId);
    return Response.json({ labels: await coordinator.changeIssueLabels(key, change) });
  }
  if (request.method === 'GET' && !operation) {
    await read();
    const moderator = !publicView && await allowed(access, principal, 'triage', repositoryId);
    if (numberText) {
      const issue = await coordinator.getIssue(issueNumber(numberText));
      if (!issue) throw new ApiError(404, 'ISSUE_NOT_FOUND', 'This issue could not be found.');
      const shaped = issueForViewer(issue, moderator, publicView);
      return Response.json(await withPeople(shaped, issuePeopleIds(shaped, moderator), services));
    }
    const state = url.searchParams.get('state') ?? 'open';
    if (!['open', 'closed', 'all'].includes(state)) throw new ApiError(400, 'INVALID_INPUT', 'Filter by open, closed, or all issues.');
    const offset = Number(url.searchParams.get('offset') ?? 0);
    if (!Number.isInteger(offset) || offset < 0) throw new ApiError(400, 'INVALID_INPUT', 'Offset must be a non-negative integer.');
    const page = await coordinator.listIssues({ state: state as IssueQuery['state'], label: url.searchParams.get('label')?.slice(0, 40) || undefined, q: url.searchParams.get('q')?.slice(0, 200) || undefined, offset });
    const items = page.items.map((issue) => ({ ...issue, ...(publicView ? { missionIds: [] } : {}), ...(issue.locked && !moderator ? { locked: { reason: issue.locked.reason, at: issue.locked.at } } : {}) }));
    return Response.json(await withPeople({ ...page, items }, [...new Set(items.flatMap((issue) => issuePeopleIds(issue, false)))], services));
  }
  if (request.method !== 'POST' || !numberText && !!operation || !!numberText && !operation) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use a supported issue operation.');
  assertMutationOrigin(request);
  if (operation === 'report') {
    if (!services.report) throw new ApiError(404, 'NOT_FOUND', 'Reports are sent from a repository’s public page.');
    return services.report(issueNumber(numberText), await readJson(request, 8_192));
  }
  const action = (operation ?? 'create') as IssueAction;
  if (!ISSUE_ACTIONS.includes(action) || action === 'create' && numberText) throw new ApiError(404, 'NOT_FOUND', 'This API route could not be found.');
  const key = requireIdempotencyKey(request);
  const body = await readJson(request, ISSUE_REQUEST_MAX_BYTES);
  const change = parseIssueChange(action, body, { repositoryId, number: numberText ? Number(numberText) : undefined });
  const issue = change.action === 'create' ? undefined : await coordinator.getIssue(change.number);
  if (change.action !== 'create' && !issue) throw new ApiError(404, 'ISSUE_NOT_FOUND', 'This issue could not be found.');
  const needsTriage = requiresModeration(change, issue, principal.userId);
  if (change.action === 'create') {
    await access.authorize(principal, 'participate', 'repository', repositoryId);
    if (needsTriage) await access.authorize(principal, 'triage', 'repository', repositoryId);
  } else await access.authorize(principal, needsTriage ? 'triage' : 'participate', 'repository', repositoryId);
  const moderator = needsTriage || await allowed(access, principal, 'triage', repositoryId);
  const added = 'assignees' in change && change.assignees ? change.assignees.filter((id) => !issue?.assignees.includes(id)) : [];
  if (added.length) {
    const members = new Set([principal.userId, ...await access.snapshot(principal).then((snapshot) => snapshot.members.map((member) => member.userId), () => [])]);
    if (added.some((id) => !members.has(id))) throw new ApiError(400, 'UNKNOWN_ASSIGNEE', 'Assign issues only to members of this workspace.');
  }
  if (change.action === 'create' && change.template) {
    const template = (await services.templates()).templates.find((item) => item.file === change.template);
    if (!template) throw new ApiError(404, 'TEMPLATE_NOT_FOUND', 'This issue template is not on the default branch.');
    change.templateLabels = template.labels;
  }
  await services.beforeWrite?.(change, body);
  const changed = await coordinator.changeIssue(key, change, { userId: principal.userId, moderator });
  await services.afterWrite?.(change, changed, principal.userId).catch(() => {});
  const result = issueForViewer(changed, moderator, publicView);
  return Response.json(await withPeople(result, issuePeopleIds(result, moderator), services), { status: change.action === 'create' ? 201 : 200 });
}

export async function handleIssues(request: Request, url: URL, principal: Principal, access: IssueAccess, catalog: { getRepository(id: string): Promise<Repository | undefined> }, coordinatorFor: (repositoryId: string) => IssueCoordinator, services: (repository: Repository) => IssueServices): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname);
  if (!match) return null;
  const [, repositoryId, resource, numberText, operation] = match;
  const repository = await catalog.getRepository(repositoryId!);
  if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
  return issueRoute(request, url, { principal, repositoryId: repositoryId!, publicView: false }, resource as 'issues', numberText, operation, access, coordinatorFor(repositoryId!), services(repository));
}
