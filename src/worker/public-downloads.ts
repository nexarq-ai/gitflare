import type { Release } from '../shared/types';
import type { AppEnv } from './env';
import { clientIp, consume, rateLimitedResponse } from './rate-limits';
import { resolvePublicRepository } from './public-repositories';
import { serveAsset, type StoredAsset } from './release-assets';
import { securityClient } from './security';

const DOWNLOAD_PATH = /^\/([^/]+)\/([^/]+)\/releases\/download\/(.+)\/([^/]+)$/;

export async function publicDownloadResponse(request: Request, env: AppEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const match = DOWNLOAD_PATH.exec(url.pathname);
  if (!match || request.method !== 'GET' && request.method !== 'HEAD') return null;
  const notFound = () => new Response('Not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  if (!env.GITFLARE_SECURITY || !env.RELEASE_ASSETS || env.EDITION === 'self-hosted' || env.DEMO_MODE === 'true') return notFound();
  const limited = await consume(env, 'RELEASE_ASSET_RATE_LIMIT', `ip:${clientIp(request)}`);
  if (limited) return rateLimitedResponse(limited, 'downloads');
  let handle: string, name: string, tag: string, file: string;
  try { [handle, name, tag, file] = [decodeURIComponent(match[1]!).toLowerCase(), decodeURIComponent(match[2]!), match[3]!.split('/').map(decodeURIComponent).join('/'), decodeURIComponent(match[4]!)]; } catch { return notFound(); }
  const target = await resolvePublicRepository(env, securityClient(env), handle, name);
  if (!target) return notFound();
  if ('redirect' in target) return new Response(null, { status: 308, headers: { Location: `/${target.redirect}/${match[2]}/releases/download/${match[3]}/${match[4]}`, 'Cache-Control': 'no-store' } });
  const records = env.GITFLARE_COORDINATOR.getByName(`repository:${target.repository.id}`);
  const release = (await records.listReleases() as Release[]).find(item => item.tag === tag && !item.draft && item.publishedAt);
  if (!release) return notFound();
  const asset = (await records.listReleaseAssets(release.id) as StoredAsset[]).find(item => item.name === file);
  if (!asset) return notFound();
  return serveAsset(request, env.RELEASE_ASSETS, asset, 'public, max-age=300', bytes => records.chargeAssetDownload(bytes) as Promise<boolean>);
}
