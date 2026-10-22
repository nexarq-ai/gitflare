import { releaseApi } from '../releases';
import { releaseAssetsApi } from '../release-assets';
import { advisoriesApi } from '../advisories';
import { triggerMirrorSync } from '../github-mirror-runtime';
import { notifyReleased } from '../subscription-notifications';
import type { Release } from '../../shared/types';
import { type RouteContext, records, requireRepository, publicRepositoryBase, releaseExtras, inBackground } from '../route-context';

export async function releaseRoutes(context: RouteContext): Promise<Response | null> {
  const { request, url, env, ctx, principal, access, catalog } = context;
  const assetRoute = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/releases\/([a-zA-Z0-9-]+)\/assets(?:\/([a-f0-9]{32})(?:\/(delete))?)?$/.exec(url.pathname);
  if (assetRoute) {
    const repository = await requireRepository(catalog, assetRoute[1]!);
    return releaseAssetsApi(request, { bucket: env.RELEASE_ASSETS, repository, records: records(env, repository.id), principal, access, publicBase: await publicRepositoryBase(env, access, repository, url.origin) }, assetRoute[2]!, assetRoute[3], assetRoute[4]);
  }
  const advisoryRoute = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/advisories(?:\/([A-Za-z0-9-]{1,40})(?:\/(update|publish|close|reopen|comment|collaborators))?)?$/.exec(url.pathname);
  if (advisoryRoute) {
    const repository = await requireRepository(catalog, advisoryRoute[1]!);
    return advisoriesApi(request, { repository, principal, access, records: records(env, repository.id) }, advisoryRoute[2], advisoryRoute[3]);
  }
  const releaseRoute = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/releases(?:\/([a-zA-Z0-9-]+)(?:\/(publish|update|delete))?)?$/.exec(url.pathname);
  if (releaseRoute) {
    const repository = await requireRepository(catalog, releaseRoute[1]);
    const records = env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`);
    const released = await releaseApi(request, { artifacts: env.ARTIFACTS, repository, coordinator: records, principal, access, extras: await releaseExtras(env, access, repository, url.origin) }, releaseRoute[2], releaseRoute[3]);
    if (request.method === 'POST' && released.ok) await inBackground(ctx, triggerMirrorSync(env, repository.id, principal.workspaceId, 'release', undefined, ctx));
    if (request.method === 'POST' && released.ok && (!releaseRoute[2] || releaseRoute[3] === 'publish')) {
      const release = await released.clone().json().catch(() => null) as Release | null;
      if (release?.publishedAt) await inBackground(ctx, notifyReleased(env, access, ctx, repository, release));
    }
    return released;
  }
  return null;
}
