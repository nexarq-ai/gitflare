import { publicPageRequests } from '../ui/public-requests';
import { publicProfileLocation, publicRepositoryLocation, publicShellRoute, routeFromLocation } from '../ui/router';
import { ROUTE_MODULES_MARKER, type RouteModuleName, type RouteModules } from '../shared/route-modules';
import { hostOrigins } from '../shared/hosts';
import type { AppEnv } from './env';

export const ROOT_PLACEHOLDER = '<div id="root"></div>';
const ROUTE_MODULES = new RegExp(`<!--${ROUTE_MODULES_MARKER}([^]*?)-->\\n?`);

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}

export function publicPreloadTags(url: URL): string {
  return publicPageRequests(url.pathname, url.search).map(href => `<link rel="preload" as="fetch" crossorigin href="${escapeAttribute(href)}">`).join('');
}

export function injectPreloads(html: string, tags: string): string {
  const charset = /<meta charset=[^>]*>/i.exec(html);
  const head = html.indexOf('<head>');
  const at = charset ? charset.index + charset[0].length : head < 0 ? -1 : head + '<head>'.length;
  return at < 0 ? html : `${html.slice(0, at)}${tags}${html.slice(at)}`;
}

export function publicShellVisit(request: Request, env: Pick<AppEnv, 'SITE_ORIGIN' | 'APP_ORIGIN'>): boolean {
  const origins = hostOrigins(env.SITE_ORIGIN, env.APP_ORIGIN);
  return !!origins && new URL(request.url).origin === origins.site;
}

export function routeModuleNames(url: URL, publicShell: boolean): RouteModuleName[] {
  const route = routeFromLocation(url.pathname, '');
  const page: RouteModuleName | null = publicRepositoryLocation(route) ? 'repository' : publicProfileLocation(route) ? 'profile' : route === 'explore' ? 'explore' : route === 'search' ? 'search' : route === 'home' ? 'home' : null;
  return [publicShell && publicShellRoute(route) ? 'public' : 'app', ...(page ? [page] : [])];
}

export function injectRouteModules(html: string, names: RouteModuleName[], applyStyles = false): string {
  const match = ROUTE_MODULES.exec(html);
  if (!match) return html;
  let modules: RouteModules;
  try { modules = JSON.parse(match[1]!) as RouteModules; } catch { return html.replace(ROUTE_MODULES, ''); }
  const js = new Set(names.flatMap(name => modules[name]?.js ?? []));
  const css = new Set(names.flatMap(name => modules[name]?.css ?? []));
  const scripts = [...js].map(href => `<link rel="modulepreload" crossorigin href="${escapeAttribute(href)}">`).join('');
  if (applyStyles) {
    const sheets = [...css].map(href => `<link rel="stylesheet" crossorigin href="${escapeAttribute(href)}">`).join('');
    return html.replace(ROUTE_MODULES, '').replace('</head>', () => `${sheets}</head>`);
  }
  return html.replace(ROUTE_MODULES, () => `${scripts}${[...css].map(href => `<link rel="preload" as="style" crossorigin href="${escapeAttribute(href)}">`).join('')}`);
}

export async function withPublicPreloads(request: Request, env: Pick<AppEnv, 'EDITION' | 'DEMO_MODE' | 'SITE_ORIGIN' | 'APP_ORIGIN'>, response: Response, serverRendered = false): Promise<Response> {
  if (env.EDITION === 'self-hosted' || env.DEMO_MODE === 'true' || request.method !== 'GET' || response.status !== 200 || !response.headers.get('Content-Type')?.includes('text/html')) return response;
  const url = new URL(request.url);
  const source = await response.text();
  const hydrates = serverRendered && source.includes(ROOT_PLACEHOLDER);
  const modules = injectRouteModules(source, routeModuleNames(url, publicShellVisit(request, env)), hydrates);
  const html = hydrates ? modules : injectPreloads(modules, publicPreloadTags(url));
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.delete('ETag');
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}
