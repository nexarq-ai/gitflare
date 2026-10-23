import { hostOrigins, type HostOrigins } from '../shared/hosts';
import { followsSavedTheme, isAppPath, isKnownAppRoute, isPublicProductRoute, isSiteRoute, routeFromLocation, SIGNED_IN_PRODUCT_ROUTES } from '../ui/router';
import { CLOUDFLARE_CALLBACK_PATH, CLOUDFLARE_CONNECT_STATE_COOKIE, CLOUDFLARE_SIGNIN_STATE_COOKIE, requestCookie } from './cloudflare';
import type { AppEnv } from './env';
import { streamSocialMeta, withSocialMeta } from './social-cards';
import type { ServerPage } from './public-ssr';
import { PAGE_DATA_ID } from '../ui/page-context';
import { ROOT_PLACEHOLDER } from './public-preload';

const CALLBACK_PATHS = new Set([CLOUDFLARE_CALLBACK_PATH, '/api/auth/cloudflare/callback']);

export function envHostOrigins(env: Pick<AppEnv, 'SITE_ORIGIN' | 'APP_ORIGIN'>): HostOrigins | null {
  return hostOrigins(env.SITE_ORIGIN, env.APP_ORIGIN);
}

export function exploreLocation(search: string): string {
  const query = new URLSearchParams(search).get('q')?.trim();
  return query ? `/explore?${new URLSearchParams({ q: query.slice(0, 100) })}` : '/explore';
}

function redirect(location: string, status: number): Response {
  return new Response(null, { status, headers: { Location: location, 'Cache-Control': status === 301 ? 'public, max-age=3600' : 'no-store' } });
}

export async function hostRedirect(request: Request, env: AppEnv, signedIn: (request: Request) => Promise<boolean>): Promise<Response | null> {
  const origins = envHostOrigins(env);
  if (!origins) return null;
  const url = new URL(request.url);
  const { pathname: path, search } = url;
  const read = request.method === 'GET' || request.method === 'HEAD';
  if (url.origin === origins.app) {
    if (!read) return null;
    if (path === '/') return redirect(await signedIn(request) ? '/overview' : '/signin', 302);
    const route = routeFromLocation(path, '');
    if (!isAppPath(path) || !isPublicProductRoute(route)) return null;
    if (!SIGNED_IN_PRODUCT_ROUTES.includes(route)) return redirect(`${origins.site}${path}${search}`, 301);
    if (await signedIn(request)) return null;
    return redirect(`${origins.site}${route === 'repositories' ? exploreLocation(search) : `${path}${search}`}`, 302);
  }
  if (url.origin !== origins.site) return null;
  const toApp = `${origins.app}${path}${search}`;
  if (path === '/mcp' || path.startsWith('/oauth/') || path.startsWith('/.well-known/oauth-')) return redirect(toApp, 308);
  if (CALLBACK_PATHS.has(path)) {
    const startedHere = requestCookie(request, CLOUDFLARE_SIGNIN_STATE_COOKIE) || requestCookie(request, CLOUDFLARE_CONNECT_STATE_COOKIE);
    return startedHere ? null : redirect(toApp, read ? 302 : 308);
  }
  if (path.startsWith('/api/auth/')) return path === '/api/auth/config' ? null : redirect(toApp, read ? 302 : 308);
  if (!read || !isAppPath(path)) return null;
  const route = routeFromLocation(path, '');
  if (route === 'repositories') return redirect(exploreLocation(search), 301);
  return isKnownAppRoute(route) && !isSiteRoute(route) ? redirect(toApp, 302) : null;
}

export function withConnectSource(policy: string, origin: string): string {
  return policy.replace(/connect-src ([^;]*)/, (directive, sources: string) => sources.split(/\s+/).includes(origin) ? directive : `connect-src ${sources} ${origin}`);
}

const SERVER_RENDERED_ATTRIBUTE = 'data-ssr';

function originMeta(origins: HostOrigins | null, pathname: string): string {
  return origins ? `<meta name="gitflare-app-origin" content="${origins.app}"><meta name="gitflare-site-origin" content="${origins.site}">${pathname && followsSavedTheme(routeFromLocation(pathname, '')) ? '<meta name="gitflare-theme" content="system">' : ''}` : '';
}

function documentHeaders(response: Response, origins: HostOrigins | null): Headers {
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.delete('ETag');
  const policy = headers.get('Content-Security-Policy');
  if (origins && policy) headers.set('Content-Security-Policy', withConnectSource(policy, origins.app));
  return headers;
}

async function streamServerPage(response: Response, origins: HostOrigins | null, pathname: string, head: string | Promise<string>, searchTags: string, rendered: Promise<ServerPage | null>): Promise<Response> {
  const html = await response.text();
  const headers = documentHeaders(response, origins);
  headers.set('Cache-Control', 'private, no-cache');
  headers.append('Vary', 'Cookie');
  const page = rendered.catch(() => null);
  const appended = page.then(value => `${searchTags}${value?.status === 200 ? value.head : ''}${originMeta(origins, pathname)}`);
  const stream = streamSocialMeta(html, appended, Promise.resolve(head), rest => page.then(value => withServerPage(rest, value)));
  if (stream) return new Response(stream, { status: 200, headers });
  const value = await page;
  return new Response(withServerPage(withSocialMeta(html, await Promise.resolve(head).catch(() => '')), value).replace('</head>', `${await appended}</head>`), { status: 200, headers });
}

export function withServerPage(html: string, page: ServerPage | null): string {
  if (page?.status !== 200 || !page.body) return html;
  const data = page.seed ? `<script type="application/json" id="${PAGE_DATA_ID}">${page.seed}</script>` : '';
  return html.replace(ROOT_PLACEHOLDER, () => `<div id="root" ${SERVER_RENDERED_ATTRIBUTE}>${page.body}</div>${data}`);
}

export async function withHostOrigins(response: Response, env: AppEnv, pathname = '', head: string | Promise<string> = '', searchTags = '', rendered: ServerPage | Promise<ServerPage | null> | null = null): Promise<Response> {
  const origins = envHostOrigins(env);
  if ((!origins && !searchTags && !rendered) || response.status !== 200 || !response.headers.get('Content-Type')?.includes('text/html')) return response;
  if (rendered instanceof Promise) return streamServerPage(response, origins, pathname, head, searchTags, rendered);
  const page = rendered;
  const html = withServerPage(await response.text(), page);
  const headers = documentHeaders(response, origins);
  const meta = `${searchTags}${page?.status === 200 ? page.head : ''}${originMeta(origins, pathname)}`;
  if (page?.status === 404) headers.set('Cache-Control', 'no-store');
  if (page?.status === 200 && page.body) { headers.set('Cache-Control', 'private, no-cache'); headers.append('Vary', 'Cookie'); }
  const init = page?.status === 404 ? { status: 404, statusText: 'Not Found', headers } : { status: response.status, statusText: response.statusText, headers };
  const streamed = typeof head === 'string' ? null : streamSocialMeta(html, meta, head);
  if (streamed) return new Response(streamed, init);
  return new Response(withSocialMeta(html, typeof head === 'string' ? head : await head.catch(() => '')).replace('</head>', `${meta}</head>`), init);
}
