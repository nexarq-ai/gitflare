import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { normalizeUri } from 'micromark-util-sanitize-uri';
import { hostOrigins } from '../shared/hosts';
import { isDeployBadgeSource } from '../shared/markdown-images';
import type { AppEnv } from './env';
import { clientIp, consume, rateLimitedResponse } from './rate-limits';

export const IMAGE_PROXY_PATH = '/-/img';
export const IMAGE_PROXY_MAX_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 100;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 8000;
const CACHE_PREFIX = '/__gitflare-img/v1';
const CACHED_FOR = 'public, max-age=86400';
const SIGNATURE = /^[a-f0-9]{64}$/;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/bmp']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet', '.corp', '.private'];

export const PROXIED_IMAGE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

type ProxyEnv = Pick<AppEnv, 'EDITION' | 'AUTH_ENCRYPTION_KEY' | 'SITE_ORIGIN' | 'APP_ORIGIN' | 'IMAGE_PROXY_RATE_LIMIT'>;
type Waiter = { waitUntil(promise: Promise<unknown>): void } | undefined;
export type HostResolver = (hostname: string, signal: AbortSignal) => Promise<string[]>;
export interface ProxyOptions { fetch?: typeof fetch; resolve?: HostResolver; cache?: Cache | null }

const keys = new Map<string, Promise<CryptoKey>>();

export function imageProxyEnabled(env: Pick<ProxyEnv, 'EDITION' | 'AUTH_ENCRYPTION_KEY'>): boolean {
  return env.EDITION !== 'self-hosted' && !!env.AUTH_ENCRYPTION_KEY;
}

function signingKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keys.set(secret, key);
  }
  return key;
}

function signedMessage(url: string): Uint8Array<ArrayBuffer> { return new TextEncoder().encode(`gitflare-image-proxy:v1\n${url}`); }

function hex(bytes: ArrayBuffer): string { return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }

export async function signImageUrl(secret: string, url: string): Promise<string> {
  return hex(await crypto.subtle.sign('HMAC', await signingKey(secret), signedMessage(url)));
}

export async function verifyImageSignature(secret: string, url: string, signature: string): Promise<boolean> {
  if (!SIGNATURE.test(signature)) return false;
  const bytes = new Uint8Array(signature.match(/../g)!.map(pair => parseInt(pair, 16)));
  return crypto.subtle.verify('HMAC', await signingKey(secret), bytes, signedMessage(url));
}

export async function proxiedImagePath(secret: string, url: string): Promise<string> {
  return `${IMAGE_PROXY_PATH}?url=${encodeURIComponent(url)}&sig=${await signImageUrl(secret, url)}`;
}

type MarkdownNode = { type: string; url?: string; identifier?: string; children?: MarkdownNode[] };

export function markdownImageSources(markdown: string): string[] {
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as MarkdownNode;
  const definitions = new Map<string, string>();
  const images: ({ url: string } | { identifier: string })[] = [];
  const walk = (node: MarkdownNode) => {
    if (node.type === 'definition' && node.identifier !== undefined && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url ?? '');
    else if (node.type === 'image') images.push({ url: node.url ?? '' });
    else if (node.type === 'imageReference' && node.identifier !== undefined) images.push({ identifier: node.identifier });
    node.children?.forEach(walk);
  };
  walk(tree);
  const sources = images.map(image => 'url' in image ? image.url : definitions.get(image.identifier)).filter((url): url is string => !!url);
  return [...new Set(sources)];
}

function ownHosts(env: Pick<ProxyEnv, 'SITE_ORIGIN' | 'APP_ORIGIN'>): Set<string> {
  const origins = hostOrigins(env.SITE_ORIGIN, env.APP_ORIGIN);
  return new Set([origins?.site, origins?.app].filter((origin): origin is string => !!origin).map(origin => new URL(origin).hostname));
}

export async function markdownImages(env: ProxyEnv, markdown: string): Promise<Record<string, string> | undefined> {
  if (!imageProxyEnabled(env)) return undefined;
  let sources: string[];
  try { sources = markdownImageSources(markdown); } catch { return undefined; }
  const own = ownHosts(env);
  const images: Record<string, string> = {};
  let count = 0;
  for (const source of sources) {
    if (count >= MAX_IMAGES) break;
    let url: URL;
    try { url = new URL(source); } catch { continue; }
    if (url.protocol !== 'https:' || isDeployBadgeSource(url.href) || own.has(url.hostname)) continue;
    images[normalizeUri(source)] = await proxiedImagePath(env.AUTH_ENCRYPTION_KEY!, url.href);
    count++;
  }
  return count ? images : undefined;
}

function ipv4Parts(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.map(Number);
}

function privateIpv4([a, b, c]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b! >= 64 && b! <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b! >= 16 && b! <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

function ipv6Hextets(value: string): number[] | null {
  let address = value.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!;
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (dotted) {
    const parts = ipv4Parts(dotted[1]!);
    if (!parts) return null;
    address = `${address.slice(0, -dotted[1]!.length)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => part ? part.split(':') : [];
  const head = parse(halves[0]!), tail = halves.length === 2 ? parse(halves[1]!) : [];
  if ([...head, ...tail].some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  return [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail].map(group => parseInt(group, 16));
}

function privateIpv6(groups: number[]): boolean {
  const [first] = groups as [number];
  const embedded = [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255];
  if (groups.slice(0, 7).every(group => group === 0)) return true;
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) return privateIpv4(embedded);
  if (first === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every(group => group === 0)) return privateIpv4(embedded);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00
    || (first === 0x2001 && groups[1] === 0x0db8) || (first === 0x0100 && groups.slice(1, 4).every(group => group === 0));
}

export function isPrivateAddress(address: string): boolean {
  const v4 = ipv4Parts(address);
  if (v4) return privateIpv4(v4);
  const v6 = ipv6Hextets(address);
  return v6 ? privateIpv6(v6) : true;
}

export function isIpLiteral(hostname: string): boolean {
  return !!ipv4Parts(hostname) || hostname.startsWith('[') || !!ipv6Hextets(hostname);
}

export const resolveWithDoh: HostResolver = async (hostname, signal) => {
  const lookups = await Promise.all(['A', 'AAAA'].map(async type => {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, { headers: { Accept: 'application/dns-json' }, signal });
    if (!response.ok) throw new Error(`DNS lookup failed with ${response.status}`);
    const answer = (await response.json() as { Answer?: { type: number; data: string }[] }).Answer ?? [];
    return answer.filter(record => record.type === 1 || record.type === 28).map(record => record.data);
  }));
  return lookups.flat();
};

class ProxyRefusal extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function assertSafeTarget(target: string, own: Set<string>, resolve: HostResolver, signal: AbortSignal): Promise<URL> {
  let url: URL;
  try { url = new URL(target); } catch { throw new ProxyRefusal(400, 'The image address is not a valid URL.'); }
  if (url.protocol !== 'https:') throw new ProxyRefusal(403, 'Only HTTPS images are proxied.');
  if (url.username || url.password || url.port) throw new ProxyRefusal(403, 'Image addresses with credentials or ports are not proxied.');
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isIpLiteral(hostname)) throw new ProxyRefusal(403, 'Images addressed by IP are not proxied.');
  if (!hostname.includes('.') || hostname === 'localhost' || LOCAL_SUFFIXES.some(suffix => hostname.endsWith(suffix)) || own.has(hostname)) throw new ProxyRefusal(403, 'This image host is not proxied.');
  let addresses: string[];
  try { addresses = await resolve(hostname, signal); } catch { throw new ProxyRefusal(502, 'The image host could not be resolved.'); }
  if (!addresses.length) throw new ProxyRefusal(502, 'The image host could not be resolved.');
  if (addresses.some(isPrivateAddress)) throw new ProxyRefusal(403, 'This image host resolves to a private network.');
  return url;
}

async function readCapped(response: Response): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get('Content-Length'));
  if (declared > IMAGE_PROXY_MAX_BYTES) { await response.body?.cancel(); throw new ProxyRefusal(413, 'The image is larger than 5 MB.'); }
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > IMAGE_PROXY_MAX_BYTES) { await reader.cancel(); throw new ProxyRefusal(413, 'The image is larger than 5 MB.'); }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body.buffer;
}

export async function fetchProxiedImage(target: string, own: Set<string>, options: Required<Pick<ProxyOptions, 'fetch' | 'resolve'>>, signal: AbortSignal): Promise<{ body: ArrayBuffer; type: string }> {
  let current = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertSafeTarget(current, own, options.resolve, signal);
    const response = await options.fetch(url.href, { redirect: 'manual', headers: { Accept: 'image/*', 'User-Agent': 'Gitflare-Image-Proxy/1.0' }, signal });
    if (REDIRECTS.has(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('Location');
      if (!location) throw new ProxyRefusal(502, 'The image host redirected without a location.');
      current = new URL(location, url).href;
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new ProxyRefusal(502, `The image host answered ${response.status}.`); }
    const type = (response.headers.get('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) { await response.body?.cancel(); throw new ProxyRefusal(415, 'The address did not return a supported image.'); }
    return { body: await readCapped(response), type };
  }
  throw new ProxyRefusal(502, 'The image host redirected too many times.');
}

function refusal(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { ...PROXIED_IMAGE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function edgeCache(): Cache | null {
  return typeof caches === 'undefined' ? null : (caches as unknown as { default?: Cache }).default ?? null;
}

function imageResponse(request: Request, body: ArrayBuffer | ReadableStream | null, type: string): Response {
  return new Response(request.method === 'HEAD' ? null : body, { headers: { ...PROXIED_IMAGE_HEADERS, 'Content-Type': type, 'Cache-Control': CACHED_FOR } });
}

export async function imageProxyResponse(request: Request, env: ProxyEnv, ctx?: Waiter, options: ProxyOptions = {}): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== IMAGE_PROXY_PATH) return null;
  if (!imageProxyEnabled(env)) return refusal(404, 'Not found');
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed\n', { status: 405, headers: { ...PROXIED_IMAGE_HEADERS, Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  const target = url.searchParams.get('url') ?? '';
  const signature = url.searchParams.get('sig') ?? '';
  if (!target || !await verifyImageSignature(env.AUTH_ENCRYPTION_KEY!, target, signature)) return refusal(403, 'This image link is not signed by Gitflare.');
  const cache = options.cache === undefined ? edgeCache() : options.cache;
  const key = new Request(`${url.origin}${CACHE_PREFIX}/${signature}`, { method: 'GET' });
  const cached = cache ? await cache.match(key).catch(() => undefined) : undefined;
  if (cached) return imageResponse(request, cached.body, cached.headers.get('Content-Type') ?? 'application/octet-stream');
  const limited = await consume(env, 'IMAGE_PROXY_RATE_LIMIT', `ip:${clientIp(request)}`);
  if (limited) return rateLimitedResponse(limited, 'image requests');
  let image: { body: ArrayBuffer; type: string };
  try {
    image = await fetchProxiedImage(target, ownHosts(env), { fetch: options.fetch ?? fetch, resolve: options.resolve ?? resolveWithDoh }, AbortSignal.timeout(FETCH_TIMEOUT_MS));
  } catch (error) {
    if (error instanceof ProxyRefusal) return refusal(error.status, error.message);
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return refusal(504, 'The image host did not answer in time.');
    return refusal(502, 'The image could not be fetched.');
  }
  if (cache) {
    const put = cache.put(key, new Response(image.body.slice(0), { headers: { 'Content-Type': image.type, 'Cache-Control': CACHED_FOR } })).catch(() => undefined);
    if (ctx) ctx.waitUntil(put); else await put;
  }
  return imageResponse(request, image.body, image.type);
}
