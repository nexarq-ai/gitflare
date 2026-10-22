import { timingSafeEqual } from 'node:crypto';
import { ApiError, findRepositoryByName, isLocalRequest, publicError } from './domain';
import type { AppEnv } from './env';
import { securityClient, wellFormedToken, type Principal } from './security';
import { gitRateLimits } from './rate-limits';
import { CLOUDFLARE_LINK_COOKIE } from './cloudflare';
import type { GitHttpDependencies } from './git-http';
import { effectiveRules } from './branch-protection';
import { triggerMirrorSync } from './github-mirror-runtime';
import { demoMode } from './demo';
import { demoVisitor } from './demo-runtime';
import { sessionCookie, sessionCookieValue } from './session-policy';
import { refreshPublicRepository } from './public-discovery';
import { FORK_STORAGE_LIMIT_BYTES } from './forks';
import { catalogName, records } from './route-context';

const encoder = new TextEncoder();

export async function tokenMatches(token: string, expected: string): Promise<boolean> {
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(token)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return timingSafeEqual(new Uint8Array(actualHash), new Uint8Array(expectedHash));
}

export function security(env: AppEnv) { if (!env.GITFLARE_SECURITY) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'The security service is not configured.'); return securityClient(env); }
export const sessionRenewals = new WeakMap<Request, string>();
export function sessionResponse(result: { token?: string; user?: unknown; workspaceId?: string; mfaRequired?: boolean }, clearLink = false) { const headers = new Headers(); if (clearLink) headers.append('Set-Cookie', `${CLOUDFLARE_LINK_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`); if (!result.token) return Response.json(result, { headers }); const { token, ...body } = result; headers.append('Set-Cookie', sessionCookie(token)); return Response.json({ ok: true, ...body }, { headers }); }
export async function authorize(request: Request, env: AppEnv, bearerOnly = false): Promise<Principal> {
  const authorization = request.headers.get('Authorization'); const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  if (demoMode(env) && !bearer) return demoVisitor(env);
  if (env.EDITION !== 'self-hosted' && !bearerOnly && isLocalRequest(request, env.APP_ENV) && !bearer && !sessionCookieValue(request)) return security(env).bootstrap();
  if (env.EDITION !== 'self-hosted' && bearer && env.OWNER_TOKEN && env.OWNER_TOKEN.length >= 32 && await tokenMatches(bearer, env.OWNER_TOKEN)) {
    const workspace = request.headers.get('X-Gitflare-Workspace'); if (workspace && workspace !== 'legacy') throw new ApiError(403, 'FORBIDDEN', 'The legacy key cannot access other workspaces.'); return security(env).bootstrap();
  }
  if (bearer) return security(env).authenticate(bearer, request.headers.get('X-Gitflare-Workspace') ?? undefined);
  const cookie = bearerOnly ? undefined : sessionCookieValue(request);
  if (cookie) {
    const { principal, renewedUntil } = await security(env).authenticateSession(cookie, request.headers.get('X-Gitflare-Workspace') ?? undefined);
    if (renewedUntil !== undefined) sessionRenewals.set(request, sessionCookie(cookie, renewedUntil - Date.now()));
    return principal;
  }
  throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to Gitflare.');
}

export function signedInPrincipal(env: AppEnv) {
  return async (request: Request): Promise<Principal | null> => {
    if (demoMode(env) || !request.headers.get('Authorization') && !sessionCookieValue(request)) return null;
    try { return await authorize(request, env); }
    catch (error) { if (publicError(error).status === 401) return null; throw error; }
  };
}

const gitBlocks = new Map<string, number>();

export function gitDependencies(env: AppEnv): GitHttpDependencies {
  return {
    authenticate: async (token) => {
      if (env.EDITION !== 'self-hosted' && env.OWNER_TOKEN && env.OWNER_TOKEN.length >= 32 && await tokenMatches(token, env.OWNER_TOKEN)) return security(env).bootstrap();
      if (!wellFormedToken(token)) throw new ApiError(401, 'AUTH_REQUIRED', 'The Gitflare token is malformed.');
      return security(env).authenticate(token);
    },
    limits: gitRateLimits(env, gitBlocks),
    authorize: (principal, action, repositoryId) => security(env).authorize(principal, action, 'repository', repositoryId),
    repository: async (principal, name) => findRepositoryByName(await env.GITFLARE_COORDINATOR.getByName(catalogName(principal.workspaceId)).listRepositories(), principal.workspaceId, name),
    rules: async (repository) => effectiveRules(await records(env, repository.id).getBranchProtection(), repository.defaultBranch),
    artifacts: env.ARTIFACTS,
    pushed: async (repository, refs) => { await Promise.all([triggerMirrorSync(env, repository.id, repository.workspaceId ?? 'legacy', 'push', refs), refreshPublicRepository(env, repository.id).catch(() => undefined)]); },
    storage: async (repository) => repository.fork ? { remainingBytes: FORK_STORAGE_LIMIT_BYTES - await records(env, repository.id).forkStorage(), limitBytes: FORK_STORAGE_LIMIT_BYTES } : null,
    stored: async (repository, bytes) => { await records(env, repository.id).addForkStorage(bytes); },
  };
}

export async function hasSession(request: Request, env: AppEnv): Promise<boolean> {
  const session = sessionCookieValue(request);
  return session ? security(env).authenticate(session).then(() => true, () => false) : false;
}
