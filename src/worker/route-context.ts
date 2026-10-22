import { logFailure } from './log';
import type { AiSettings, Mission, Repository } from '../shared/types';
import { repositoryHead } from './artifacts';
import { ApiError } from './domain';
import type { AppEnv } from './env';
import type { Principal, SecurityService } from './security';
import type { ReleaseExtras } from './releases';
import { assetView, usage as assetUsage, type StoredAsset } from './release-assets';
import { releaseAdvisories } from './advisories';
import { landingRule } from './branch-protection';
import { publicUrls, siteOrigin } from './public-repositories';
import type { OutsideContext } from './outside-proposals';
import { autoTriage } from './agent-assist';
import type { GitflareCoordinator } from './coordinator';

export interface RouteContext {
  request: Request;
  url: URL;
  env: AppEnv;
  ctx?: ExecutionContext;
  principal: Principal;
  access: SecurityService;
  catalog: DurableObjectStub<GitflareCoordinator>;
  local: boolean;
}

export function records(env: AppEnv, repositoryId: string) { return env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`); }

export async function requireRepository<T>(catalog: { getRepository(id: string): Promise<T | undefined> }, id: string): Promise<T> {
  const repository = await catalog.getRepository(id);
  if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
  return repository;
}

export function outsideContext({ env, principal, access }: RouteContext): OutsideContext {
  return { env, principal, access, catalogOf: (workspaceId) => env.GITFLARE_COORDINATOR.getByName(catalogName(workspaceId)), records: (id) => records(env, id) };
}

export async function publicRepositoryBase(env: AppEnv, access: { publicListing(id: string): Promise<unknown>; handleOf(workspaceId: string): Promise<string | null> }, repository: Repository, origin: string): Promise<string | null> {
  const [listing, handle] = await Promise.all([access.publicListing(repository.id).catch(() => null), access.handleOf(repository.workspaceId ?? 'legacy').catch(() => null)]);
  return listing && handle ? publicUrls(siteOrigin(env, origin), handle, repository).url : null;
}

export async function releaseExtras(env: AppEnv, access: Parameters<typeof publicRepositoryBase>[1], repository: Repository, origin: string): Promise<ReleaseExtras> {
  const records = env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`);
  const publicBase = await publicRepositoryBase(env, access, repository, origin);
  return {
    decorate: async releases => {
      const [assets, advisories] = await Promise.all([records.listReleaseAssets(), records.listAdvisories()]);
      return releases.map(release => ({ ...release, assets: (assets as StoredAsset[]).filter(asset => asset.releaseId === release.id).map(asset => assetView(asset, repository.id, publicBase, release)), advisories: releaseAdvisories(advisories, release.id) }));
    },
    usage: async () => assetUsage(env.RELEASE_ASSETS, await records.releaseAssetUsage()),
    deleted: async release => {
      const removed = await records.removeReleaseAssets(release.id) as StoredAsset[];
      if (env.RELEASE_ASSETS && removed.length) await env.RELEASE_ASSETS.delete(removed.map(asset => asset.objectKey));
    },
  };
}

export function catalogName(workspaceId: string) { return workspaceId === 'legacy' ? 'catalog:owner' : `catalog:${workspaceId}`; }
export async function landingReviewRule(env: AppEnv, repository: Repository) { return landingRule(await records(env, repository.id).getBranchProtection(), repository.defaultBranch); }

export async function optional<T>(read: () => Promise<T>): Promise<T | undefined> { try { return await read(); } catch { return undefined; } }

export async function findMission(env: AppEnv, missionId: string, workspaceId: string): Promise<{ mission: Mission; repository: Repository }> {
  const catalog = env.GITFLARE_COORDINATOR.getByName(catalogName(workspaceId));
  const indexed = await optional(() => catalog.missionRepository(missionId));
  const repository = indexed ? await catalog.getRepository(indexed) : undefined;
  const mission = repository ? await records(env, repository.id).getMission(missionId) : undefined;
  if (repository && mission) return { mission, repository };
  const repositories = await catalog.listRepositories();
  const candidates = await Promise.all(repositories.map(async (item) => ({ repository: item, mission: await records(env, item.id).getMission(missionId) })));
  const found = candidates.find((item) => item.mission);
  if (!found?.mission) throw new ApiError(404, 'MISSION_NOT_FOUND', 'This mission could not be found.');
  await optional(() => catalog.indexMission(missionId, found.repository.id));
  return { mission: found.mission, repository: found.repository };
}

export async function currentRepository(env: AppEnv, repository: Repository): Promise<Repository> {
  if (repository.provider !== 'artifacts' || !env.ARTIFACTS) throw new ApiError(409, 'REPOSITORY_NOT_CONNECTED', 'This is a local workspace record. Create a connected Artifacts repository before running agents.');
  const updated = { ...repository, headSha: await repositoryHead(env.ARTIFACTS, repository.name, repository.defaultBranch), updatedAt: new Date().toISOString() };
  await records(env, repository.id).saveRepository(updated);
  await env.GITFLARE_COORDINATOR.getByName(catalogName(repository.workspaceId ?? 'legacy')).saveRepository(updated);
  return updated;
}

export async function workspaceName(env: AppEnv, access: { workspace(principal: Principal): Promise<{ name: string }> }, principal: Principal): Promise<string> {
  return principal.workspaceId === 'legacy' && env.WORKSPACE_NAME ? env.WORKSPACE_NAME : (await access.workspace(principal)).name;
}

export async function inBackground(ctx: ExecutionContext | undefined, work: Promise<unknown>): Promise<void> {
  if (ctx) ctx.waitUntil(work); else await work;
}

export async function triageCreated(request: Request, response: Response, env: AppEnv, ctx?: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST' || response.status !== 201 || !/\/issues$/.test(new URL(request.url).pathname)) return response;
  const created = await response.clone().json().catch(() => null) as { repositoryId?: unknown; number?: unknown } | null;
  if (typeof created?.repositoryId === 'string' && typeof created.number === 'number') {
    await inBackground(ctx, autoTriage(env, created.repositoryId, created.number));
  }
  return response;
}

const AI_SETTINGS_UNAVAILABLE_MESSAGE = 'Gitflare could not read whether AI features are on for this workspace, so they stay off until it can. Wait a moment and try again.';

export async function aiSettings(env: AppEnv, catalog: { getAiEnabled(): Promise<boolean> }): Promise<AiSettings> {
  const locked = env.AI_FEATURES === 'disabled';
  if (locked) return { enabled: false, locked };
  try { return { enabled: await catalog.getAiEnabled(), locked }; }
  catch (error) {
    logFailure('ai_settings_read_failed', error);
    return { enabled: false, locked, unavailable: true };
  }
}

export async function requireAi(env: AppEnv, catalog: { getAiEnabled(): Promise<boolean> }): Promise<void> {
  const settings = await aiSettings(env, catalog);
  if (settings.unavailable) throw new ApiError(503, 'AI_SETTINGS_UNAVAILABLE', AI_SETTINGS_UNAVAILABLE_MESSAGE);
  if (!settings.enabled) throw new ApiError(403, 'AI_DISABLED', 'AI features are turned off for this workspace. An Owner can turn them on in Settings.');
}
