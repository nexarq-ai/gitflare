import { publicPageRequests } from '../ui/public-requests';
import type { AppEnv } from './env';

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

export async function withPublicPreloads(request: Request, env: Pick<AppEnv, 'EDITION' | 'DEMO_MODE'>, response: Response): Promise<Response> {
  if (env.EDITION === 'self-hosted' || env.DEMO_MODE === 'true' || request.method !== 'GET' || response.status !== 200 || !response.headers.get('Content-Type')?.includes('text/html')) return response;
  const tags = publicPreloadTags(new URL(request.url));
  if (!tags) return response;
  const html = await response.text();
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.delete('ETag');
  return new Response(injectPreloads(html, tags), { status: response.status, statusText: response.statusText, headers });
}
