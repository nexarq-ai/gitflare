import type { MissionSummary, Release } from '../shared/types';
import { HANDLE_PATTERN, publicRepositoryPath } from '../shared/handles';
import { repositoryLabel } from '../shared/repository-names';
import { landedLine, socialCardSvg, SOCIAL_CARD_HEIGHT, SOCIAL_CARD_WIDTH, type SocialCard, type SocialRepositoryCard, type SocialTheme } from '../shared/social-card-svg';
import { publicProfileLocation, publicRepositoryLocation, routeFromLocation } from '../ui/router';
import type { AppEnv } from './env';
import { clientIp, consume, rateLimitedResponse } from './rate-limits';
import { detectLicense, resolvePublicRepository, siteOrigin, type PublicTarget } from './public-repositories';
import { indexedDetails } from './public-index';
import { workspaceRepositories } from './public-discovery';
import { securityClient, type SecurityService } from './security';
import { rasterize } from './social-raster';

export const SOCIAL_LANDED_DAYS = 30;
const CARD_PATH = /^\/([^/]+)\/(?:-\/social\.png|([^/]+)\/-\/(?:social\.png|releases\/([^/]+)\/social\.png))$/;
const FONT_FILES = ['InstrumentSans-Regular.ttf', 'InstrumentSans-SemiBold.ttf', 'InstrumentSerif-Italic.ttf'];
const CACHE_PREFIX = '/__gitflare-social/v1';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const FRESH = 'public, max-age=300';
type Waiter = { waitUntil(promise: Promise<unknown>): void } | undefined;
export type SocialTarget = { kind: 'profile'; handle: string } | { kind: 'repository'; handle: string; repository: string } | { kind: 'release'; handle: string; repository: string; tag: string };
export interface SocialPreview { card: SocialCard; title: string; description: string; path: string }

let fontCache: Promise<Uint8Array[]> | undefined;

function hosted(env: Pick<AppEnv, 'EDITION' | 'DEMO_MODE' | 'GITFLARE_SECURITY'>): boolean {
  return env.EDITION !== 'self-hosted' && env.DEMO_MODE !== 'true' && !!env.GITFLARE_SECURITY;
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}

function edgeCache(): Cache | null {
  return typeof caches === 'undefined' ? null : (caches as unknown as { default?: Cache }).default ?? null;
}

export function socialCardTarget(pathname: string): SocialTarget | null {
  const match = CARD_PATH.exec(pathname);
  if (!match) return null;
  let handle: string, repository: string | undefined, tag: string | undefined;
  try { handle = decodeURIComponent(match[1]!).toLowerCase(); repository = match[2] === undefined ? undefined : decodeURIComponent(match[2]); tag = match[3] === undefined ? undefined : decodeURIComponent(match[3]); } catch { return null; }
  if (!HANDLE_PATTERN.test(handle)) return null;
  if (repository === undefined) return { kind: 'profile', handle };
  if (tag === undefined) return { kind: 'repository', handle, repository };
  return { kind: 'release', handle, repository, tag };
}

export function socialPageTarget(pathname: string): SocialTarget | null {
  const route = routeFromLocation(pathname, '');
  const repository = publicRepositoryLocation(route);
  if (repository) return repository.view === 'releases' ? { kind: 'release', handle: repository.handle.toLowerCase(), repository: repository.repository, tag: '' } : { kind: 'repository', handle: repository.handle.toLowerCase(), repository: repository.repository };
  const profile = publicProfileLocation(route);
  return profile ? { kind: 'profile', handle: profile.handle.toLowerCase() } : null;
}

export function socialCardPath(target: SocialTarget): string {
  const handle = encodeURIComponent(target.handle);
  if (target.kind === 'profile') return `/${handle}/-/social.png`;
  const repository = encodeURIComponent(target.repository);
  return target.kind === 'repository' ? `/${handle}/${repository}/-/social.png` : `/${handle}/${repository}/-/releases/${encodeURIComponent(target.tag)}/social.png`;
}

export function landedCounts(missions: Pick<MissionSummary, 'status' | 'updatedAt' | 'runs'>[], now = Date.now()): SocialRepositoryCard['landed'] {
  const since = now - SOCIAL_LANDED_DAYS * 86_400_000;
  let agents = 0, people = 0;
  for (const mission of missions) {
    if (mission.status !== 'integrated' || Date.parse(mission.updatedAt) < since) continue;
    if (mission.runs.length) agents++; else people++;
  }
  return { total: agents + people, agents, people, days: SOCIAL_LANDED_DAYS };
}

async function contentHash(card: SocialCard, theme: SocialTheme): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([card, theme])));
  return [...new Uint8Array(digest)].slice(0, 8).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function repositoryPreview(env: AppEnv, access: SecurityService, target: PublicTarget, release?: Release): Promise<SocialPreview> {
  const { repository, handle } = target;
  const name = repositoryLabel(repository);
  const records = env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`);
  const [[stats], details, missions, releases] = await Promise.all([
    access.repositoryStats([repository.id]),
    indexedDetails(env, [repository.id]),
    Promise.resolve().then(() => records.listMissionSummaries() as Promise<MissionSummary[]>).catch(() => [] as MissionSummary[]),
    Promise.resolve().then(() => records.listReleases() as Promise<Release[]>).catch(() => [] as Release[]),
  ]);
  const published = releases.filter(item => !item.draft && item.publishedAt).sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  const indexed = details.get(repository.id);
  let license = indexed?.license ?? null;
  if (!indexed && env.ARTIFACTS) {
    using source = await env.ARTIFACTS.get(repository.name);
    license = (await detectLicense(source, repository.defaultBranch).catch(() => null))?.spdx ?? null;
  }
  if (release) {
    const assets = await Promise.resolve().then(() => records.listReleaseAssets(release.id) as Promise<unknown[]>).catch(() => []);
    const card: SocialCard = { kind: 'release', handle, name, tag: release.tag, title: release.name, publishedAt: release.publishedAt, prerelease: release.prerelease, assets: assets.length };
    const notes = release.notes.replace(/\s+/g, ' ').trim();
    return { card, title: `${name} ${release.tag}`, description: notes ? notes.slice(0, 200) : `${release.name || release.tag}, a release of ${handle}/${name} on Gitflare.`, path: socialCardPath({ kind: 'release', handle, repository: name, tag: release.tag }) };
  }
  const landed = landedCounts(missions);
  const card: SocialCard = { kind: 'repository', handle, name, description: repository.description, language: indexed?.language ?? null, stars: stats?.stars ?? 0, license, latestRelease: published[0]?.tag ?? null, landed };
  const lead = repository.description.replace(/\s+/g, ' ').trim() || 'A public repository on Gitflare.';
  return { card, title: `${handle}/${name}`, description: `${lead.slice(0, 200)} ${landedLine(landed)}.`, path: socialCardPath({ kind: 'repository', handle, repository: name }) };
}

async function profilePreview(env: AppEnv, access: SecurityService, handle: string): Promise<SocialPreview | null> {
  const resolved = await access.resolveHandle(handle);
  if (!resolved || 'redirect' in resolved) return null;
  const [profile, owned] = await Promise.all([access.profileOf(resolved.workspaceId), workspaceRepositories(env, access, resolved.workspaceId, resolved.handle)]);
  const displayName = profile?.displayName || resolved.handle;
  const card: SocialCard = { kind: 'profile', handle: resolved.handle, displayName, bio: profile?.bio ?? '', workspace: resolved.kind === 'workspace', repositories: owned.cards.length, stars: owned.cards.reduce((sum, item) => sum + item.stars, 0) };
  const bio = (profile?.bio ?? '').replace(/\s+/g, ' ').trim();
  return { card, title: displayName === resolved.handle ? `@${resolved.handle}` : `${displayName} (@${resolved.handle})`, description: bio ? bio.slice(0, 200) : `${card.repositories} public ${card.repositories === 1 ? 'repository' : 'repositories'} on Gitflare.`, path: socialCardPath({ kind: 'profile', handle: resolved.handle }) };
}

export async function socialPreview(env: AppEnv, access: SecurityService, target: SocialTarget): Promise<SocialPreview | null> {
  if (target.kind === 'profile') return profilePreview(env, access, target.handle);
  let resolved = await resolvePublicRepository(env, access, target.handle, target.repository);
  if (resolved && 'redirect' in resolved) resolved = await resolvePublicRepository(env, access, resolved.redirect, target.repository);
  if (!resolved || 'redirect' in resolved) return null;
  if (target.kind === 'repository') return repositoryPreview(env, access, resolved);
  const releases = (await Promise.resolve().then(() => env.GITFLARE_COORDINATOR.getByName(`repository:${resolved.repository.id}`).listReleases() as Promise<Release[]>).catch(() => [] as Release[])).filter(item => !item.draft && item.publishedAt);
  if (!target.tag) { const latest = releases.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))[0]; return repositoryPreview(env, access, resolved, latest); }
  const release = releases.find(item => item.tag === target.tag);
  return release ? repositoryPreview(env, access, resolved, release) : null;
}

function imageUrl(origin: string, preview: SocialPreview, hash: string): string {
  return `${origin}${preview.path}?v=${hash}`;
}

function sourceCodeData(preview: SocialPreview, origin: string): string {
  if (preview.card.kind !== 'repository') return '';
  const { card } = preview;
  const page = `${origin}${publicRepositoryPath(card.handle, card.name)}`;
  const data = {
    '@context': 'https://schema.org', '@type': 'SoftwareSourceCode', name: `${card.handle}/${card.name}`, url: page, codeRepository: page,
    ...(card.description ? { description: card.description } : {}), ...(card.language ? { programmingLanguage: card.language } : {}), ...(card.license ? { license: `https://spdx.org/licenses/${card.license}.html` } : {}),
  };
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

export interface PageCopy { title?: string; description?: string }

export async function socialMetaTags(request: Request, env: AppEnv, copy?: Promise<PageCopy | null> | null): Promise<string> {
  if (request.method !== 'GET' || !hosted(env)) return '';
  const url = new URL(request.url);
  const target = socialPageTarget(url.pathname);
  if (!target) return '';
  try {
    const [preview, rendered] = await Promise.all([socialPreview(env, securityClient(env), target), copy ? copy.catch(() => null) : null]);
    if (!preview) return '';
    const origin = siteOrigin(env, url.origin);
    const hash = await contentHash(preview.card, 'dark');
    const image = imageUrl(origin, preview, hash);
    const page = `${origin}${url.pathname}`;
    const title = `${preview.title} · Gitflare`;
    const tags = [
      ['property', 'og:type', 'website'], ['property', 'og:site_name', 'Gitflare'], ['property', 'og:title', title], ['property', 'og:description', preview.description], ['property', 'og:url', page],
      ['property', 'og:image', image], ['property', 'og:image:width', String(SOCIAL_CARD_WIDTH)], ['property', 'og:image:height', String(SOCIAL_CARD_HEIGHT)], ['property', 'og:image:type', 'image/png'], ['property', 'og:image:alt', preview.title],
      ['name', 'twitter:card', 'summary_large_image'], ['name', 'twitter:title', title], ['name', 'twitter:description', preview.description], ['name', 'twitter:image', image], ['name', 'description', rendered?.description ?? preview.description],
    ];
    return `<title>${escapeAttribute(rendered?.title ? `${rendered.title} · Gitflare` : title)}</title>${tags.map(([attribute, key, value]) => `<meta ${attribute}="${key}" content="${escapeAttribute(value)}">`).join('')}${rendered ? '' : sourceCodeData(preview, origin)}`;
  } catch { return ''; }
}

const SHARE_TAGS = /\s*<title>[^<]*<\/title>|\s*<meta\s+(?:property="og:[^"]*"|name="twitter:[^"]*"|name="description")[^>]*>/g;

export function withSocialMeta(html: string, tags: string): string {
  if (!tags) return html;
  return html.replace(SHARE_TAGS, '').replace('</head>', `${tags}</head>`);
}

export function streamSocialMeta(html: string, appended: string, tags: Promise<string>): ReadableStream<Uint8Array> | null {
  const end = html.indexOf('</head>');
  if (end < 0) return null;
  const head = html.slice(0, end);
  const fallback = head.match(SHARE_TAGS)?.join('') ?? '';
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(head.replace(SHARE_TAGS, '')));
      const social = await tags.catch(() => '');
      controller.enqueue(encoder.encode(`${social || fallback}${appended}${html.slice(end)}`));
      controller.close();
    },
  });
}

async function loadFonts(env: AppEnv, origin: string): Promise<Uint8Array[]> {
  fontCache ??= Promise.all(FONT_FILES.map(async name => {
    const response = await env.ASSETS.fetch(new Request(`${origin}/fonts/${name}`));
    if (!response.ok) throw new Error(`Font ${name} is not available (${response.status}).`);
    return new Uint8Array(await response.arrayBuffer());
  })).catch(error => { fontCache = undefined; throw error; });
  return fontCache;
}

function notFound(): Response {
  return new Response('Not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function socialCardResponse(request: Request, env: AppEnv, ctx?: Waiter): Promise<Response | null> {
  const url = new URL(request.url);
  const target = socialCardTarget(url.pathname);
  if (!target) return null;
  if (!hosted(env)) return notFound();
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed\n', { status: 405, headers: { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  const limited = await consume(env, 'SOCIAL_CARD_RATE_LIMIT', `ip:${clientIp(request)}`);
  if (limited) return rateLimitedResponse(limited, 'social card requests');
  const theme: SocialTheme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark';
  const preview = await socialPreview(env, securityClient(env), target);
  if (!preview) return notFound();
  const hash = await contentHash(preview.card, theme);
  const current = url.searchParams.get('v') === hash;
  const cache = edgeCache();
  const key = new Request(`${url.origin}${CACHE_PREFIX}${preview.path}?theme=${theme}&v=${hash}`, { method: 'GET' });
  const headers = { 'Content-Type': 'image/png', 'Cache-Control': current ? IMMUTABLE : FRESH, 'X-Content-Type-Options': 'nosniff', 'X-Gitflare-Social-Version': hash };
  const cached = cache ? await cache.match(key).catch(() => undefined) : undefined;
  if (cached) return new Response(request.method === 'HEAD' ? null : cached.body, { headers });
  const origin = siteOrigin(env, url.origin);
  const fonts = await loadFonts(env, url.origin);
  const png = await rasterize(socialCardSvg(preview.card, theme, new URL(origin).host), fonts);
  const body = png.slice().buffer as ArrayBuffer;
  if (cache) {
    const put = cache.put(key, new Response(body.slice(0), { headers: { 'Content-Type': 'image/png', 'Cache-Control': IMMUTABLE } })).catch(() => undefined);
    if (ctx) ctx.waitUntil(put); else await put;
  }
  return new Response(request.method === 'HEAD' ? null : body, { headers });
}
