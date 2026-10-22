import { hostOrigins, type HostOrigins } from '../shared/hosts';
import { followsSavedTheme, isAppPath, isKnownAppRoute, isPublicProductRoute, isSiteRoute, routeFromLocation, SIGNED_IN_PRODUCT_ROUTES } from '../ui/router';
import { CLOUDFLARE_CALLBACK_PATH, CLOUDFLARE_CONNECT_STATE_COOKIE, CLOUDFLARE_SIGNIN_STATE_COOKIE, requestCookie } from './cloudflare';
import type { AppEnv } from './env';
import { withSocialMeta } from './social-cards';

const CALLBACK_PATHS = new Set([CLOUDFLARE_CALLBACK_PATH, '/api/auth/cloudflare/callback']);

export function envHostOrigins(env: Pick<AppEnv, 'SITE_ORIGIN' | 'APP_ORIGIN'>): HostOrigins | null {
  return hostOrigins(env.SITE_ORIGIN, env.APP_ORIGIN);
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
    return await signedIn(request) ? null : redirect(`${origins.site}${path}${search}`, 302);
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
  return isKnownAppRoute(route) && !isSiteRoute(route) ? redirect(toApp, 302) : null;
}

export async function withHostOrigins(response: Response, env: AppEnv, pathname = '', head = ''): Promise<Response> {
  const origins = envHostOrigins(env);
  if (!origins || response.status !== 200 || !response.headers.get('Content-Type')?.includes('text/html')) return response;
  const html = await response.text();
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.delete('ETag');
  return new Response(withSocialMeta(html, head).replace('</head>', `<meta name="gitflare-app-origin" content="${origins.app}"><meta name="gitflare-site-origin" content="${origins.site}">${pathname && followsSavedTheme(routeFromLocation(pathname, '')) ? '<meta name="gitflare-theme" content="system">' : ''}</head>`), { status: response.status, statusText: response.statusText, headers });
}
