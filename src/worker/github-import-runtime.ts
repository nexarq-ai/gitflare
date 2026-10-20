import type { Repository } from '../shared/types';
import type { GitHubOrgImportEntry, GitHubOrgImportView } from '../shared/github-import';
import type { AppEnv } from './env';
import { ApiError, assertMutationOrigin, readJson, requireIdempotencyKey, requireString } from './domain';
import { dispatchBackground, type StepRunner } from './background-work';
import { catalogName } from './capacity';
import { decryptAuth, encryptAuth } from './mfa';
import { securityClient, type Principal, type SecurityService } from './security';
import { basicAuthorization } from './git-transfer';
import { githubAppConfig, githubInstallationToken } from './github-app';
import { credentialContext as mirrorCredentialContext, GITHUB_ORIGIN, githubTarget, mirrorRemotes, type StoredMirror } from './github-mirror';
import { consume } from './rate-limits';
import { createUrlImportRepository, urlImportInput } from './url-import';
import { browserOnlyToken, credentialContext, fetchPullHeads, handleGithubImport, IMPORT_REGISTRY, importWorkflowId, inspectGithubRepository, listGithubRepositories, newImportJob, ORG_IMPORT_MAX, pullStream, runImportInline, runImportWorkflow, sourceKey, TRANSITION_INTERVAL_MS, type ImportParams, type ImportRecords, type ImportRunContext, type ImportServices, type OrgImportRecord, type StoredImport } from './github-import';

type Waiter = { waitUntil(promise: Promise<unknown>): void };

function coordinator(env: AppEnv, repositoryId: string) { return env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`); }
function registry(env: AppEnv) { return env.GITFLARE_COORDINATOR.getByName(IMPORT_REGISTRY); }

export function importRecords(env: AppEnv, repositoryId: string): ImportRecords {
  const records = coordinator(env, repositoryId);
  return {
    githubImport: () => records.githubImport(),
    changeGithubImport: (change) => records.changeGithubImport(change),
    importedPulls: (source, numbers) => records.importedGithubPulls(source, numbers),
    importedReleases: (source, ids) => records.importedGithubReleases(source, ids),
  };
}

export async function mirrorToken(env: AppEnv, repository: Repository, mirror: StoredMirror, fetcher: typeof fetch = fetch): Promise<string> {
  if (!mirror.credential) throw new ApiError(412, 'MIRROR_CREDENTIAL_MISSING', 'Add a GitHub credential to the mirror first.');
  if (mirror.credential.kind === 'pat') return decryptAuth(mirror.credential.encrypted, env.AUTH_ENCRYPTION_KEY, mirrorCredentialContext(mirror.credential.authorizedBy.workspaceId, repository.id));
  const config = githubAppConfig(env);
  if (!config) throw new ApiError(503, 'GITHUB_APP_NOT_CONFIGURED', 'This installation has no GitHub App configured.');
  return githubInstallationToken(config, mirror.credential.installationId, mirror.name, fetcher);
}

async function isPublic(access: SecurityService, principal: Principal, repositoryId: string): Promise<boolean> {
  return access.visibility(principal, repositoryId).then(record => !!record, () => false);
}

function importServices(env: AppEnv, repository: Repository, fetcher: typeof fetch = fetch): ImportServices {
  const records = coordinator(env, repository.id);
  const access = securityClient(env);
  return {
    repository: () => records.getRepository(repository.id),
    isPublic: (principal) => isPublic(access, principal, repository.id),
    async token(job) {
      if (!job.credential) return null;
      if (job.credential.kind === 'token') return decryptAuth(job.credential.encrypted, env.AUTH_ENCRYPTION_KEY, credentialContext(job.authorizedBy.workspaceId, repository.id));
      const mirror = await records.githubMirror();
      if (!mirror?.credential || sourceKey(mirror.owner, mirror.name) !== sourceKey(job.owner, job.name)) throw new ApiError(412, 'MIRROR_CREDENTIAL_MISSING', 'The GitHub mirror no longer has a credential for this repository. Add a token in the browser and resume.');
      return mirrorToken(env, repository, mirror, fetcher);
    },
    async tagCommit(tag) {
      if (!env.ARTIFACTS) return null;
      try {
        using source = await env.ARTIFACTS.get(repository.name);
        for (const ref of [`refs/tags/${tag}`, tag]) {
          const [commit] = await source.log({ ref, limit: 1 }).catch(() => []);
          if (commit?.hash) return commit.hash;
        }
      } catch {}
      return null;
    },
    async openProposals(job, pulls, token) {
      const current = await records.getRepository(repository.id);
      if (!current?.headSha || current.provider !== 'artifacts') return { proposals: [], skipped: pulls.map(pull => ({ kind: 'pull' as const, ref: `#${pull.number}`, reason: 'The repository has no code yet.' })) };
      const github = { url: `${GITHUB_ORIGIN}/${job.owner}/${job.name}.git`, authorization: token ? basicAuthorization(token) : '', label: 'GitHub' };
      const fetched = await fetchPullHeads(github, await mirrorRemotes(env, current, fetcher).gitflare('write'), pulls, fetcher);
      const workspaceId = current.workspaceId ?? job.authorizedBy.workspaceId;
      const catalog = env.GITFLARE_COORDINATOR.getByName(catalogName(workspaceId));
      const models = await catalog.getModelConnections();
      const proposals: { number: number; missionId: string }[] = [], skipped: { kind: 'pull'; ref: string; reason: string }[] = [];
      for (const result of fetched) {
        const pull = pulls.find(item => item.number === result.number)!;
        if (!result.headSha) { skipped.push({ kind: 'pull', ref: `#${pull.number}`, reason: result.reason ?? 'The head could not be fetched.' }); continue; }
        if (result.headSha === current.headSha) { skipped.push({ kind: 'pull', ref: `#${pull.number}`, reason: 'It has no commits that are not already on the default branch.' }); continue; }
        const mission = await records.createMission(`github-pr:${repository.id}:${sourceKey(job.owner, job.name)}:${pull.number}:${result.headSha}`, { repositoryId: repository.id, title: pull.title, prompt: pull.description, branchChange: { branch: pullStream(pull.number), headSha: result.headSha, targetBranch: current.defaultBranch, description: pull.description } }, { principal: job.authorizedBy, workspaceId, creatorId: job.authorizedBy.userId }, models);
        await catalog.indexMission(mission.id, repository.id);
        proposals.push({ number: pull.number, missionId: mission.id });
      }
      return { proposals, skipped };
    },
    check: async (principal, action, resourceType, resourceId) => { await access.check(principal, action, resourceType, resourceId); },
  };
}

function runContext(env: AppEnv, repository: Repository, fetcher?: typeof fetch): ImportRunContext {
  return { repositoryId: repository.id, records: importRecords(env, repository.id), services: importServices(env, repository, fetcher), fetcher };
}

async function repositoryRecord(env: AppEnv, repositoryId: string): Promise<Repository | undefined> { return coordinator(env, repositoryId).getRepository(repositoryId); }

export async function dispatchImport(env: AppEnv, repository: Repository, job: Pick<StoredImport, 'runId'>, ctx?: Waiter, generation = 0, fetcher?: typeof fetch): Promise<void> {
  const params: ImportParams = { kind: 'github-import', repositoryId: repository.id, workspaceId: repository.workspaceId ?? 'legacy', runId: job.runId, generation };
  if (env.MISSION_WORKFLOW && await dispatchBackground(env.MISSION_WORKFLOW, importWorkflowId(params), params) !== 'missing') return;
  const running = runImportInline(runContext(env, repository, fetcher), job.runId).catch(() => undefined);
  if (ctx) ctx.waitUntil(running); else await running;
}

export async function githubImportWorkflow(env: AppEnv, params: ImportParams, step: StepRunner): Promise<void> {
  const repository = await repositoryRecord(env, params.repositoryId);
  if (!repository) return;
  await runImportWorkflow(runContext(env, repository), params, step, async (next) => { if (env.MISSION_WORKFLOW) await dispatchBackground(env.MISSION_WORKFLOW, importWorkflowId(next), next); });
}

async function register(env: AppEnv, repository: Repository, enabled: boolean): Promise<void> {
  await registry(env).registerGithubImport({ repositoryId: repository.id, workspaceId: repository.workspaceId ?? 'legacy' }, enabled);
}

export interface ImportRouteContext { repository: Repository; principal: Principal; origin: string; ctx?: Waiter; fetcher?: typeof fetch }

export async function githubImportApi(request: Request, env: AppEnv, route: ImportRouteContext, action: string | undefined): Promise<Response> {
  const { repository, principal } = route;
  const access = securityClient(env);
  if (request.method === 'POST' && action === 'start') {
    const limited = await consume(env, 'GITHUB_IMPORT_RATE_LIMIT', `user:${principal.userId}`);
    if (limited) throw new ApiError(429, 'RATE_LIMITED', `Too many GitHub imports. Wait ${limited.retryAfterSeconds} seconds.`);
  }
  return handleGithubImport(request, {
    repository, principal, access, records: importRecords(env, repository.id), encryptionKey: env.AUTH_ENCRYPTION_KEY, fetcher: route.fetcher,
    mirror: () => coordinator(env, repository.id).githubMirror(),
    mirrorToken: (mirror) => mirrorToken(env, repository, mirror, route.fetcher),
    isPublic: () => isPublic(access, principal, repository.id),
    dispatch: (job) => dispatchImport(env, repository, job, route.ctx, 0, route.fetcher),
    register: (enabled) => register(env, repository, enabled),
    homeUrl: `${route.origin}/repository/${encodeURIComponent(repository.id)}`,
  }, action);
}

export async function runGithubImportCron(env: AppEnv, now = Date.now()): Promise<{ pulled: number; resumed: number; removed: number }> {
  const result = { pulled: 0, resumed: 0, removed: 0 };
  for (const entry of await registry(env).githubImportRegistry()) {
    try {
      const repository = await repositoryRecord(env, entry.repositoryId);
      const job = repository ? await coordinator(env, entry.repositoryId).githubImport() : null;
      if (!repository || !job) { await registry(env).registerGithubImport(entry, false); result.removed++; continue; }
      const running = ['queued', 'running', 'waiting'].includes(job.state);
      if (running) {
        const stale = job.state === 'waiting' ? Date.parse(job.retryAt ?? job.updatedAt) + 10 * 60_000 < now : Date.parse(job.updatedAt) + 15 * 60_000 < now && (!job.lock || job.lock.expiresAt < now);
        if (stale) { await dispatchImport(env, repository, job, undefined, Math.floor(now / 60_000)); result.resumed++; }
        continue;
      }
      if (!job.transition.enabled || job.canonical) { await registry(env).registerGithubImport(entry, false); result.removed++; continue; }
      if (job.transition.lastPullAt && Date.parse(job.transition.lastPullAt) + TRANSITION_INTERVAL_MS > now) continue;
      const pulled = await coordinator(env, entry.repositoryId).changeGithubImport({ kind: 'pull', runId: crypto.randomUUID(), now: new Date(now).toISOString() });
      if (pulled.job) { await dispatchImport(env, repository, pulled.job); result.pulled++; }
    } catch (error) {
      console.warn(JSON.stringify({ event: 'github_import_cron_failed', repositoryId: entry.repositoryId, name: error instanceof Error ? error.name : 'unknown' }));
    }
  }
  return result;
}

async function orgView(env: AppEnv, record: OrgImportRecord): Promise<GitHubOrgImportView> {
  const repositories: GitHubOrgImportEntry[] = await Promise.all(record.repositories.map(async entry => {
    if (!entry.repositoryId) return { name: entry.name, repositoryId: null, ...(entry.error ? { error: entry.error } : {}) };
    const records = coordinator(env, entry.repositoryId);
    const [repository, job] = await Promise.all([records.getRepository(entry.repositoryId), records.githubImport()]);
    return { name: entry.name, repositoryId: entry.repositoryId, ...(entry.error ? { error: entry.error } : {}), ...(repository?.urlImport ? { code: { status: repository.urlImport.status, phase: repository.urlImport.phase } } : repository?.headSha ? { code: { status: 'ready', phase: 'complete' } } : {}), ...(job ? { data: { state: job.state, phase: job.phase, counts: job.counts } } : {}) };
  }));
  return { id: record.id, owner: record.owner, createdAt: record.createdAt, createdBy: record.createdBy, options: record.options, repositories };
}

const ORG_ROUTE = /^\/api\/github-import\/organizations(?:\/(repositories|[a-zA-Z0-9-]{1,100}))?$/;

function requireOwner(principal: Principal): void {
  if (principal.role !== 'Owner' || principal.credentialId) throw new ApiError(403, 'OWNER_REQUIRED', 'Only workspace Owners can import from GitHub.');
}

export async function handleGithubOrgImport(request: Request, url: URL, env: AppEnv, principal: Principal, ctx?: Waiter, fetcher?: typeof fetch): Promise<Response | null> {
  const match = ORG_ROUTE.exec(url.pathname);
  if (!match) return null;
  const access = securityClient(env);
  const catalog = env.GITFLARE_COORDINATOR.getByName(catalogName(principal.workspaceId));
  const headers = { 'Cache-Control': 'no-store' };
  const target = match[1];
  if (request.method === 'GET') {
    await access.authorize(principal, 'read');
    if (target === 'repositories') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use POST to list a GitHub organization’s repositories.');
    if (target) {
      const record = await catalog.githubOrgImport(target);
      if (!record) throw new ApiError(404, 'GITHUB_ORG_IMPORT_NOT_FOUND', 'This organization import could not be found.');
      return Response.json(await orgView(env, record), { headers });
    }
    return Response.json({ imports: await Promise.all((await catalog.githubOrgImports()).slice(0, 10).map(record => orgView(env, record))) }, { headers });
  }
  if (request.method !== 'POST' || (target && target !== 'repositories')) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use a supported organization import operation.');
  assertMutationOrigin(request);
  const body = await readJson(request, 16_384);
  requireOwner(principal);
  await access.authorize(principal, 'manage');
  const owner = githubTarget(body.owner, 'placeholder').owner;
  const token = body.token === undefined || body.token === '' ? null : browserOnlyToken(request, principal, body.token);
  if (target === 'repositories') {
    const page = body.page === undefined ? 1 : Number(body.page);
    if (!Number.isInteger(page) || page < 1 || page > 100) throw new ApiError(400, 'INVALID_INPUT', 'Page must be between 1 and 100.');
    await access.rateLimit(`github-org-list:${principal.userId}`, 60, 3_600_000);
    return Response.json(await listGithubRepositories(owner, page, token, fetcher), { headers });
  }
  const key = requireIdempotencyKey(request);
  const replay = await catalog.githubOrgImportRequest(key);
  if (replay) return Response.json(await orgView(env, replay), { status: 202, headers });
  if (!Array.isArray(body.repositories) || !body.repositories.length || body.repositories.length > ORG_IMPORT_MAX) throw new ApiError(400, 'INVALID_INPUT', `Choose 1 to ${ORG_IMPORT_MAX} repositories.`);
  const names = [...new Set(body.repositories.map(value => githubTarget(owner, requireString(value, 'Repository', 100)).name))];
  const options = { issues: body.issues !== false, pullRequests: body.pullRequests !== false, releases: body.releases !== false };
  const limited = await consume(env, 'GITHUB_IMPORT_RATE_LIMIT', `user:${principal.userId}`);
  if (limited) throw new ApiError(429, 'RATE_LIMITED', `Too many GitHub imports. Wait ${limited.retryAfterSeconds} seconds.`);
  const now = new Date().toISOString();
  const record: OrgImportRecord = { id: crypto.randomUUID(), requestId: key, owner, createdAt: now, createdBy: principal.userId, options, repositories: [] };
  for (const name of names) {
    try {
      const source = await inspectGithubRepository(owner, name, token, fetcher);
      const input = urlImportInput({ url: `${GITHUB_ORIGIN}/${owner}/${name}`, ...(token ? { token } : {}) }, [url.hostname]);
      const repository = await createUrlImportRepository({ env, principal, access, catalog, repositoryRecords: (id) => coordinator(env, id), fetcher }, `${key}:${name.toLowerCase()}`.slice(0, 128), input);
      const credential = token && env.AUTH_ENCRYPTION_KEY ? { kind: 'token' as const, encrypted: await encryptAuth(token, env.AUTH_ENCRYPTION_KEY, credentialContext(principal.workspaceId, repository.id)), setBy: principal.userId, setAt: now } : null;
      const job = newImportJob({ requestId: `${key}:${repository.id}`, owner, name, options, credential, keepCredential: false, sourcePrivate: source.private, principal, now });
      const started = await coordinator(env, repository.id).changeGithubImport({ kind: 'start', job });
      await register(env, repository, true);
      await dispatchImport(env, repository, started.job!, ctx, 0, fetcher);
      await access.auditRepositoryChange(principal, 'repository.github-import.start', repository.id);
      record.repositories.push({ name, repositoryId: repository.id });
    } catch (error) {
      const failure = error instanceof ApiError ? { code: error.code, message: error.detail } : { code: 'GITHUB_IMPORT_FAILED', message: 'This repository could not be imported.' };
      record.repositories.push({ name, repositoryId: null, error: failure });
    }
  }
  await catalog.saveGithubOrgImport(record);
  return Response.json(await orgView(env, record), { status: 202, headers });
}
