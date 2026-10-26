import { hostOrigins } from '../shared/hosts';
import type { AppEnv } from './env';
import { clientIp, consume, rateLimitedResponse } from './rate-limits';
import { sessionCookieValue } from './session-policy';
import { securityClient } from './security';

export const CACHE_DEPENDENCIES = 'X-Gitflare-Cache-Repositories';
export const PUBLIC_CACHE_FRESH_MS = 60_000;
export const PUBLIC_CACHE_CONTROL = 'public, s-maxage=660';
const CACHED_AT = 'X-Gitflare-Cached-At';
const CACHE_PREFIX = '/__gitflare-public-cache/v1';
const CACHEABLE = /^\/api\/public\/(?:repos\/[^/]+\/[^/]+(?:\/(?!(?:issues|security|advisories)$)[a-z]+)?|explore|search|profiles\/[^/]+(?:\/activity)?)$/;
const DEPENDENCY_MAX = 100;
const COMMIT_CACHE_CONTROL = 'public, s-maxage=2592000';
const COMMIT_SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

type CacheEnv = Pick<AppEnv, 'EDITION' | 'DEMO_MODE' | 'SITE_ORIGIN' | 'APP_ORIGIN' | 'GITFLARE_SECURITY'> & Partial<Pick<AppEnv, 'PUBLIC_READ_RATE_LIMIT'>>;
type Waiter = { waitUntil(promise: Promise<unknown>): void } | undefined;

function edgeCache(): Cache | null {
  return typeof caches === 'undefined' ? null : (caches as unknown as { default?: Cache }).default ?? null;
}

export function isPublicCachePath(pathname: string): boolean { return CACHEABLE.test(pathname); }

export function anonymousRequest(request: Request): boolean {
  return !request.headers.has('Authorization') && !sessionCookieValue(request) && !request.headers.has('X-Gitflare-Workspace');
}

export function publicCacheKey(url: URL): Request {
  const params = [...url.searchParams].sort(([a, av], [b, bv]) => a === b ? av.localeCompare(bv) : a.localeCompare(b));
  const query = new URLSearchParams(params).toString();
  return new Request(`${url.origin}${CACHE_PREFIX}${url.pathname}${query ? `?${query}` : ''}`, { method: 'GET' });
}

function dependencies(response: Response): string[] {
  return (response.headers.get(CACHE_DEPENDENCIES) ?? '').split(',').map(value => value.trim()).filter(Boolean).slice(0, DEPENDENCY_MAX);
}

function forClient(response: Response, state: 'hit' | 'miss' | 'bypass'): Response {
  const headers = new Headers(response.headers);
  headers.delete(CACHE_DEPENDENCIES);
  headers.delete(CACHED_AT);
  headers.set('X-Gitflare-Cache', state);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function enabled(env: CacheEnv): boolean {
  return env.EDITION !== 'self-hosted' && env.DEMO_MODE !== 'true';
}

function storable(response: Response): boolean {
  return response.status === 200 && !response.headers.has('Set-Cookie');
}

function cacheCopy(response: Response, body: ArrayBuffer): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', PUBLIC_CACHE_CONTROL);
  headers.set(CACHED_AT, String(Date.now()));
  return new Response(body, { status: 200, headers });
}

function stale(cached: Response): boolean {
  const at = Number(cached.headers.get(CACHED_AT));
  return !at || Date.now() - at >= PUBLIC_CACHE_FRESH_MS;
}

const revalidating = new Set<string>();

function revalidate(cache: Cache, key: Request, ctx: NonNullable<Waiter>, produce: () => Promise<Response>): void {
  if (revalidating.has(key.url)) return;
  revalidating.add(key.url);
  ctx.waitUntil(produce().then(async response => {
    if (storable(response)) await cache.put(key, cacheCopy(response, await response.arrayBuffer()));
    else { await response.body?.cancel(); await cache.delete(key); }
  }).catch(() => undefined).finally(() => revalidating.delete(key.url)));
}

export async function servePublicCached(request: Request, env: CacheEnv, ctx: Waiter, produce: () => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  const cache = request.method === 'GET' && enabled(env) && isPublicCachePath(url.pathname) && anonymousRequest(request) ? edgeCache() : null;
  if (!cache) return forClient(await produce(), 'bypass');
  const key = publicCacheKey(url);
  const cached = await cache.match(key).catch(() => undefined);
  if (cached) {
    const limited = await consume(env as AppEnv, 'PUBLIC_READ_RATE_LIMIT', `ip:${clientIp(request)}`);
    if (limited) return rateLimitedResponse(limited, 'public repository requests');
    const ids = dependencies(cached);
    const listings = ids.length && env.GITFLARE_SECURITY ? await securityClient(env as AppEnv).publicListed(ids).catch(() => null) : [];
    const expired = stale(cached);
    if (listings && listings.every(Boolean) && (ctx || !expired)) {
      if (ctx && expired) revalidate(cache, key, ctx, produce);
      return forClient(cached, 'hit');
    }
    await cache.delete(key).catch(() => false);
  }
  const response = await produce();
  if (!storable(response)) return forClient(response, 'miss');
  const body = await response.arrayBuffer();
  const put = cache.put(key, cacheCopy(response, body)).catch(() => undefined);
  if (ctx) ctx.waitUntil(put); else await put;
  return forClient(new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }), 'miss');
}

export function commitCacheKey(origin: string, repositoryId: string, commitSha: string, part: string): Request {
  return new Request(`${origin}${CACHE_PREFIX}/commits/${encodeURIComponent(repositoryId)}/${commitSha}/${encodeURIComponent(part)}`, { method: 'GET' });
}

export interface CommitValue<T> { value: T; cacheable: boolean }

export async function cachedAtCommit<T>(env: CacheEnv, origin: string, repositoryId: string, commitSha: string, part: string, produce: () => Promise<CommitValue<T>>): Promise<T> {
  const cache = enabled(env) && COMMIT_SHA.test(commitSha) ? edgeCache() : null;
  if (!cache) return (await produce()).value;
  const key = commitCacheKey(origin, repositoryId, commitSha, part);
  const cached = await cache.match(key).catch(() => undefined);
  const hit = cached ? await cached.json().catch(() => undefined) as T | undefined : undefined;
  if (hit !== undefined) return hit;
  const { value, cacheable } = await produce();
  if (cacheable) await cache.put(key, Response.json(value, { headers: { 'Cache-Control': COMMIT_CACHE_CONTROL } })).catch(() => undefined);
  return value;
}

export function publicCacheOrigins(env: Pick<AppEnv, 'SITE_ORIGIN' | 'APP_ORIGIN'>, fallback?: string): string[] {
  const origins = hostOrigins(env.SITE_ORIGIN, env.APP_ORIGIN);
  return [...new Set([origins?.site, origins?.app, fallback].filter((value): value is string => !!value))];
}

export function repositoryCachePaths(handle: string, name: string): string[] {
  const base = `/api/public/repos/${encodeURIComponent(handle)}/${encodeURIComponent(name)}`;
  return [base, `${base}/tree`, `${base}/readme`, `${base}/branches`, `${base}/releases`, `${base}/activity`, `${base}/history`, `${base}/history?limit=50`, ...discoveryCachePaths(handle)];
}

export function discoveryCachePaths(handle: string): string[] {
  return [`/api/public/profiles/${encodeURIComponent(handle)}`, `/api/public/profiles/${encodeURIComponent(handle)}/activity`, '/api/public/explore', '/api/public/explore?sort=stars', '/api/public/explore?sort=new', '/api/public/explore?sort=updated'];
}

export async function purgePublicCache(env: CacheEnv, paths: string[], fallbackOrigin?: string): Promise<number> {
  const cache = enabled(env) ? edgeCache() : null;
  if (!cache) return 0;
  const keys = publicCacheOrigins(env, fallbackOrigin).flatMap(origin => paths.map(path => publicCacheKey(new URL(path, origin))));
  const results = await Promise.all(keys.map(key => cache.delete(key).catch(() => false)));
  return results.filter(Boolean).length;
}
