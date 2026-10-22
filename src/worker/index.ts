import { WorkerEntrypoint } from 'cloudflare:workers';
import { ApiError, assertMutationOrigin, COMMIT_MESSAGE_REQUEST_MAX_BYTES, isLocalRequest, MISSION_REQUEST_MAX_BYTES, publicError, readJson, requireIdempotencyKey, requireString } from './domain';
import type { AppEnv } from './env';
import { handleMcp, mcpToolNames } from './mcp';
import { hashToken } from './security';
import { clientIp, consume, rateLimitedResponse, rateSubject } from './rate-limits';
import { listDocs, readDoc } from './docs';
import { documentationImage, documentationMarkdown } from './docs-markdown';
import { handleOnboarding } from './onboarding';
import { listPublicDocs, readPublicDoc, publicSourceResponse } from './distribution';
import { oauthConsent, oauthProvider } from './oauth';
import { publicPageResponse } from './public-pages';
import { hostRedirect, withHostOrigins } from './host-split';
import { publicGitResponse } from './hosted-source';
import { requestSessionMeta } from './session-meta';
import { CLOUDFLARE_LINK_COOKIE, requestCookie, handleCloudflare } from './cloudflare';
import { SKILL_REQUEST_MAX_BYTES } from './skill-edit';
import { handleIssues } from './issues';
import { issueServices, publicIssuesApi } from './public-issues';
import { notificationsApi, unsubscribeApi } from './inbox';
import { publicAdvisoriesApi } from './advisories';
import { feedResponse } from './feeds';
import { publicDownloadResponse } from './public-downloads';
import { socialCardResponse, socialMetaTags } from './social-cards';
import { IMPORT_REQUEST_MAX_BYTES } from './repository-import';
import { handleGitRequest } from './git-http';
import { handleUrlImport } from './url-import';
import { githubMirrorApi } from './github-mirror-runtime';
import { githubImportApi, handleGithubOrgImport, runGithubImportCron } from './github-import-runtime';
import { GITHUB_IMPORT_CRON } from './github-import';
import { relayPreview } from './preview-capability';
import { withStoreSecrets } from './store-secrets';
import { DEMO_WRITE_LIMIT, demoGitRestriction, demoMode, demoRestrictionError, demoRouteRestriction } from './demo';
import { demoDisabledApi, handleDemoRoute, runDemoReset } from './demo-runtime';
import { assertCookieRequestOrigin, CLEAR_SESSION_COOKIE } from './session-policy';
import { withSignedInHint } from './signed-in-hint';
import { publicRepositoryApi, publicRepositoryIndex, siteOrigin } from './public-repositories';
import { handlePublicGit, isPublicGitPath } from './public-git';
import { publicDiscoveryApi } from './public-discovery';
import { servePublicCached } from './public-cache';
import { PUBLIC_INDEX_CRON, publicIndex, reconcilePublicIndex } from './public-index';
import { handleForks } from './forks';
import { handleUpstreamProposals } from './outside-proposals';
import { publicFixRequestsApi } from './fix-requests';
import { handleCommunityAi } from './agent-assist';
import { type RouteContext, catalogName, records, requireRepository, outsideContext, findMission, triageCreated } from './route-context';
import { tokenMatches, security, sessionRenewals, sessionResponse, authorize, signedInPrincipal, gitDependencies, hasSession } from './request-auth';
import { accessRoutes } from './routes/access';
import { aiRoutes } from './routes/ai';
import { workspaceSnapshot } from './routes/workspace';
import { repositoryCloudflareRoutes } from './routes/repository-cloudflare';
import { releaseRoutes } from './routes/releases';
import { repositoryContent, repositoryWrites } from './routes/repositories';
import { repositorySettingsRoutes } from './routes/repository-settings';
import { missionReads, missionWrites } from './routes/missions';

export { GitflareSecurity } from './security';
export { GitflareCoordinator } from './coordinator';
export { MissionWorkflow } from './workflow';
export { ModelRelay } from './model-relay';
export { AgentSandbox, BootstrapOutbound, GitOutbound, ImportOutbound, RegistryOutbound } from '../../runner/sandbox';

const OAUTH_POST_LIMIT = { max: 60, windowMs: 60_000 };

export class PreviewRelay extends WorkerEntrypoint<AppEnv> {
  async fetch(request: Request): Promise<Response> {
    return relayPreview(this.env, request, (capability) => security(this.env).check(capability.principal, 'read', 'repository', capability.repositoryId, capability.missionId));
  }
}

async function api(request: Request, env: AppEnv, ctx?: ExecutionContext): Promise<Response> {
  if (!demoMode(env)) return apiRoutes(request, env, ctx);
  return demoDisabledApi(request, env, {
    next: () => apiRoutes(request, env, ctx),
    principal: () => authorize(request, env),
    repository: async (principal, id) => {
      const repository = await requireRepository(env.GITFLARE_COORDINATOR.getByName(catalogName(principal.workspaceId)), id);
      await security(env).authorize(principal, 'read', 'repository', repository.id);
      return repository;
    },
  });
}

async function apiRoutes(request: Request, env: AppEnv, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const local = env.EDITION !== 'self-hosted' && isLocalRequest(request, env.APP_ENV);
  if (demoMode(env)) {
    const restricted = demoRouteRestriction(request.method, url.pathname);
    if (restricted) throw demoRestrictionError(restricted);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) await security(env).rateLimit(`demo-write:${clientIp(request)}`, DEMO_WRITE_LIMIT.max, DEMO_WRITE_LIMIT.windowMs);
  }
  if (request.method === 'GET' && url.pathname === '/api/public/docs') return Response.json({ items: listPublicDocs() });
  if (request.method === 'GET' && url.pathname.startsWith('/api/public/docs/diagrams/')) return documentationImage(url.pathname.slice('/api/public/docs/diagrams/'.length));
  if (request.method === 'GET' && url.pathname.startsWith('/api/public/docs/')) {
    const id = url.pathname.slice('/api/public/docs/'.length);
    const markdown = id.endsWith('.md');
    const doc = readPublicDoc(markdown ? id.slice(0, -3) : id);
    if (!doc) throw new ApiError(404, 'DOC_NOT_FOUND', 'This guide does not exist.');
    return markdown ? documentationMarkdown(doc, listPublicDocs(), request.url, true) : Response.json(doc);
  }
  if (url.pathname.startsWith('/api/public/source')) return publicSourceResponse(request, env.ASSETS);
  const unsubscribe = await unsubscribeApi(request, env);
  if (unsubscribe) return unsubscribe;
  const fixRequests = await publicFixRequestsApi(request, env, signedInPrincipal(env));
  if (fixRequests) return fixRequests;
  const publicIssues = await publicIssuesApi(request, env, signedInPrincipal(env), ctx);
  if (publicIssues) return triageCreated(request, publicIssues, env, ctx);
  const publicAdvisories = await publicAdvisoriesApi(request, env, signedInPrincipal(env));
  if (publicAdvisories) return publicAdvisories;
  const publicRepository = await publicRepositoryApi(request, env);
  if (publicRepository) return publicRepository;
  const discovery = await publicDiscoveryApi(request, env, ctx);
  if (discovery) return discovery;
  const cloudflare = await handleCloudflare(request, env, authorize);
  if (cloudflare) return cloudflare;
  const onboarding = await handleOnboarding(request, env, authorize, ctx);
  if (onboarding) return onboarding;
  if (request.method === 'POST' && ['/api/login', '/api/session'].includes(url.pathname)) {
    assertMutationOrigin(request);
    await security(env).rateLimit(`auth:${clientIp(request)}`);
    const body = await readJson(request);
    if (url.pathname === '/api/login') { const link = requestCookie(request, CLOUDFLARE_LINK_COOKIE); return sessionResponse(await security(env).login(body, clientIp(request), link, requestSessionMeta(request)), !!link); }
    const token = requireString(body.token, 'Token', 1024, 32);
    if (env.EDITION === 'self-hosted' || !env.OWNER_TOKEN || !await tokenMatches(token, env.OWNER_TOKEN)) throw new ApiError(401, 'AUTH_REQUIRED', 'The owner token was not accepted.');
    return sessionResponse({ token: await security(env).legacySession(), workspaceId: 'legacy' });
  }
  const principal = await authorize(request, env);
  const access = security(env);
  if (url.pathname === '/api/session' && request.method === 'GET') return Response.json({ authenticated: true, userId: principal.userId, workspaceId: principal.workspaceId });
  const notifications = await notificationsApi(request, env, principal, access);
  if (notifications) return notifications;
  if (request.method === 'GET' && (['/api/docs', '/api/mcp'].includes(url.pathname) || url.pathname.startsWith('/api/docs/'))) await access.authorizeMetadata(principal);
  const accessResponse = await accessRoutes({ request, url, env, ctx, principal, access, local }, application);
  if (accessResponse) return accessResponse;
  if (request.method === 'GET' && url.pathname === '/api/docs') return Response.json({ items: listDocs() });
  if (request.method === 'GET' && url.pathname.startsWith('/api/docs/')) {
    const id = url.pathname.slice('/api/docs/'.length);
    const markdown = id.endsWith('.md');
    const document = readDoc(markdown ? id.slice(0, -3) : id);
    if (!document) throw new ApiError(404, 'DOC_NOT_FOUND', 'This documentation page could not be found.');
    return markdown ? documentationMarkdown(document, listDocs(), request.url, false) : Response.json(document);
  }
  const catalog = env.GITFLARE_COORDINATOR.getByName(catalogName(principal.workspaceId));
  const context: RouteContext = { request, url, env, ctx, principal, access, catalog, local };
  const ai = await aiRoutes(context);
  if (ai) return ai;
  if (request.method === 'GET' && url.pathname === '/api/mcp') {
    return Response.json({ endpoint: `${url.origin}/mcp`, transport: 'streamable-http', authentication: env.OAUTH_KV ? 'oauth' : 'bearer', configured: !!env.OAUTH_KV, tools: mcpToolNames, ownerApprovalRequired: true, ownerActions: 'ui_and_mcp' });
  }
  if (request.method === 'POST' && url.pathname === '/api/session/logout') {
    assertMutationOrigin(request);
    await access.logout(principal);
    sessionRenewals.delete(request);
    return Response.json({ ok: true }, { headers: { 'Set-Cookie': CLEAR_SESSION_COOKIE } });
  }
  if (request.method === 'GET' && url.pathname === '/api/workspace') return workspaceSnapshot(context);
  const cloudflareRoute = await repositoryCloudflareRoutes(context);
  if (cloudflareRoute) return cloudflareRoute;
  const issues = await handleIssues(request, url, principal, access, catalog, (id) => records(env, id), (repository) => issueServices(env, access, repository, ctx));
  if (issues) return triageCreated(request, issues, env, ctx);
  const blocksRoute = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/issue-blocks$/.exec(url.pathname);
  if (blocksRoute) {
    const repository = await requireRepository(catalog, blocksRoute[1]!);
    if (request.method === 'GET') return Response.json({ blocks: await access.blocks(principal, repository.id) });
    if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST.');
    assertMutationOrigin(request);
    return Response.json({ blocks: await access.setBlock(principal, repository.id, await readJson(request)) });
  }
  const forks = await handleForks(request, url, { env, principal, access, catalog, catalogOf: (workspaceId) => env.GITFLARE_COORDINATOR.getByName(catalogName(workspaceId)), records: (id) => records(env, id) });
  if (forks) return forks;
  const outside = outsideContext(context);
  const upstreamProposals = await handleUpstreamProposals(request, url, { ...outside, catalog });
  if (upstreamProposals) return upstreamProposals;
  const communityAi = await handleCommunityAi(request, url, { env, principal, access, catalog, findMission: (id) => findMission(env, id, principal.workspaceId) });
  if (communityAi) return communityAi;
  const urlImport = await handleUrlImport(request, url, { env, principal, access, catalog, repositoryRecords: (id) => records(env, id) });
  if (urlImport) return urlImport;
  const importRoute = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/github-import(?:\/([a-z-]+))?$/.exec(url.pathname);
  if (importRoute) {
    const repository = await requireRepository(catalog, importRoute[1]);
    return githubImportApi(request, env, { repository: { ...repository, workspaceId: repository.workspaceId ?? principal.workspaceId }, principal, origin: url.origin, ctx }, importRoute[2]);
  }
  const orgImport = await handleGithubOrgImport(request, url, env, principal, ctx);
  if (orgImport) return orgImport;
  const mirrorRoute = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/github-mirror(?:\/([a-z-]+))?$/.exec(url.pathname);
  if (mirrorRoute) {
    const repository = await requireRepository(catalog, mirrorRoute[1]);
    const coordinator = records(env, repository.id);
    return githubMirrorApi(request, env, { repository: { ...repository, workspaceId: repository.workspaceId ?? principal.workspaceId }, principal, ctx, bootstrapSha: () => coordinator.repositoryBootstrapSha() }, mirrorRoute[2]);
  }
  const releases = await releaseRoutes(context);
  if (releases) return releases;
  const repositoryMatch = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/(tree|file|skills|proposal-base|import)$/.exec(url.pathname);
  if (request.method === 'GET' && repositoryMatch) return repositoryContent(context, repositoryMatch);
  const settings = await repositorySettingsRoutes(context);
  if (settings) return settings;
  const match = /^\/api\/missions\/([a-zA-Z0-9-]+)(?:\/(start|cancel|approve|revoke|integrate|preview|preview-extend|preview-stop|attempts|review|select|revert|pull|retry-checks|run-checks|retry-agents|drop-failed-agents|address-review|submit-review))?$/.exec(url.pathname);
  const missionRead = await missionReads(context, match);
  if (missionRead) return missionRead;
  if (request.method !== 'POST') throw new ApiError(404, 'NOT_FOUND', 'This API route could not be found.');
  assertMutationOrigin(request);
  const key = requireIdempotencyKey(request);
  const body = await readJson(request, repositoryMatch?.[2] === 'import' ? IMPORT_REQUEST_MAX_BYTES : repositoryMatch?.[2] === 'skills' ? SKILL_REQUEST_MAX_BYTES : url.pathname === '/api/missions' ? MISSION_REQUEST_MAX_BYTES : match?.[2] === 'approve' || match?.[2] === 'integrate' ? COMMIT_MESSAGE_REQUEST_MAX_BYTES : undefined);
  const repositoryWrite = await repositoryWrites(context, repositoryMatch, key, body);
  if (repositoryWrite) return repositoryWrite;
  const missionWrite = await missionWrites(context, match, key, body);
  if (missionWrite) return missionWrite;
  throw new ApiError(404, 'NOT_FOUND', 'This API route could not be found.');
}

const ENTRY_PATHS = new Set(['/', '/signin', '/signup']);

async function entryRedirect(request: Request, env: AppEnv, path: string): Promise<Response | null> {
  if (request.method !== 'GET' || !ENTRY_PATHS.has(path)) return null;
  const signedIn = demoMode(env) || await hasSession(request, env);
  const location = signedIn ? (path === '/' && env.EDITION !== 'self-hosted' ? null : '/overview') : env.EDITION === 'self-hosted' && path === '/' ? '/signin' : null;
  return location ? new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } }) : null;
}

async function gitResponse(handle: () => Promise<Response | null>): Promise<Response> {
  try { return (await handle())!; }
  catch (error) { console.error(JSON.stringify({ event: 'git_request_failed', name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 200), stack: error instanceof Error ? error.stack?.split('\n').slice(1, 6).join(' | ') : undefined })); return new Response('Gitflare could not complete this Git request. Try again shortly.\n', { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }); }
}

const application = {
  async fetch(request: Request, env: AppEnv, ctx?: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/git/')) {
      const demoBlocked = demoMode(env) ? demoGitRestriction(request.method, new URL(request.url)) : null;
      if (demoBlocked) return new Response(`${demoBlocked.message}\n`, { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      return gitResponse(() => handleGitRequest(request, gitDependencies(env)));
    }
    const publicGit = await publicGitResponse(request, env);
    if (publicGit) return publicGit;
    if (isPublicGitPath(path)) return gitResponse(() => handlePublicGit(request, env, gitDependencies(env)));
    if (path === '/oauth/authorize') return oauthConsent(request, env, authorize);
    const publicPage = publicPageResponse(request, env);
    if (publicPage && path === '/llms.txt' && request.method === 'GET' && publicPage.ok) return new Response(`${await publicPage.text()}${await publicRepositoryIndex(env, siteOrigin(env, new URL(request.url).origin), clientIp(request))}`, { headers: publicPage.headers });
    if (publicPage) return publicPage;
    if (path === '/llms.txt') return new Response('# Gitflare\n\n' + listPublicDocs().map(doc => `- [${doc.title}](${new URL(request.url).origin}/api/public/docs/${doc.id}.md): ${doc.description}`).join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    const feed = await feedResponse(request, env);
    if (feed) return feed;
    const download = await publicDownloadResponse(request, env);
    if (download) return download;
    const card = await socialCardResponse(request, env, ctx);
    if (card) return card;
    const entry = await entryRedirect(request, env, path);
    if (entry) return entry;
    if (!path.startsWith('/api/') && path !== '/mcp') return withHostOrigins(await env.ASSETS.fetch(request), env, path, await socialMetaTags(request, env));
    let response: Response;
    try {
      if (path === '/mcp') {
        const subject = rateSubject(await authorize(request, env, true));
        response = await handleMcp(request, async (internal) => {
          const headers = new Headers(internal.headers);
          headers.set('Authorization', request.headers.get('Authorization') ?? '');
          const workspace = request.headers.get('X-Gitflare-Workspace'); if (workspace) headers.set('X-Gitflare-Workspace', workspace);
          const client = request.headers.get('CF-Connecting-IP'); if (client) headers.set('CF-Connecting-IP', client);
          return api(new Request(internal, { headers }), env, ctx);
        }, kind => consume(env, kind === 'read' ? 'MCP_READ_RATE_LIMIT' : 'MCP_WRITE_RATE_LIMIT', subject), demoMode(env));
      } else {
        assertCookieRequestOrigin(request);
        const bearer = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
        const limited = bearer ? await consume(env, 'API_RATE_LIMIT', `token:${await hashToken(bearer)}`) : demoMode(env) ? await consume(env, 'API_RATE_LIMIT', `ip:${clientIp(request)}`) : null;
        const demoRoute = limited ? null : await handleDemoRoute(request, env);
        response = limited ? rateLimitedResponse(limited, 'API requests') : demoRoute ?? (path.startsWith('/api/public/') ? await servePublicCached(request, env, ctx, () => api(request, env, ctx)) : await api(request, env, ctx));
      }
    } catch (error) {
      const failure = publicError(error);
      if (failure.code === 'INTERNAL_ERROR') console.error(JSON.stringify({ event: 'api_unexpected_error', method: request.method, route: path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, ':id'), name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 200), stack: error instanceof Error ? error.stack?.split('\n').slice(1, 6).join(' | ') : undefined }));
      response = Response.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status });
    }
    const renewal = sessionRenewals.get(request);
    if (renewal && response.status !== 401 && !response.headers.getSetCookie().some(cookie => cookie.startsWith('gitflare_session='))) response.headers.append('Set-Cookie', renewal);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (path === '/mcp' && response.status === 401) response.headers.set('WWW-Authenticate', 'Bearer realm="gitflare"');
    return response;
  },
} satisfies ExportedHandler<AppEnv>;

export default {
  async fetch(request: Request, workerEnv: AppEnv, ctx?: ExecutionContext): Promise<Response> {
    try {
      const env = await withStoreSecrets(workerEnv);
      const hostMove = await hostRedirect(request, env, request => hasSession(request, env));
      if (hostMove) return hostMove;
      const path = new URL(request.url).pathname;
      if (env.OAUTH_KV && (path === '/mcp' || path.startsWith('/oauth/') || path.startsWith('/.well-known/'))) {
        if (path.startsWith('/oauth/') && request.method === 'POST') await security(env).rateLimit(`oauth:${clientIp(request)}`, OAUTH_POST_LIMIT.max, OAUTH_POST_LIMIT.windowMs);
        return await oauthProvider(new URL(request.url).origin, application, authorize).fetch(request, env, ctx!);
      }
      return withSignedInHint(request, await application.fetch(request, env, ctx), env);
    } catch (error) { const failure = publicError(error); return Response.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status, headers: { 'Cache-Control': 'no-store' } }); }
  },
  async scheduled(controller: ScheduledController, workerEnv: AppEnv): Promise<void> {
    if (demoMode(workerEnv)) { await runDemoReset(await withStoreSecrets(workerEnv)); return; }
    if (controller.cron === PUBLIC_INDEX_CRON && publicIndex(workerEnv) && workerEnv.GITFLARE_SECURITY) console.log(JSON.stringify({ event: 'public_index_reconciled', ...await reconcilePublicIndex(await withStoreSecrets(workerEnv)) }));
    if (controller.cron === GITHUB_IMPORT_CRON && workerEnv.GITFLARE_SECURITY) console.log(JSON.stringify({ event: 'github_import_cron', ...await runGithubImportCron(await withStoreSecrets(workerEnv)) }));
  },
} satisfies ExportedHandler<AppEnv>;
