import { hostOrigins } from '../shared/hosts';
import type { AppEnv } from './env';
import { clientIp, consume, rateLimitedResponse } from './rate-limits';
import { sessionCookieValue } from './session-policy';
import { securityClient } from './security';

export const CACHE_DEPENDENCIES = 'X-Gitflare-Cache-Repositories';
export const PUBLIC_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=600';
const CACHE_PREFIX = '/__gitflare-public-cache/v1';
const CACHEABLE = /^\/api\/public\/(?:repos\/[^/]+\/[^/]+(?:\/(?!(?:issues|security|advisories)$)[a-z]+)?|explore|search|profiles\/[^/]+(?:\/activity)?)$/;
const DEPENDENCY_MAX = 100;

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
  headers.set('X-Gitflare-Cache', state);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function enabled(env: CacheEnv): boolean {
  return env.EDITION !== 'self-hosted' && env.DEMO_MODE !== 'true';
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
    if (listings && listings.every(Boolean)) return forClient(cached, 'hit');
    await cache.delete(key).catch(() => false);
  }
  const response = await produce();
  if (response.status !== 200 || response.headers.has('Set-Cookie')) return forClient(response, 'miss');
  const stored = new Headers(response.headers);
  stored.set('Cache-Control', PUBLIC_CACHE_CONTROL);
  const body = await response.arrayBuffer();
  const put = cache.put(key, new Response(body, { status: 200, headers: stored })).catch(() => undefined);
  if (ctx) ctx.waitUntil(put); else await put;
  return forClient(new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }), 'miss');
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
