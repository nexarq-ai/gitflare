import type { ExploreSort, ProfileSettings, PublicProfile, PublicRepositoryCard, PublicSearchType, Repository, StarList, StarState } from '../shared/types';
import { HANDLE_PATTERN, PROFILE_LIMITS, publicRepositoryPath } from '../shared/handles';
import { repositoryLabel } from '../shared/repository-names';
import { ApiError, assertMutationOrigin, readJson } from './domain';
import type { AppEnv } from './env';
import { logFailure } from './log';
import { catalogName } from './capacity';
import { clientIp, consume, rateLimitedResponse } from './rate-limits';
import { personalWorkspaceId, publicPrincipal, securityClient, type FollowKind, type HandleKind, type Principal, type ProfileRecord, type SecurityService } from './security';
import { CACHE_DEPENDENCIES, discoveryCachePaths, purgePublicCache, repositoryCachePaths } from './public-cache';
import { backfillEmptyIndex, explorePublic, indexedDetails, indexPublicRepository, indexWorkspaceRepositories, pageCursor, publicIndex, refreshIndexedHandle, removeIndexedRepositories, searchPublic, searchQuery, updateIndexedStars } from './public-index';
import { publicTargetById, resolvePublicRepository, siteOrigin, PUBLIC_NOT_FOUND } from './public-repositories';

type Waiter = { waitUntil(promise: Promise<unknown>): void } | undefined;
const REPOSITORY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const LANGUAGE = /^[A-Za-z0-9#+ .-]{1,40}$/;
const SORTS: ExploreSort[] = ['stars', 'new', 'updated'];
const SEARCH_TYPES: PublicSearchType[] = ['repositories', 'paths', 'people'];
const STARRED_ON_PROFILE = 12;
const STAR_LIST_LIMIT = 50;

async function background(ctx: Waiter, work: Promise<unknown>): Promise<void> {
  const guarded = work.catch(error => logFailure('public_index_update_failed', error, {}, 'warn'));
  if (ctx) ctx.waitUntil(guarded); else await guarded;
}

function withDependencies(value: unknown, repositoryIds: string[]): Response {
  const response = Response.json(value);
  if (repositoryIds.length) response.headers.set(CACHE_DEPENDENCIES, [...new Set(repositoryIds)].join(','));
  return response;
}

function notFound(): never { throw new ApiError(404, 'NOT_FOUND', PUBLIC_NOT_FOUND); }

function cardOf(repository: Repository, handle: string, stars: number, details?: Pick<PublicRepositoryCard, 'language' | 'license' | 'topics'>, publishedAt = ''): PublicRepositoryCard {
  const name = repositoryLabel(repository);
  return { handle, name, description: repository.description, language: details?.language ?? null, topics: details?.topics ?? [], license: details?.license ?? null, stars, updatedAt: repository.updatedAt, publishedAt, url: publicRepositoryPath(handle, name) };
}

async function workspaceRepositories(env: AppEnv, access: SecurityService, workspaceId: string, handle: string): Promise<{ cards: PublicRepositoryCard[]; ids: string[] }> {
  const listings = (await access.publicListings()).filter(listing => listing.workspaceId === workspaceId);
  if (!listings.length) return { cards: [], ids: [] };
  const catalog = new Map((await env.GITFLARE_COORDINATOR.getByName(catalogName(workspaceId)).listRepositories() as Repository[]).map(repository => [repository.id, repository]));
  const candidates = listings.flatMap(listing => { const repository = catalog.get(listing.repositoryId); return repository && repository.provider === 'artifacts' ? [{ repository, listing }] : []; });
  const allowed = await access.checkMany(publicPrincipal(workspaceId), 'read', candidates.map(item => ({ resourceType: 'repository', resourceId: item.repository.id })));
  const visible = candidates.filter((_, index) => allowed[index]);
  const ids = visible.map(item => item.repository.id);
  const [stats, details] = await Promise.all([access.repositoryStats(ids), indexedDetails(env, ids)]);
  const cards = visible.map((item, index) => cardOf(item.repository, handle, stats[index]?.stars ?? 0, details.get(item.repository.id), item.listing.publishedAt));
  return { cards: cards.sort((a, b) => b.stars - a.stars || b.updatedAt.localeCompare(a.updatedAt)), ids };
}

async function cardsFor(env: AppEnv, access: SecurityService, repositoryIds: string[], limit: number): Promise<{ cards: PublicRepositoryCard[]; ids: string[] }> {
  const listed = await access.publicListed(repositoryIds.slice(0, limit * 2));
  const ids = repositoryIds.slice(0, limit * 2).filter((_, index) => listed[index]).slice(0, limit);
  const targets = (await Promise.all(ids.map(id => publicTargetById(env, access, id).catch(() => null)))).filter((target): target is NonNullable<typeof target> => !!target);
  const [stats, details] = await Promise.all([access.repositoryStats(targets.map(target => target.repository.id)), indexedDetails(env, targets.map(target => target.repository.id))]);
  return { cards: targets.map((target, index) => cardOf(target.repository, target.handle, stats[index]?.stars ?? 0, details.get(target.repository.id), target.listing.publishedAt)), ids: targets.map(target => target.repository.id) };
}

async function publicProfile(env: AppEnv, access: SecurityService, value: string, origin: string): Promise<Response> {
  if (!HANDLE_PATTERN.test(value)) notFound();
  const resolved = await access.resolveHandle(value);
  if (!resolved) throw new ApiError(404, 'NOT_FOUND', 'This profile does not exist.');
  if ('redirect' in resolved) return new Response(null, { status: 308, headers: { Location: `/api/public/profiles/${resolved.redirect}` } });
  const [profile, owned, follows] = await Promise.all([access.profileOf(resolved.workspaceId), workspaceRepositories(env, access, resolved.workspaceId, resolved.handle), resolved.kind === 'user' ? access.userFollows(resolved.workspaceId) : Promise.resolve([])]);
  const starred = await cardsFor(env, access, follows.map(item => item.repositoryId), STARRED_ON_PROFILE);
  const names = new Set(owned.cards.map(card => card.name));
  const body: PublicProfile = {
    handle: resolved.handle, kind: resolved.kind, displayName: profile?.displayName || resolved.handle, bio: profile?.bio ?? '', links: profile?.links ?? [],
    pinned: (profile?.pinned ?? []).filter(name => names.has(name)), repositories: owned.cards, starred: starred.cards, url: `${origin}/${resolved.handle}`,
  };
  return withDependencies(body, [...owned.ids, ...starred.ids]);
}

export async function publicDiscoveryApi(request: Request, env: AppEnv, ctx?: Waiter): Promise<Response | null> {
  const url = new URL(request.url);
  const profile = /^\/api\/public\/profiles\/([^/]+)$/.exec(url.pathname);
  if (url.pathname !== '/api/public/explore' && url.pathname !== '/api/public/search' && !profile) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Explore, search and profiles are read-only here.');
  const limited = await consume(env, 'PUBLIC_READ_RATE_LIMIT', `ip:${clientIp(request)}`);
  if (limited) return rateLimitedResponse(limited, 'public repository requests');
  const access = securityClient(env);
  if (profile) {
    if (env.EDITION === 'self-hosted' || env.DEMO_MODE === 'true') throw new ApiError(404, 'NOT_FOUND', 'This profile does not exist.');
    let handle: string;
    try { handle = decodeURIComponent(profile[1]!).toLowerCase(); } catch { notFound(); }
    return publicProfile(env, access, handle, siteOrigin(env, url.origin));
  }
  const cursor = pageCursor(url.searchParams.get('cursor'));
  if (url.pathname === '/api/public/explore') {
    const sort = (url.searchParams.get('sort') ?? 'stars') as ExploreSort;
    if (!SORTS.includes(sort)) throw new ApiError(400, 'INVALID_SORT', 'Sort by stars, new or updated.');
    const language = url.searchParams.get('language');
    if (language !== null && !LANGUAGE.test(language)) throw new ApiError(400, 'INVALID_LANGUAGE', 'This language filter is not valid.');
    const page = await explorePublic(env, access, sort, language, cursor);
    if (page.stale.length) await background(ctx, removeIndexedRepositories(env, page.stale));
    if (page.value.indexed && !page.value.items.length && !cursor) await background(ctx, backfillEmptyIndex(env, access));
    return withDependencies(page.value, page.repositoryIds);
  }
  const type = (url.searchParams.get('type') ?? 'repositories') as PublicSearchType;
  if (!SEARCH_TYPES.includes(type)) throw new ApiError(400, 'INVALID_SEARCH_TYPE', 'Search repositories, paths or people.');
  const page = await searchPublic(env, access, searchQuery(url.searchParams.get('q')), type, cursor);
  if (page.stale.length) await background(ctx, removeIndexedRepositories(env, page.stale));
  return withDependencies(page.value, page.repositoryIds);
}

export function refreshPublicRepository(env: AppEnv, repositoryId: string, origin?: string): Promise<void> {
  if (!env.GITFLARE_SECURITY || env.EDITION === 'self-hosted' || env.DEMO_MODE === 'true') return Promise.resolve();
  return (async () => {
    const access = securityClient(env);
    const target = await publicTargetById(env, access, repositoryId);
    if (target) await purgePublicCache(env, repositoryCachePaths(target.handle, repositoryLabel(target.repository)), origin);
    if (target || publicIndex(env)) await indexPublicRepository(env, repositoryId, access);
  })();
}

export function visibilityChanged(env: AppEnv, ctx: Waiter, access: SecurityService, principal: Principal, repository: Repository, origin: string): Promise<void> {
  return background(ctx, (async () => {
    const handle = await access.handleOf(principal.workspaceId);
    if (handle) await purgePublicCache(env, repositoryCachePaths(handle, repositoryLabel(repository)), origin);
    await indexPublicRepository(env, repository.id, access);
  })());
}

export function handleChanged(env: AppEnv, ctx: Waiter, workspaceId: string, previous: string | null, origin: string): Promise<void> {
  return background(ctx, (async () => {
    if (previous) await purgePublicCache(env, discoveryCachePaths(previous), origin);
    await indexWorkspaceRepositories(env, workspaceId);
  })());
}

function profileInput(body: Record<string, unknown>): Omit<ProfileRecord, 'updatedAt' | 'updatedBy'> {
  const text = (value: unknown, field: string, max: number) => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new ApiError(400, 'INVALID_INPUT', `${field} must be text.`);
    const clean = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
    if (clean.length > max) throw new ApiError(400, 'INVALID_INPUT', `${field} must be at most ${max} characters.`);
    return clean;
  };
  const list = (value: unknown, field: string, max: number) => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string')) throw new ApiError(400, 'INVALID_INPUT', `${field} must be a list of at most ${max} items.`);
    return [...new Set((value as string[]).map(item => item.trim()).filter(Boolean))];
  };
  const links = list(body.links, 'Links', PROFILE_LIMITS.links).map(link => {
    let parsed: URL | null = null;
    try { parsed = new URL(link); } catch { parsed = null; }
    if (!parsed || parsed.protocol !== 'https:' || link.length > PROFILE_LIMITS.linkLength || parsed.username || parsed.password) throw new ApiError(400, 'INVALID_LINK', `Links must be https addresses of at most ${PROFILE_LIMITS.linkLength} characters.`);
    return parsed.toString();
  });
  const pinned = list(body.pinned, 'Pinned repositories', PROFILE_LIMITS.pinned);
  if (pinned.some(name => !REPOSITORY_SEGMENT.test(name))) throw new ApiError(400, 'INVALID_INPUT', 'Pin repositories by name.');
  return { displayName: text(body.displayName, 'Display name', PROFILE_LIMITS.displayName), bio: text(body.bio, 'Bio', PROFILE_LIMITS.bio), links, pinned };
}

function profileSettings(scope: HandleKind, settings: { handle: string | null; profile: ProfileRecord | null; canChange: boolean }, origin: string): ProfileSettings {
  return { scope, handle: settings.handle, displayName: settings.profile?.displayName ?? '', bio: settings.profile?.bio ?? '', links: settings.profile?.links ?? [], pinned: settings.profile?.pinned ?? [], canChange: settings.canChange, url: settings.handle ? `${origin}/${settings.handle}` : null };
}

function starState(handle: string, repository: Repository, state: { starred: boolean; watching: boolean; stars: number; watchers: number }): StarState {
  return { handle, repository: repositoryLabel(repository), starred: state.starred, watching: state.watching, stars: state.stars, watchers: state.watchers };
}

async function starTarget(env: AppEnv, access: SecurityService, handle: unknown, name: unknown) {
  if (typeof handle !== 'string' || typeof name !== 'string') throw new ApiError(400, 'INVALID_INPUT', 'Name the repository by handle and repository.');
  let target = await resolvePublicRepository(env, access, handle.toLowerCase(), name);
  if (target && 'redirect' in target) target = await resolvePublicRepository(env, access, target.redirect, name);
  if (!target || 'redirect' in target) notFound();
  return target;
}

export async function accountDiscoveryApi(request: Request, env: AppEnv, ctx: Waiter, principal: Principal, access: SecurityService): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === '/api/stars') {
    if (request.method === 'GET') {
      const handle = url.searchParams.get('handle'); const repository = url.searchParams.get('repository');
      if (handle !== null || repository !== null) {
        const target = await starTarget(env, access, handle, repository);
        return Response.json(starState(target.handle, target.repository, await access.followState(principal, target.repository.id)));
      }
      const follows = await access.follows(principal);
      const [starred, watching] = await Promise.all([cardsFor(env, access, follows.star.map(item => item.repositoryId), STAR_LIST_LIMIT), cardsFor(env, access, follows.watch.map(item => item.repositoryId), STAR_LIST_LIMIT)]);
      return Response.json({ starred: starred.cards, watching: watching.cards } satisfies StarList);
    }
    if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST for stars.');
    assertMutationOrigin(request);
    const body = await readJson(request, 2048);
    const target = await starTarget(env, access, body.handle, body.repository);
    const state = await access.follow(principal, target.repository.id, body.kind as FollowKind, body.on as boolean);
    if (body.kind === 'star') await background(ctx, (async () => {
      const own = principal.bootstrap ? null : await access.handleOf(personalWorkspaceId(principal.userId)).catch(() => null);
      await purgePublicCache(env, [...repositoryCachePaths(target.handle, repositoryLabel(target.repository)), ...(own ? discoveryCachePaths(own) : [])], url.origin);
      await updateIndexedStars(env, target.repository.id, state.stars);
    })());
    else await background(ctx, Promise.all([purgePublicCache(env, repositoryCachePaths(target.handle, repositoryLabel(target.repository)), url.origin), Promise.resolve().then(() => env.GITFLARE_COORDINATOR.getByName(`repository:${target.repository.id}`).setRepositoryWatcher(principal.userId, state.watching))]));
    return Response.json(starState(target.handle, target.repository, state));
  }
  if (url.pathname === '/api/profile') {
    const origin = siteOrigin(env, url.origin);
    if (request.method === 'GET') {
      const scope = url.searchParams.get('scope') === 'workspace' ? 'workspace' : 'user';
      return Response.json(profileSettings(scope, await access.profileSettings(principal, scope), origin));
    }
    if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST for profiles.');
    assertMutationOrigin(request);
    const body = await readJson(request, 8192);
    if (body.scope !== 'user' && body.scope !== 'workspace') throw new ApiError(400, 'INVALID_INPUT', 'Choose the user or workspace profile.');
    const scope = body.scope;
    const input = profileInput(body);
    const saved = await access.setProfile(principal, scope, input, async workspaceId => {
      if (!input.pinned.length) return;
      const handle = await access.handleOf(workspaceId);
      const names = new Set((await workspaceRepositories(env, access, workspaceId, handle ?? '')).cards.map(card => card.name));
      const missing = input.pinned.find(name => !names.has(name));
      if (missing) throw new ApiError(400, 'PIN_NOT_PUBLIC', `${missing} is not a public repository of this profile.`);
    });
    await background(ctx, (async () => {
      await purgePublicCache(env, discoveryCachePaths(saved.handle), url.origin);
      await refreshIndexedHandle(env, saved.workspaceId, access);
    })());
    return Response.json(profileSettings(scope, { handle: saved.handle, profile: saved.profile, canChange: true }, origin));
  }
  return null;
}
