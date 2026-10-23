import type { AppEnv } from './env';
import { envHostOrigins } from './host-split';

export type SearchRole = 'site' | 'app' | 'hidden';
type SearchEnv = Pick<AppEnv, 'EDITION' | 'DEMO_MODE' | 'SITE_ORIGIN' | 'APP_ORIGIN'>;

export const NOINDEX = 'noindex, nofollow';
export const APP_TITLE = 'Gitflare app';
export const APP_DESCRIPTION = 'Sign in to your Gitflare workspace.';
const CRAWLABLE = 'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /mcp\nDisallow: /oauth/\n';
const UNCRAWLABLE = 'User-agent: *\nDisallow: /\n';
const NOINDEX_CRAWLABLE = 'User-agent: *\nAllow: /\n';
const APP_ENTRY_PATHS = new Set(['/', '/signin', '/signup']);

const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

export function searchRole(env: SearchEnv, origin: string): SearchRole {
  if (env.DEMO_MODE === 'true') return 'hidden';
  if (env.EDITION === 'self-hosted') return 'site';
  const origins = envHostOrigins(env);
  return origins?.site === origin ? 'site' : origins?.app === origin ? 'app' : 'hidden';
}

export function robotsTxt(env: SearchEnv, origin: string): string {
  const role = searchRole(env, origin);
  // Crawlers must fetch app pages to see their noindex; a Disallow would keep already-indexed URLs listed
  if (role === 'app') return NOINDEX_CRAWLABLE;
  if (role !== 'site') return UNCRAWLABLE;
  return env.EDITION === 'self-hosted' ? CRAWLABLE : `${CRAWLABLE}Sitemap: ${origin}/sitemap.xml\n`;
}

export function robotsResponse(request: Request, env: SearchEnv): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== '/robots.txt' || (request.method !== 'GET' && request.method !== 'HEAD')) return null;
  return new Response(request.method === 'HEAD' ? null : robotsTxt(env, url.origin), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
}

export function canonicalPath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

export function canonicalLink(href: string): string {
  return `<link rel="canonical" href="${escape(href)}">`;
}

export function appHeadTags(): string {
  return `<title>${APP_TITLE}</title><meta name="description" content="${APP_DESCRIPTION}">`;
}

export function searchHeadTags(request: Request, env: SearchEnv): string {
  const url = new URL(request.url);
  const role = searchRole(env, url.origin);
  if (role === 'site') return `${url.pathname === '/search' ? '<meta name="robots" content="noindex, follow">' : ''}${canonicalLink(`${url.origin}${canonicalPath(url.pathname)}`)}`;
  const robots = `<meta name="robots" content="${NOINDEX}">`;
  const site = envHostOrigins(env)?.site;
  return role === 'app' && site && APP_ENTRY_PATHS.has(canonicalPath(url.pathname)) ? `${robots}${canonicalLink(`${site}/`)}` : robots;
}

export function withSearchIndexing(request: Request, response: Response, env: SearchEnv): Response {
  if (response.status === 101 || !response.headers.get('Content-Type')?.includes('text/html')) return response;
  if (searchRole(env, new URL(request.url).origin) === 'site') return response;
  const marked = new Response(response.body, response);
  marked.headers.set('X-Robots-Tag', NOINDEX);
  return marked;
}
