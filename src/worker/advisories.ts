import { ADVISORY_CLOSE_REASONS, ADVISORY_SEVERITIES, type Advisory, type AdvisoryAffected, type AdvisoryCloseReason, type AdvisoryDetail, type AdvisoryFields, type AdvisoryList, type AdvisoryReference, type AdvisoryState, type AdvisorySummary, type AdvisoryViewer, type IssuePerson, type PublicAdvisory, type PublicAdvisoryResponse, type PublicSecurity, type Release, type Repository } from '../shared/types';
import { HANDLE_PATTERN } from '../shared/handles';
import { ApiError, assertMutationOrigin, publicError, readJson, requireIdempotencyKey } from './domain';
import type { AppEnv } from './env';
import { PUBLIC_NOT_FOUND, resolvePublicRepository } from './public-repositories';
import { clientIp, consume, rateLimitedResponse, rateLimitMessage } from './rate-limits';
import { publicPrincipal, securityClient, type Principal, type SecurityService } from './security';
import { repositorySecurityPolicy } from './security-policy';
import { turnstileSiteKey, verifyTurnstile } from './turnstile';

export const ADVISORY_LIMIT = 500;
export const ADVISORY_OPEN_REPORTS_MAX = 200;
export const ADVISORY_REPORTS_PER_DAY = 5;
export const ADVISORY_COMMENTS_MAX = 200;
export const ADVISORY_COLLABORATORS_MAX = 20;
export const ADVISORY_DESCRIPTION_MAX = 20_000;
export const ADVISORY_COMMENT_MAX = 8000;
export const ADVISORY_REQUEST_MAX_BYTES = 65_536;
const ID_ALPHABET = '23456789cfghjmpqrvwx';
const ADVISORY_ID = /^GFSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/;
const CVSS = /^CVSS:(?:3\.[01]|4\.0)(?:\/[A-Za-z]{1,3}:[A-Za-z])+$/;
const CVE = /^CVE-\d{4}-\d{4,7}$/;
const CWE = /^CWE-\d{1,5}$/;
const REPORTER_FIELDS = new Set(['title', 'description', 'severity', 'affected', 'turnstileToken']);

export interface AdvisoryStore { get<T>(key: string): T | undefined; put<T>(key: string, value: T): void; list<T>(prefix: string): T[] }
export type AdvisoryChange =
  | { action: 'create'; repositoryId: string; source: 'report' | 'maintainer'; fields: Partial<AdvisoryFields>; actorId: string }
  | { action: 'update'; id: string; fields: Partial<AdvisoryFields>; actorId: string }
  | { action: 'publish'; id: string; actorId: string }
  | { action: 'close'; id: string; reason: AdvisoryCloseReason; actorId: string }
  | { action: 'reopen'; id: string; actorId: string }
  | { action: 'comment'; id: string; body: string; actorId: string; maintainer: boolean }
  | { action: 'collaborator'; id: string; operation: 'add' | 'remove'; userId: string; actorId: string };
export interface AdvisoryRecords {
  listAdvisories(): Advisory[] | Promise<Advisory[]>;
  getAdvisory(id: string): Advisory | undefined | Promise<Advisory | undefined>;
  changeAdvisory(key: string, change: AdvisoryChange): Advisory | Promise<Advisory>;
  getRelease?(id: string): Release | undefined | Promise<Release | undefined>;
  listReleases(): Release[] | Promise<Release[]>;
}

const invalid = (message: string): never => { throw new ApiError(400, 'INVALID_ADVISORY', message); };
const clean = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();

function text(value: unknown, field: string, max: number, min = 0, singleLine = true): string {
  if (typeof value !== 'string') return invalid(`${field} must be text.`);
  const result = clean(singleLine ? value.replace(/\s+/g, ' ') : value);
  if (result.length < min || result.length > max) invalid(min ? `${field} must contain between ${min} and ${max} characters.` : `${field} must be at most ${max} characters.`);
  return result;
}

function list<T>(value: unknown, field: string, max: number, item: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) return invalid(`${field} takes at most ${max} entries.`);
  return value.map(item);
}

function httpsUrl(value: unknown): string {
  const raw = text(value, 'References', 500, 1);
  try { const url = new URL(raw); if (url.protocol === 'https:' && !url.username && !url.password) return url.toString(); } catch {}
  return invalid('References must be https:// links.');
}

function affected(value: unknown): AdvisoryAffected {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Each affected package needs ecosystem, package, vulnerableVersions and patchedVersions.');
  const entry = value as Record<string, unknown>;
  return { ecosystem: text(entry.ecosystem ?? '', 'Ecosystem', 40), package: text(entry.package, 'Package', 200, 1), vulnerableVersions: text(entry.vulnerableVersions ?? '', 'Vulnerable versions', 200), patchedVersions: text(entry.patchedVersions ?? '', 'Patched versions', 200) };
}

export function advisoryFields(body: Record<string, unknown>, reporter = false): Partial<AdvisoryFields> {
  if (reporter) { const extra = Object.keys(body).find(key => !REPORTER_FIELDS.has(key)); if (extra) throw new ApiError(403, 'FORBIDDEN', `Only maintainers can set ${extra}.`); }
  const fields: Partial<AdvisoryFields> = {};
  if (body.title !== undefined) fields.title = text(body.title, 'Title', 200, 1);
  if (body.description !== undefined) fields.description = text(body.description, 'Description', ADVISORY_DESCRIPTION_MAX, 0, false);
  if (body.severity !== undefined) { if (body.severity !== null && !(ADVISORY_SEVERITIES as readonly unknown[]).includes(body.severity)) invalid(`Severity is one of ${ADVISORY_SEVERITIES.join(', ')}.`); fields.severity = body.severity as AdvisoryFields['severity']; }
  if (body.cvssVector !== undefined) { const value = body.cvssVector === null || body.cvssVector === '' ? null : text(body.cvssVector, 'CVSS vector', 200); if (value !== null && !CVSS.test(value)) invalid('The CVSS vector looks like CVSS:3.1/AV:N/AC:L/… or CVSS:4.0/….'); fields.cvssVector = value; }
  if (body.cveId !== undefined) { const value = body.cveId === null || body.cveId === '' ? null : text(body.cveId, 'CVE ID', 20).toUpperCase(); if (value !== null && !CVE.test(value)) invalid('CVE IDs look like CVE-2026-12345.'); fields.cveId = value; }
  if (body.cweIds !== undefined) fields.cweIds = [...new Set(list(body.cweIds, 'CWE IDs', 10, entry => { const value = text(entry, 'CWE ID', 12).toUpperCase(); if (!CWE.test(value)) invalid('CWE IDs look like CWE-79.'); return value; }))];
  if (body.affected !== undefined) fields.affected = list(body.affected, 'Affected packages', 10, affected);
  if (body.references !== undefined) fields.references = [...new Set(list(body.references, 'References', 10, httpsUrl))];
  if (body.credits !== undefined) fields.credits = list(body.credits, 'Credits', 10, entry => text(entry, 'Credit', 100, 1));
  if (body.releaseId !== undefined) { if (body.releaseId !== null && body.releaseId !== '' && (typeof body.releaseId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(body.releaseId))) invalid('releaseId must be a release ID or null.'); fields.releaseId = typeof body.releaseId === 'string' && body.releaseId ? body.releaseId : null; }
  return fields;
}

export function advisoryId(random: (count: number) => number[] = count => [...crypto.getRandomValues(new Uint8Array(count))]): string {
  const bytes = random(12);
  const chars = [...bytes].map(byte => ID_ALPHABET[byte % ID_ALPHABET.length]).join('');
  return `GFSA-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export function isAdvisoryId(value: string): boolean { return ADVISORY_ID.test(value); }

const key = (id: string) => `advisory:${id}`;
export function listAdvisories(store: Pick<AdvisoryStore, 'list'>): Advisory[] { return store.list<Advisory>('advisory:').sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
export function advisoryFingerprint(change: AdvisoryChange): string { return JSON.stringify(['advisory', change]); }

function required(store: AdvisoryStore, id: string): Advisory {
  const advisory = store.get<Advisory>(key(id));
  if (!advisory) throw new ApiError(404, 'ADVISORY_NOT_FOUND', 'This advisory could not be found.');
  return advisory;
}

function draft(advisory: Advisory): Advisory {
  if (advisory.state !== 'draft') throw new ApiError(409, 'ADVISORY_NOT_DRAFT', advisory.state === 'published' ? 'This advisory is published.' : 'This advisory is closed. Reopen it first.');
  return advisory;
}

function assertRelease(store: AdvisoryStore, fields: Partial<AdvisoryFields>): void {
  if (fields.releaseId && !store.get<Release>(`release:${fields.releaseId}`)) throw new ApiError(404, 'RELEASE_NOT_FOUND', 'The linked release could not be found.');
}

export function applyAdvisoryChange(store: AdvisoryStore, change: AdvisoryChange, now = new Date().toISOString(), newId = advisoryId): Advisory {
  if (change.action === 'create') {
    const all = listAdvisories(store);
    if (all.length >= ADVISORY_LIMIT) throw new ApiError(409, 'ADVISORY_LIMIT', `A repository can hold at most ${ADVISORY_LIMIT} advisories.`);
    if (!change.fields.title || change.fields.description === undefined || !change.fields.description.trim()) invalid('Give the advisory a title and a description.');
    assertRelease(store, change.fields);
    if (change.source === 'report') {
      if (all.filter(item => item.source === 'report' && item.state === 'draft').length >= ADVISORY_OPEN_REPORTS_MAX) throw new ApiError(409, 'REPORTS_FULL', 'This repository has too many open vulnerability reports. Contact the maintainers another way.');
      const counter = `advisory-reports:${change.actorId}:${now.slice(0, 10)}`;
      const count = store.get<number>(counter) ?? 0;
      if (count >= ADVISORY_REPORTS_PER_DAY) throw new ApiError(429, 'REPORT_LIMIT', `You can send ${ADVISORY_REPORTS_PER_DAY} vulnerability reports to one repository a day.`);
      store.put(counter, count + 1);
    }
    let id = newId();
    while (store.get(key(id))) id = newId();
    const advisory: Advisory = {
      id, repositoryId: change.repositoryId, state: 'draft', source: change.source,
      title: change.fields.title!, description: change.fields.description!, severity: change.fields.severity ?? null, cvssVector: change.fields.cvssVector ?? null, cveId: change.fields.cveId ?? null,
      cweIds: change.fields.cweIds ?? [], affected: change.fields.affected ?? [], references: change.fields.references ?? [], credits: change.fields.credits ?? [], releaseId: change.fields.releaseId ?? null,
      reporterId: change.source === 'report' ? change.actorId : null, collaborators: [], comments: [], createdBy: change.actorId, createdAt: now, updatedAt: now, publishedAt: null, closedAt: null, closeReason: null,
      ...(change.source === 'maintainer' ? { acknowledgedAt: now } : {}),
    };
    store.put(key(id), advisory);
    return advisory;
  }
  const current = required(store, change.id);
  const acknowledged = change.action !== 'comment' || change.maintainer ? { acknowledgedAt: current.acknowledgedAt ?? now } : {};
  let next: Advisory;
  if (change.action === 'update') {
    if (current.state === 'closed') draft(current);
    assertRelease(store, change.fields);
    if (current.state === 'published' && (change.fields.title === '' || change.fields.description === '' || change.fields.severity === null)) invalid('A published advisory keeps a title, description and severity.');
    next = { ...current, ...change.fields };
  } else if (change.action === 'publish') {
    draft(current);
    if (!current.title || !current.description.trim() || !current.severity) invalid('Set a title, a description and a severity before publishing.');
    next = { ...current, state: 'published', publishedAt: now };
  } else if (change.action === 'close') {
    draft(current);
    next = { ...current, state: 'closed', closedAt: now, closeReason: change.reason };
  } else if (change.action === 'reopen') {
    if (current.state !== 'closed') throw new ApiError(409, 'ADVISORY_NOT_CLOSED', 'Only closed advisories can be reopened.');
    next = { ...current, state: 'draft', closedAt: null, closeReason: null };
  } else if (change.action === 'comment') {
    draft(current);
    if (current.comments.length >= ADVISORY_COMMENTS_MAX) throw new ApiError(409, 'COMMENT_LIMIT', `An advisory discussion holds at most ${ADVISORY_COMMENTS_MAX} comments.`);
    next = { ...current, comments: [...current.comments, { id: crypto.randomUUID(), authorId: change.actorId, body: change.body, createdAt: now }] };
  } else {
    if (current.state === 'closed') draft(current);
    if (change.operation === 'add') {
      if (change.userId === current.reporterId || current.collaborators.includes(change.userId)) return current;
      if (current.collaborators.length >= ADVISORY_COLLABORATORS_MAX) throw new ApiError(409, 'COLLABORATOR_LIMIT', `An advisory can have at most ${ADVISORY_COLLABORATORS_MAX} invited people.`);
      next = { ...current, collaborators: [...current.collaborators, change.userId] };
    } else next = { ...current, collaborators: current.collaborators.filter(id => id !== change.userId) };
  }
  const saved = { ...next, ...acknowledged, updatedAt: now };
  store.put(key(current.id), saved);
  return saved;
}

export function advisorySummary(advisory: Advisory): AdvisorySummary {
  return { id: advisory.id, title: advisory.title, state: advisory.state, source: advisory.source, severity: advisory.severity, cveId: advisory.cveId, commentCount: advisory.comments.length, createdAt: advisory.createdAt, updatedAt: advisory.updatedAt, publishedAt: advisory.publishedAt };
}

export function advisoryReference(advisory: Advisory): AdvisoryReference { return { id: advisory.id, title: advisory.title, severity: advisory.severity, cveId: advisory.cveId }; }

export function publicAdvisory(advisory: Advisory, release: Release | undefined): PublicAdvisory {
  return { id: advisory.id, title: advisory.title, description: advisory.description, severity: advisory.severity, cvssVector: advisory.cvssVector, cveId: advisory.cveId, cweIds: advisory.cweIds, affected: advisory.affected, references: advisory.references, credits: advisory.credits, publishedAt: advisory.publishedAt!, updatedAt: advisory.updatedAt, release: release && !release.draft ? { tag: release.tag, name: release.name } : null };
}

export function releaseAdvisories(advisories: Advisory[], releaseId: string): AdvisoryReference[] {
  return advisories.filter(advisory => advisory.state === 'published' && advisory.releaseId === releaseId).map(advisoryReference);
}

export function participantOf(advisory: Advisory, principal: Principal): { reporter: boolean; collaborator: boolean } {
  if (principal.credentialId || principal.kind === 'public') return { reporter: false, collaborator: false };
  return { reporter: !!advisory.reporterId && advisory.reporterId === principal.userId, collaborator: advisory.collaborators.includes(principal.userId) };
}

export function canSee(advisory: Advisory, principal: Principal, maintainer: boolean, readsPublished: boolean): boolean {
  if (advisory.state === 'published') return readsPublished;
  if (maintainer) return true;
  const { reporter, collaborator } = participantOf(advisory, principal);
  return reporter || collaborator;
}

interface Detailed { access: Pick<SecurityService, 'profiles'>; records: AdvisoryRecords }

async function detail({ access, records }: Detailed, advisory: Advisory, viewer: AdvisoryViewer): Promise<AdvisoryDetail> {
  const ids = [...new Set([advisory.createdBy, ...(advisory.reporterId ? [advisory.reporterId] : []), ...advisory.collaborators, ...advisory.comments.map(comment => comment.authorId)])];
  const [people, release] = await Promise.all([access.profiles(ids).catch(() => ({} as Record<string, IssuePerson>)), advisory.releaseId ? (await records.listReleases()).find(item => item.id === advisory.releaseId) : undefined]);
  return { ...advisory, people, release: release ? { id: release.id, tag: release.tag, name: release.name } : null, viewer };
}

function viewerOf(advisory: Advisory, principal: Principal, maintainer: boolean): AdvisoryViewer {
  const { reporter, collaborator } = participantOf(advisory, principal);
  return { maintainer, reporter, collaborator, canComment: advisory.state === 'draft' && (maintainer || reporter || collaborator) };
}

function counts(items: Advisory[]): Record<AdvisoryState, number> {
  return { draft: items.filter(item => item.state === 'draft').length, published: items.filter(item => item.state === 'published').length, closed: items.filter(item => item.state === 'closed').length };
}

async function collaboratorId(access: Pick<SecurityService, 'userIdsByHandles'>, body: Record<string, unknown>): Promise<string> {
  if (typeof body.userId === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(body.userId)) return body.userId;
  const handle = typeof body.handle === 'string' ? body.handle.replace(/^@/, '').toLowerCase() : '';
  if (!HANDLE_PATTERN.test(handle)) throw new ApiError(400, 'INVALID_INPUT', 'Pass the person’s handle.');
  const id = (await access.userIdsByHandles([handle]))[handle];
  if (!id) throw new ApiError(404, 'USER_NOT_FOUND', `No account has the handle @${handle}.`);
  return id;
}

export interface MemberAdvisoryContext { repository: Repository; principal: Principal; access: SecurityService; records: AdvisoryRecords }

export async function isMaintainer(access: Pick<SecurityService, 'check'>, principal: Principal, repositoryId: string): Promise<boolean> {
  if (principal.kind || principal.credentialId) return false;
  return access.check(principal, 'land', 'repository', repositoryId).then(() => true, () => false);
}

export async function advisoriesApi(request: Request, context: MemberAdvisoryContext, advisoryIdValue?: string, operation?: string): Promise<Response> {
  const { repository, principal, access, records } = context;
  await access.authorize(principal, 'read', 'repository', repository.id);
  const maintainer = await isMaintainer(access, principal, repository.id);
  const notFound = () => new ApiError(404, 'ADVISORY_NOT_FOUND', 'This advisory could not be found.');
  if (request.method === 'GET' || request.method === 'HEAD') {
    if (operation) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use POST for advisory changes.');
    const all = await records.listAdvisories();
    if (!advisoryIdValue) {
      const visible = all.filter(item => canSee(item, principal, maintainer, true));
      return Response.json({ items: visible.map(advisorySummary), maintainer, counts: counts(visible) } satisfies AdvisoryList);
    }
    const advisory = all.find(item => item.id === advisoryIdValue);
    if (!advisory || !canSee(advisory, principal, maintainer, true)) throw notFound();
    return Response.json(await detail(context, advisory, viewerOf(advisory, principal, maintainer)));
  }
  if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET to read advisories and POST to change them.');
  assertMutationOrigin(request);
  const body = await readJson(request, ADVISORY_REQUEST_MAX_BYTES);
  const key = requireIdempotencyKey(request);
  if (!advisoryIdValue) {
    if (!maintainer) throw new ApiError(403, 'FORBIDDEN', 'Only maintainers can draft security advisories.');
    const created = await records.changeAdvisory(key, { action: 'create', repositoryId: repository.id, source: 'maintainer', fields: advisoryFields(body), actorId: principal.userId });
    return Response.json(await detail(context, created, viewerOf(created, principal, true)), { status: 201 });
  }
  const advisory = await records.getAdvisory(advisoryIdValue);
  if (!advisory || !canSee(advisory, principal, maintainer, true)) throw notFound();
  if (operation === 'comment') {
    const viewer = viewerOf(advisory, principal, maintainer);
    if (!viewer.canComment) throw new ApiError(advisory.state === 'draft' ? 403 : 409, advisory.state === 'draft' ? 'FORBIDDEN' : 'ADVISORY_NOT_DRAFT', advisory.state === 'draft' ? 'You cannot comment on this advisory.' : 'Only draft advisories have an open discussion.');
    const changed = await records.changeAdvisory(key, { action: 'comment', id: advisory.id, body: text(body.body, 'Comment', ADVISORY_COMMENT_MAX, 1, false), actorId: principal.userId, maintainer });
    return Response.json(await detail(context, changed, viewerOf(changed, principal, maintainer)));
  }
  if (!maintainer) throw new ApiError(403, 'FORBIDDEN', 'Only maintainers can change security advisories.');
  let change: AdvisoryChange;
  if (operation === 'update') change = { action: 'update', id: advisory.id, fields: advisoryFields(body), actorId: principal.userId };
  else if (operation === 'publish') change = { action: 'publish', id: advisory.id, actorId: principal.userId };
  else if (operation === 'close') {
    if (!(ADVISORY_CLOSE_REASONS as readonly unknown[]).includes(body.reason)) throw new ApiError(400, 'INVALID_INPUT', `Close with a reason: ${ADVISORY_CLOSE_REASONS.join(', ')}.`);
    change = { action: 'close', id: advisory.id, reason: body.reason as AdvisoryCloseReason, actorId: principal.userId };
  } else if (operation === 'reopen') change = { action: 'reopen', id: advisory.id, actorId: principal.userId };
  else if (operation === 'collaborators') {
    if (body.action !== 'add' && body.action !== 'remove') throw new ApiError(400, 'INVALID_INPUT', 'Choose add or remove.');
    change = { action: 'collaborator', id: advisory.id, operation: body.action, userId: await collaboratorId(access, body), actorId: principal.userId };
  } else throw new ApiError(404, 'NOT_FOUND', 'This API route could not be found.');
  const changed = await records.changeAdvisory(key, change);
  if (operation === 'publish') await access.auditRepositoryChange(principal, 'advisory.published', advisory.id).catch(() => undefined);
  return Response.json(await detail(context, changed, viewerOf(changed, principal, true)));
}

const PUBLIC_ROUTE = /^\/api\/public\/repos\/([^/]+)\/([^/]+)\/(security|advisories)(?:\/([A-Za-z0-9-]{1,40})(?:\/(comment))?)?$/;

export async function publicAdvisoriesApi(request: Request, env: AppEnv, signedIn: (request: Request) => Promise<Principal | null>): Promise<Response | null> {
  const url = new URL(request.url);
  const match = PUBLIC_ROUTE.exec(url.pathname);
  if (!match) return null;
  const notFound = (): never => { throw new ApiError(404, 'NOT_FOUND', PUBLIC_NOT_FOUND); };
  const client = clientIp(request);
  const read = request.method === 'GET' || request.method === 'HEAD';
  if (read) { const limited = await consume(env, 'PUBLIC_READ_RATE_LIMIT', `ip:${client}`); if (limited) return rateLimitedResponse(limited, 'public repository requests'); }
  let handle: string; let name: string;
  try { handle = decodeURIComponent(match[1]!).toLowerCase(); name = decodeURIComponent(match[2]!); } catch { notFound(); }
  const [, , , resource, id, operation] = match;
  if (resource === 'security' && (id || !read)) notFound();
  const access = securityClient(env);
  const target = await resolvePublicRepository(env, access, handle!, name!);
  if (!target) notFound();
  if ('redirect' in target!) return new Response(null, { status: 308, headers: { Location: `/api/public/repos/${target.redirect}/${encodeURIComponent(name!)}/${url.pathname.split('/').slice(6).join('/')}${url.search}` } });
  const { repository, workspaceId } = target!;
  const home = await signedIn(request);
  if (!home && !read) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to report a vulnerability.');
  let principal: Principal;
  try { principal = home ? await access.participant(home, workspaceId) : publicPrincipal(workspaceId); }
  catch (error) { if (!read || publicError(error).code !== 'ACCOUNT_REQUIRED') throw error; principal = publicPrincipal(workspaceId); }
  if (!await access.check(principal, 'read', 'repository', repository.id).then(() => true, () => false)) notFound();
  const records = env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`) as unknown as AdvisoryRecords;
  const maintainer = await isMaintainer(access, principal, repository.id);
  const context = { access, records };
  const releaseOf = async (advisory: Advisory) => advisory.releaseId ? (await records.listReleases()).find(item => item.id === advisory.releaseId) : undefined;
  const signedInAccount = principal.kind !== 'public' && !principal.credentialId;
  if (resource === 'security') {
    const [policy, all, canParticipate, standing] = await Promise.all([
      repositorySecurityPolicy(env, repository), records.listAdvisories(),
      signedInAccount ? access.check(principal, 'participate', 'repository', repository.id).then(() => true, () => false) : Promise.resolve(false),
      principal.kind === 'community' ? access.standing(principal.userId) : Promise.resolve({ limited: false, until: null }),
    ]);
    const releases = await records.listReleases();
    const advisories = all.filter(item => item.state === 'published').sort((a, b) => b.publishedAt!.localeCompare(a.publishedAt!)).map(item => publicAdvisory(item, releases.find(release => release.id === item.releaseId)));
    const reports = signedInAccount ? all.filter(item => item.state !== 'published' && (item.reporterId === principal.userId || item.collaborators.includes(principal.userId))).map(advisorySummary) : [];
    const reporting = !!policy;
    return Response.json({ policy, reporting, signedIn: principal.kind !== 'public', canReport: reporting && canParticipate, limited: standing.limited, turnstileSiteKey: standing.limited ? turnstileSiteKey(env) : null, advisories, reports } satisfies PublicSecurity);
  }
  if (!id && read) notFound();
  if (id) {
    const advisory = isAdvisoryId(id) ? await records.getAdvisory(id) : undefined;
    if (!advisory) notFound();
    const viewer = viewerOf(advisory!, principal, maintainer);
    const participant = viewer.reporter || viewer.collaborator || maintainer;
    if (advisory!.state !== 'published' && !participant) notFound();
    if (read) {
      if (operation) notFound();
      return Response.json((advisory!.state === 'published' ? { published: publicAdvisory(advisory!, await releaseOf(advisory!)), report: null } : { published: null, report: await detail(context, advisory!, viewer) }) satisfies PublicAdvisoryResponse);
    }
    if (operation !== 'comment') notFound();
    assertMutationOrigin(request);
    const body = await readJson(request, ADVISORY_REQUEST_MAX_BYTES);
    const key = requireIdempotencyKey(request);
    if (!viewer.canComment) throw new ApiError(advisory!.state === 'draft' ? 404 : 409, advisory!.state === 'draft' ? 'NOT_FOUND' : 'ADVISORY_NOT_DRAFT', advisory!.state === 'draft' ? PUBLIC_NOT_FOUND : 'Only draft advisories have an open discussion.');
    const limited = await consume(env, 'PUBLIC_WRITE_RATE_LIMIT', `user:${principal.userId}`);
    if (limited) throw new ApiError(429, 'RATE_LIMITED', rateLimitMessage(limited, 'posts'));
    const changed = await records.changeAdvisory(key, { action: 'comment', id: advisory!.id, body: text(body.body, 'Comment', ADVISORY_COMMENT_MAX, 1, false), actorId: principal.userId, maintainer });
    return Response.json(await detail(context, changed, viewerOf(changed, principal, maintainer)));
  }
  if (operation) notFound();
  if (!signedInAccount) throw new ApiError(403, 'ACCOUNT_REQUIRED', 'Report vulnerabilities from a signed-in account.');
  assertMutationOrigin(request);
  const body = await readJson(request, ADVISORY_REQUEST_MAX_BYTES);
  const key = requireIdempotencyKey(request);
  if (!await access.check(principal, 'participate', 'repository', repository.id).then(() => true, () => false)) notFound();
  if (!await repositorySecurityPolicy(env, repository)) throw new ApiError(409, 'REPORTING_DISABLED', 'This repository does not accept private vulnerability reports. It has no SECURITY.md.');
  const fields = advisoryFields(body, true);
  const limited = await consume(env, 'VULNERABILITY_REPORT_RATE_LIMIT', `user:${principal.userId}`);
  if (limited) throw new ApiError(429, 'RATE_LIMITED', rateLimitMessage(limited, 'vulnerability reports'));
  if (principal.kind === 'community' && (await access.standing(principal.userId)).limited) {
    await verifyTurnstile(env, body.turnstileToken, client);
    await access.dailyPublicWrite(principal.userId);
  }
  const created = await records.changeAdvisory(key, { action: 'create', repositoryId: repository.id, source: 'report', fields, actorId: principal.userId });
  return Response.json(await detail(context, created, viewerOf(created, principal, maintainer)), { status: 201 });
}
