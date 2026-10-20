import type { IssueDetail, IssueTemplates, IssueViewer, Repository } from '../shared/types';
import { repositoryLabel } from '../shared/repository-names';
import { ApiError, publicError } from './domain';
import type { AppEnv } from './env';
import { readIssueTemplates } from './issue-templates';
import { allowed, issueNumber, issueRoute, type IssueAccess, type IssueChange, type IssueCoordinator, type IssueServices } from './issues';
import { excerptOf, mentionHandles, notify, type PublishInput } from './notifications';
import { repositorySubject } from './inbox';
import { PUBLIC_NOT_FOUND, resolvePublicRepository } from './public-repositories';
import { consume, rateLimitedResponse, rateLimitMessage } from './rate-limits';
import { publicPrincipal, securityClient, type Principal, type SecurityService } from './security';
import { turnstileSiteKey, verifyTurnstile } from './turnstile';

const ROUTE = /^\/api\/public\/repos\/([^/]+)\/([^/]+)\/(issues|issue-labels|issue-templates|issue-viewer)(?:\/(\d{1,6})(?:\/([a-z]+))?)?$/;

export async function repositoryTemplates(env: AppEnv, repository: Repository): Promise<IssueTemplates> {
  if (!env.ARTIFACTS || repository.provider !== 'artifacts') return { directory: null, commitSha: null, templates: [] };
  using source = await env.ARTIFACTS.get(repository.name);
  return await readIssueTemplates(source, repository.defaultBranch);
}

type Waiter = { waitUntil(promise: Promise<unknown>): void } | undefined;

export function issueServices(env: AppEnv, access: SecurityService, repository: Repository, ctx?: Waiter): IssueServices {
  return {
    people: ids => access.profiles(ids), templates: () => repositoryTemplates(env, repository),
    afterWrite: async (change, issue, actorId) => {
      const event = issueNotification(change, issue, actorId);
      if (!event) return;
      const base = await repositorySubject(access, repository);
      await notify(env, access, ctx, { ...event, subject: { ...base, kind: 'issue', number: issue.number, title: issue.title }, actorId, origin: env.APP_ORIGIN });
    },
  };
}

function issueNotification(change: IssueChange, issue: IssueDetail, actorId: string): Omit<PublishInput, 'subject' | 'actorId'> | null {
  const thread = `issue:${issue.repositoryId}:${issue.number}`;
  if (change.action === 'create') return { id: `${thread}:opened`, event: 'opened', excerpt: excerptOf(issue.body), mentions: mentionHandles(issue.body), subscribe: [{ userId: actorId, reason: 'author' }, ...issue.assignees.map(userId => ({ userId, reason: 'assigned' }))], recipients: issue.assignees.map(userId => ({ userId, reason: 'participating' as const })), watchers: true };
  if (change.action === 'comment') {
    const comment = [...issue.comments].reverse().find(item => item.authorId === actorId && item.body === change.body);
    if (!comment) return null;
    return { id: `issue-comment:${comment.id}`, event: 'commented', excerpt: excerptOf(comment.body), mentions: mentionHandles(comment.body), subscribe: [{ userId: actorId, reason: 'commenter' }], thread: true };
  }
  if (change.action === 'close' || change.action === 'reopen') return { id: `${thread}:${change.action}:${issue.updatedAt}`, event: change.action === 'close' ? 'closed' : 'reopened', subscribe: [{ userId: actorId, reason: 'participant' }], thread: true };
  if (change.action === 'update' && change.assignees?.length) return { id: `${thread}:assigned:${issue.updatedAt}`, event: 'opened', subscribe: change.assignees.map(userId => ({ userId, reason: 'assigned' })), recipients: change.assignees.map(userId => ({ userId, reason: 'participating' as const })) };
  return null;
}

function notFound(): never { throw new ApiError(404, 'NOT_FOUND', PUBLIC_NOT_FOUND); }

export async function publicIssuesApi(request: Request, env: AppEnv, signedIn: (request: Request) => Promise<Principal | null>, ctx?: Waiter): Promise<Response | null> {
  const url = new URL(request.url);
  const match = ROUTE.exec(url.pathname);
  if (!match) return null;
  const client = request.headers.get('CF-Connecting-IP') ?? 'local';
  const read = request.method === 'GET' || request.method === 'HEAD';
  if (read) { const limited = await consume(env, 'PUBLIC_READ_RATE_LIMIT', `ip:${client}`); if (limited) return rateLimitedResponse(limited, 'public repository requests'); }
  let handle: string; let name: string;
  try { handle = decodeURIComponent(match[1]!).toLowerCase(); name = decodeURIComponent(match[2]!); } catch { notFound(); }
  const [, , , resource, numberText, operation] = match;
  const access = securityClient(env);
  const target = await resolvePublicRepository(env, access, handle, name);
  if (!target) notFound();
  if ('redirect' in target) return new Response(null, { status: 308, headers: { Location: `/api/public/repos/${target.redirect}/${encodeURIComponent(name)}/${url.pathname.split('/').slice(6).join('/')}${url.search}` } });
  const { repository, workspaceId } = target;
  const home = await signedIn(request);
  if (!home && !read) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to open issues or comment on public repositories.');
  let principal: Principal;
  try { principal = home ? await access.participant(home, workspaceId) : publicPrincipal(workspaceId); }
  catch (error) { if (!read || publicError(error).code !== 'ACCOUNT_REQUIRED') throw error; principal = publicPrincipal(workspaceId); }
  if (!await allowed(access, principal, 'read', repository.id)) notFound();
  const issueAccess: IssueAccess = { authorize: (p, action, type, id) => access.authorize(p, action, type, id), check: (p, action, type, id) => access.check(p, action, type, id), snapshot: p => access.snapshot(p) };
  const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`) as unknown as IssueCoordinator;
  const member = principal.kind === undefined;
  if (resource === 'issue-viewer') {
    if (!read || numberText) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'The issue viewer is read-only.');
    const [canParticipate, canTriage, standing] = await Promise.all([
      principal.kind === 'public' ? false : allowed(access, principal, 'participate', repository.id),
      member ? allowed(access, principal, 'triage', repository.id) : false,
      principal.kind === 'community' ? access.standing(principal.userId) : Promise.resolve({ limited: false, until: null }),
    ]);
    return Response.json({ signedIn: principal.kind !== 'public', userId: principal.kind === 'public' ? null : principal.userId, member, repositoryId: member ? repository.id : null, canParticipate, canTriage, limited: standing.limited, turnstileSiteKey: standing.limited ? turnstileSiteKey(env) : null } satisfies IssueViewer);
  }
  const community = async (body: Record<string, unknown>, turnstile: boolean) => {
    if (principal.kind !== 'community') return;
    const limited = await consume(env, 'PUBLIC_WRITE_RATE_LIMIT', `user:${principal.userId}`);
    if (limited) throw new ApiError(429, 'RATE_LIMITED', rateLimitMessage(limited, 'posts'));
    if (!(await access.standing(principal.userId)).limited) return;
    if (turnstile) await verifyTurnstile(env, body.turnstileToken, client);
    await access.dailyPublicWrite(principal.userId);
  };
  const services: IssueServices = {
    ...issueServices(env, access, repository, ctx),
    beforeWrite: (_change, body) => community(body, true),
    report: async (number, body) => {
      const issue = await coordinator.getIssue(issueNumber(number));
      if (!issue) throw new ApiError(404, 'ISSUE_NOT_FOUND', 'This issue could not be found.');
      const commentId = body.commentId === undefined ? undefined : String(body.commentId);
      if (commentId !== undefined && !issue.comments.some(comment => comment.id === commentId)) throw new ApiError(404, 'COMMENT_NOT_FOUND', 'This comment could not be found.');
      await community(body, false);
      const report = await access.reportContent(principal, { workspaceId, repositoryId: repository.id, address: `${target.handle}/${repositoryLabel(repository)}`, issueNumber: issue.number, ...(commentId ? { commentId } : {}) }, body);
      return Response.json({ ok: true, id: report.id }, { status: 201 });
    },
  };
  return issueRoute(request, url, { principal, repositoryId: repository.id, publicView: true }, resource as 'issues', numberText, operation, issueAccess, coordinator, services);
}
