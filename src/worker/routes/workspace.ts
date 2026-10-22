import { logFailure } from '../log';
import type { IntegrationStatus, Workspace } from '../../shared/types';
import { repositoryLabel } from '../../shared/repository-names';
import type { AppEnv } from '../env';
import { publicPrincipal } from '../security';
import { collectMissionSummaries } from '../workspace-summaries';
import { type RouteContext, records, workspaceName, aiSettings } from '../route-context';

function integrations(env: AppEnv, local: boolean): IntegrationStatus[] {
  const modelConfigured = !!(env.MODEL && env.AI && env.AI_GATEWAY_ID);
  return [
    { id: 'artifacts', name: 'Cloudflare Artifacts', ready: !!env.ARTIFACTS, detail: env.ARTIFACTS ? 'Repository binding configured' : 'Connect Artifacts to create Git repositories and isolated forks' },
    { id: 'sandbox', name: 'Cloudflare Sandbox', ready: !!env.SANDBOX, detail: env.SANDBOX ? 'Isolated execution binding configured' : 'Connect Sandbox to run agents and tests' },
    { id: 'model', name: 'AI model', ready: modelConfigured, detail: modelConfigured ? 'Gateway configured; provider credentials are verified when a mission runs' : 'Configure AI Gateway with a provider key and model' },
    { id: 'auth', name: 'Workspace authentication', ready: !local && !!env.GITFLARE_SECURITY, detail: local ? 'Localhost development access only' : 'Account authentication enabled' },
  ];
}

async function seedLocal(env: AppEnv): Promise<void> {
  const catalog = env.GITFLARE_COORDINATOR.getByName('catalog:owner');
  if ((await catalog.listRepositories()).length) return;
  const now = new Date().toISOString();
  const repository = await catalog.createRepository('local-seed-repository-v1', {
    id: 'local-example', name: 'edge-store', description: 'Local workspace example. Connect Artifacts to add source code and run agents.',
    defaultBranch: 'main', headSha: null, provider: 'local', createdAt: now, updatedAt: now,
  });
  const coordinator = records(env, repository.id);
  await coordinator.saveRepository(repository);
  await coordinator.createMission('local-seed-mission-v1', { repositoryId: repository.id, title: 'Make checkout resilient to retries', prompt: 'Add idempotent checkout handling and improve compatibility around order creation. Verify independent agent changes together before review.' });
}

export async function workspaceSnapshot(context: RouteContext): Promise<Response> {
  const { env, ctx, principal, access, catalog, local } = context;
  const started = Date.now();
  if (local) await seedLocal(env);
  const [, repositories, name, ai, cached, handle] = await Promise.all([
    access.authorizeMetadata(principal),
    catalog.listRepositories(),
    workspaceName(env, access, principal),
    aiSettings(env, catalog),
    Promise.resolve().then(() => catalog.listSummaryCache()).catch(() => []),
    access.handleOf(principal.workspaceId).catch(() => null),
  ]);
  const catalogMs = Date.now() - started;
  const deferred: Promise<unknown>[] = [];
  const { summaries, stale } = await collectMissionSummaries(repositories.map(repository => repository.id), {
    live: id => records(env, id).listMissionSummaries(),
    cached,
    save: entries => catalog.saveSummaryCache(entries),
    defer: work => { const settled = work.catch(error => logFailure('workspace_summary_cache_failed', error, {}, 'warn')); if (ctx) ctx.waitUntil(settled); else deferred.push(settled); },
  });
  const summariesMs = Date.now() - started - catalogMs;
  const repositoryResources = repositories.map(repository => ({ resourceType: 'repository', resourceId: repository.id }));
  const [allowed, published] = await Promise.all([
    access.checkMany(principal, 'read', [...repositoryResources, ...summaries.map(mission => ({ resourceType: 'repository', resourceId: mission.repositoryId, missionId: mission.id }))]),
    access.checkMany(publicPrincipal(principal.workspaceId), 'read', repositoryResources).catch(() => repositoryResources.map(() => false)),
  ]);
  const visible = repositories.flatMap((repository, index) => allowed[index] ? [{ ...repository, visibility: published[index] ? 'public' as const : 'private' as const }] : []);
  const visibleIds = new Set(visible.map(repository => repository.id));
  const missions = summaries.filter((mission, index) => allowed[repositories.length + index] && visibleIds.has(mission.repositoryId));
  const workspace: Workspace = { id: principal.workspaceId, name, mode: local ? 'local' : 'connected', repositories: visible.map(repository => ({ ...repository, displayName: repositoryLabel(repository) })), missions: missions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), integrations: integrations(env, local), ai, handle };
  console.log(JSON.stringify({ event: 'workspace_timing', repositories: repositories.length, missions: summaries.length, staleRepositories: stale, catalogMs, summariesMs, accessMs: Date.now() - started - catalogMs - summariesMs, totalMs: Date.now() - started }));
  await Promise.all(deferred);
  return Response.json(workspace);
}
