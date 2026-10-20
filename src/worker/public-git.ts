import type { AppEnv } from './env';
import { handleProblem } from '../shared/handles';
import { catalogName } from './capacity';
import { GIT_CHALLENGE, handleGitRequest, serveUploadPack, text, type GitHttpDependencies } from './git-http';
import { consume, rateLimitMessage } from './rate-limits';
import { findPublicRepository, resolvePublicRepository } from './public-repositories';
import { securityClient } from './security';

const PUBLIC_GIT_PATH = /^\/([a-z0-9-]{1,39})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/i;
const NOT_FOUND = 'Repository not found.';

function canonicalGitPath(pathname: string) {
  const match = PUBLIC_GIT_PATH.exec(pathname);
  return match && handleProblem(match[1]!.toLowerCase(), { operator: true }) === null ? match : null;
}

export function isPublicGitPath(pathname: string): boolean { return !!canonicalGitPath(pathname); }

export async function handlePublicGit(request: Request, env: AppEnv, deps: GitHttpDependencies): Promise<Response | null> {
  const url = new URL(request.url);
  const match = canonicalGitPath(url.pathname);
  if (!match) return null;
  const [, rawHandle, name, operation] = match as unknown as [string, string, string, string];
  const handle = rawHandle.toLowerCase();
  const service = operation === 'info/refs' ? url.searchParams.get('service') : operation;
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return text(403, 'Gitflare supports smart HTTP Git clients only.');
  const kind = operation === 'info/refs' ? 'refs' : 'rpc';
  if (request.method !== (kind === 'refs' ? 'GET' : 'POST')) return text(405, 'This Git operation uses a different HTTP method.');
  const access = securityClient(env);
  if (service === 'git-upload-pack') {
    const limited = await consume(env, 'PUBLIC_GIT_RATE_LIMIT', `ip:${request.headers.get('CF-Connecting-IP') ?? 'local'}`);
    if (limited) return text(429, rateLimitMessage(limited, 'anonymous Git requests'), { 'Retry-After': String(limited.retryAfterSeconds) });
    const target = await resolvePublicRepository(env, access, handle, name);
    if (target && 'redirect' in target) return new Response(null, { status: kind === 'refs' ? 302 : 308, headers: { Location: `/${target.redirect}/${name}.git/${operation}${url.search}`, 'Cache-Control': 'no-store' } });
    if (target) {
      using source = await env.ARTIFACTS!.get(target.repository.name);
      return await serveUploadPack(source, target.repository, request, kind, deps.fetcher ?? fetch);
    }
    if (!request.headers.get('Authorization')) return text(404, NOT_FOUND);
  } else if (!request.headers.get('Authorization')) return text(401, 'Push with a Gitflare personal token as the password. Create one in Account → AI clients.', GIT_CHALLENGE);
  const resolved = await access.resolveHandle(handle);
  const workspaceId = resolved && !('redirect' in resolved) ? resolved.workspaceId : null;
  const rewritten = new Request(new URL(`/git/${name}.git/${operation}${url.search}`, url), request);
  return handleGitRequest(rewritten, {
    ...deps,
    repository: async (principal) => workspaceId && principal.workspaceId === workspaceId ? findPublicRepository(await env.GITFLARE_COORDINATOR.getByName(catalogName(workspaceId)).listRepositories(), name) : undefined,
  });
}
