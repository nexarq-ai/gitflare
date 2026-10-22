import type { Advisory, FeedLinks, PublicBranches, PublicCommit, PublicFile, PublicHistory, PublicReleases, PublicRepositorySummary, PublicTree, Release, Repository, RepositoryFeeds, RepositoryLicense, RepositoryVisibility } from '../shared/types';
import { HANDLE_PATTERN } from '../shared/handles';
import { repositoryLabel } from '../shared/repository-names';
import { hostOrigins } from '../shared/hosts';
import { ApiError, repositoryPath, repositoryRef } from './domain';
import type { AppEnv } from './env';
import { catalogName } from './capacity';
import { listBranches } from './git-http';
import { clientIp, consume, rateLimitedResponse } from './rate-limits';
import { publicPrincipal, securityClient, type Principal, type PublicListing, type SecurityService, type VisibilityRecord } from './security';
import { CACHE_DEPENDENCIES } from './public-cache';
import { indexedDetails, repositoryActivity, repositoryReadiness } from './public-index';
import { sourceView, type SourceHandle } from './source-browse';
import { readFunding } from './funding';
import { readSecurityPolicy } from './security-policy';
import { publicDownloadUrl, servedContentType, type StoredAsset } from './release-assets';

export const PUBLIC_NOT_FOUND = 'This repository does not exist or is not public.';
const REPOSITORY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[.-][a-z0-9.-]{1,20})?$/i;
const README_FILE = /^readme(?:\.(?:md|markdown|txt))?$/i;
const LICENSE_READ_MAX = 65_536;
const PUBLIC_HISTORY_MAX = 100;
const PUBLIC_SHA_HISTORY = 1000;

export interface PublicTarget { repository: Repository; handle: string; workspaceId: string }
export type PublicResolution = PublicTarget | { redirect: string } | null;

function notFound(): never { throw new ApiError(404, 'NOT_FOUND', PUBLIC_NOT_FOUND); }

export function siteOrigin(env: Pick<AppEnv, 'SITE_ORIGIN' | 'APP_ORIGIN'>, requestOrigin: string): string {
  return hostOrigins(env.SITE_ORIGIN, env.APP_ORIGIN)?.site ?? requestOrigin;
}

export function publicUrls(origin: string, handle: string, repository: Pick<Repository, 'name' | 'displayName'>) {
  const path = `/${handle}/${encodeURIComponent(repositoryLabel(repository))}`;
  return { path, url: `${origin}${path}`, cloneUrl: `${origin}${path}.git` };
}

export function feedLinks(origin: string, path: string): RepositoryFeeds {
  const links = (kind: string): FeedLinks => ({ atom: `${origin}${path}/${kind}.atom`, rss: `${origin}${path}/${kind}.rss` });
  return { releases: links('releases'), commits: links('commits'), issues: links('issues') };
}

export function findPublicRepository(repositories: Repository[], name: string): Repository | undefined {
  return repositories.find(item => repositoryLabel(item) === name) ?? repositories.find(item => repositoryLabel(item).toLowerCase() === name.toLowerCase());
}

export async function resolvePublicRepository(env: AppEnv, access: SecurityService, handle: string, name: string): Promise<PublicResolution> {
  if (!HANDLE_PATTERN.test(handle) || !REPOSITORY_SEGMENT.test(name) || name.endsWith('.git')) return null;
  const resolved = await access.resolveHandle(handle);
  if (!resolved) return null;
  if ('redirect' in resolved) return { redirect: resolved.redirect };
  const repository = findPublicRepository(await env.GITFLARE_COORDINATOR.getByName(catalogName(resolved.workspaceId)).listRepositories(), name);
  if (!repository || repository.provider !== 'artifacts' || !env.ARTIFACTS) return null;
  const allowed = await access.check(publicPrincipal(resolved.workspaceId), 'read', 'repository', repository.id).then(() => true, () => false);
  return allowed ? { repository, handle: resolved.handle, workspaceId: resolved.workspaceId } : null;
}

export interface PublicTargetById extends PublicTarget { listing: PublicListing }

export async function publicTargetById(env: AppEnv, access: SecurityService, repositoryId: string): Promise<PublicTargetById | null> {
  const listing = await access.publicListing(repositoryId);
  if (!listing) return null;
  const repository = await env.GITFLARE_COORDINATOR.getByName(catalogName(listing.workspaceId)).getRepository(repositoryId).catch(() => undefined);
  if (!repository || repository.provider !== 'artifacts') return null;
  const [allowed, handle] = await Promise.all([access.check(publicPrincipal(listing.workspaceId), 'read', 'repository', repository.id).then(() => true, () => false), access.handleOf(listing.workspaceId)]);
  return allowed && handle ? { repository, handle, workspaceId: listing.workspaceId, listing } : null;
}

export function detectSpdx(text: string): string | null {
  const head = text.slice(0, 4000).replace(/\s+/g, ' ');
  const rules: [RegExp, string][] = [
    [/GNU AFFERO GENERAL PUBLIC LICENSE/i, 'AGPL-3.0'],
    [/GNU LESSER GENERAL PUBLIC LICENSE/i, /Version 2\.1/i.test(head) ? 'LGPL-2.1' : 'LGPL-3.0'],
    [/GNU GENERAL PUBLIC LICENSE/i, /Version 2,/i.test(head) ? 'GPL-2.0' : 'GPL-3.0'],
    [/Mozilla Public License,? (?:Version|v\.?) ?2\.0/i, 'MPL-2.0'],
    [/Apache License,? Version 2\.0/i, 'Apache-2.0'],
    [/Permission is hereby granted, free of charge/i, 'MIT'],
    [/Permission to use, copy, modify, and\/or distribute this software for any purpose/i, 'ISC'],
    [/This is free and unencumbered software released into the public domain/i, 'Unlicense'],
    [/Boost Software License/i, 'BSL-1.0'],
    [/Redistribution and use in source and binary forms/i, /Neither the name/i.test(head) ? 'BSD-3-Clause' : 'BSD-2-Clause'],
  ];
  return rules.find(([pattern]) => pattern.test(head))?.[1] ?? null;
}

async function rootEntries(source: SourceHandle, ref: string) {
  const commit = (await source.log({ ref, limit: 1 }).catch(() => []))[0];
  if (!commit) return { commit: undefined, entries: [] };
  return { commit, entries: (await source.readTree(commit.treeHash)) ?? [] };
}

export async function detectLicense(source: SourceHandle, ref: string): Promise<RepositoryLicense | null> {
  const { commit, entries } = await rootEntries(source, ref);
  const file = entries.filter(entry => entry.type !== 'tree' && LICENSE_FILE.test(entry.name)).sort((a, b) => a.name.length - b.name.length)[0];
  if (!commit || !file) return null;
  const blob = await source.readFile({ ref: commit.hash, path: file.name }).catch(() => null);
  const text = blob && blob.size <= LICENSE_READ_MAX ? await blob.text().catch(() => '') : '';
  return { spdx: detectSpdx(text), path: file.name };
}

export async function visibilitySnapshot(env: AppEnv, access: SecurityService, principal: Principal, repository: Repository, origin: string): Promise<RepositoryVisibility> {
  const [record, handle] = await Promise.all([access.visibility(principal, repository.id), access.handleOf(principal.workspaceId)]);
  let license: RepositoryLicense | null = record?.license ?? null;
  if (env.ARTIFACTS && repository.provider === 'artifacts') {
    using source = await env.ARTIFACTS.get(repository.name);
    license = await detectLicense(source, repository.defaultBranch).catch(() => license);
  }
  const urls = handle ? publicUrls(origin, handle, repository) : null;
  const hosted = env.EDITION !== 'self-hosted' && env.DEMO_MODE !== 'true';
  return {
    repositoryId: repository.id, visibility: record ? 'public' : 'private', publishedAt: record?.publishedAt ?? null, license, handle,
    url: urls?.url ?? null, cloneUrl: urls?.cloneUrl ?? null, canChange: hosted && principal.role === 'Owner' && !principal.credentialId,
  };
}

export async function changeVisibility(env: AppEnv, access: SecurityService, principal: Principal, repository: Repository, body: Record<string, unknown>): Promise<void> {
  if (body.visibility !== 'public' && body.visibility !== 'private') throw new ApiError(400, 'INVALID_VISIBILITY', 'Choose public or private.');
  if (body.acknowledgeNoLicense !== undefined && typeof body.acknowledgeNoLicense !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', 'acknowledgeNoLicense must be true or false.');
  await access.authorize(principal, 'manage', 'repository', repository.id);
  if (body.visibility === 'private') { await access.setVisibility(principal, repository, null); await assertSaved(access, principal, repository.id, false); return; }
  if (!env.ARTIFACTS || repository.provider !== 'artifacts') throw new ApiError(409, 'REPOSITORY_NOT_CONNECTED', 'Only repositories with Git storage can be public.');
  using source = await env.ARTIFACTS.get(repository.name);
  if (!(await source.log({ ref: repository.defaultBranch, limit: 1 }).catch(() => []))[0]) throw new ApiError(409, 'EMPTY_REPOSITORY', 'Push a first commit before making this repository public.');
  const license = await detectLicense(source, repository.defaultBranch);
  if (!license && body.acknowledgeNoLicense !== true) throw new ApiError(409, 'LICENSE_REQUIRED', 'Add a LICENSE file so others know how they may use the code, or confirm publishing without one.');
  const current = await access.visibility(principal, repository.id);
  const record: VisibilityRecord = { visibility: 'public', publishedAt: current?.publishedAt ?? new Date().toISOString(), publishedBy: current?.publishedBy ?? principal.userId, license, ...(license ? {} : { acknowledgedNoLicense: true }) };
  await access.setVisibility(principal, repository, record);
  await assertSaved(access, principal, repository.id, true);
}

async function assertSaved(access: SecurityService, principal: Principal, repositoryId: string, published: boolean): Promise<void> {
  if (!!(await access.visibility(principal, repositoryId)) !== published) throw new ApiError(500, 'VISIBILITY_NOT_SAVED', 'The visibility change was not saved. Try again.');
}

async function publicRef(source: SourceHandle, repository: Repository, value: string | null): Promise<string> {
  const ref = repositoryRef(value || repository.defaultBranch);
  if (!/^[a-f0-9]{7,40}$/.test(ref)) return ref;
  const reachable = await source.log({ ref: repository.defaultBranch, limit: PUBLIC_SHA_HISTORY }).catch(() => []);
  const match = reachable.filter(commit => commit.hash.startsWith(ref));
  if (match.length === 1) return match[0]!.hash;
  if (match.length > 1) throw new ApiError(409, 'AMBIGUOUS_REF', `Commit prefix ${ref} matches more than one commit. Pass more characters.`);
  throw new ApiError(404, 'REF_NOT_FOUND', `Commit ${ref.slice(0, 12)} is not in the last ${PUBLIC_SHA_HISTORY} commits of ${repository.defaultBranch}. Pass a branch or tag name.`);
}

function commits(list: { hash: string; message: string }[]): PublicCommit[] { return list.map(commit => ({ sha: commit.hash, message: commit.message.slice(0, 2000) })); }

async function publicRead(env: AppEnv, access: SecurityService, target: PublicTarget, view: string, url: URL, origin: string): Promise<Response> {
  const response = await publicView(env, access, target, view, url, origin);
  if (response.ok) response.headers.set(CACHE_DEPENDENCIES, target.repository.id);
  return response;
}

async function publicView(env: AppEnv, access: SecurityService, target: PublicTarget, view: string, url: URL, origin: string): Promise<Response> {
  const { repository, handle } = target;
  using source = await env.ARTIFACTS!.get(repository.name);
  if (view === '') {
    const { commit, entries } = await rootEntries(source, repository.defaultBranch);
    const readme = entries.filter(entry => entry.type !== 'tree' && README_FILE.test(entry.name)).sort((a, b) => a.name.length - b.name.length)[0]?.name ?? null;
    const urls = publicUrls(origin, handle, repository);
    const records = env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`);
    const [[stats], forks, agentReady, details, releases] = await Promise.all([
      access.repositoryStats([repository.id]), Promise.resolve().then(() => records.forkCount()).catch(() => 0), repositoryReadiness(env, repository.id).catch(() => null),
      indexedDetails(env, [repository.id]).catch(() => new Map()), Promise.resolve().then(() => records.listReleases() as Promise<Release[]>).catch(() => [] as Release[]),
    ]);
    const latest = releases.filter(release => !release.draft && release.publishedAt).sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))[0];
    const [license, funding, policy] = commit ? await Promise.all([detectLicense(source, repository.defaultBranch), readFunding(source, commit.hash).catch(() => []), readSecurityPolicy(source, commit.hash).catch(() => null)]) : [null, [], null];
    return Response.json({
      handle, name: repositoryLabel(repository), description: repository.description, defaultBranch: repository.defaultBranch, headSha: commit?.hash ?? null, updatedAt: repository.updatedAt,
      visibility: 'public', license, readme, url: urls.url, cloneUrl: urls.cloneUrl, latestCommit: commit ? commits([commit])[0]! : null,
      stars: stats?.stars ?? 0, watchers: stats?.watchers ?? 0, forks, funding, feeds: feedLinks(origin, urls.path), securityPolicy: !!policy, agentReady,
      language: details.get(repository.id)?.language ?? null, latestRelease: latest ? { tag: latest.tag, name: latest.name, publishedAt: latest.publishedAt! } : null,
    } satisfies PublicRepositorySummary);
  }
  if (view === 'branches') {
    const branches = await listBranches(env.ARTIFACTS!, repository, []);
    return Response.json({ defaultBranch: repository.defaultBranch, branches: branches.map(branch => ({ name: branch.name, headSha: branch.headSha, default: branch.default })) } satisfies PublicBranches);
  }
  if (view === 'activity') return Response.json(await repositoryActivity(env, [repository.id]));
  if (view === 'releases') {
    const records = env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`);
    const [releases, assets, advisories] = await Promise.all([records.listReleases() as Promise<Release[]>, Promise.resolve().then(() => records.listReleaseAssets() as Promise<StoredAsset[]>).catch(() => [] as StoredAsset[]), Promise.resolve().then(() => records.listAdvisories() as Promise<Advisory[]>).catch(() => [] as Advisory[])]);
    const urls = publicUrls(origin, handle, repository);
    return Response.json({
      releases: releases.filter(release => !release.draft && release.publishedAt).sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')).map(release => ({
        tag: release.tag, name: release.name, notes: release.notes, targetSha: release.targetSha, prerelease: release.prerelease, publishedAt: release.publishedAt,
        assets: env.RELEASE_ASSETS ? assets.filter(asset => asset.releaseId === release.id).map(asset => ({ name: asset.name, size: asset.size, contentType: servedContentType(asset.contentType), sha256: asset.sha256, downloadUrl: publicDownloadUrl(urls.url, release.tag, asset.name) })) : [],
        advisories: advisories.filter(advisory => advisory.state === 'published' && advisory.releaseId === release.id).map(advisory => ({ id: advisory.id, title: advisory.title, severity: advisory.severity, cveId: advisory.cveId })),
      })),
      feeds: feedLinks(origin, urls.path).releases,
    } satisfies PublicReleases);
  }
  const ref = await publicRef(source, repository, url.searchParams.get('ref'));
  const commit = (await source.log({ ref, limit: 1 }).catch(() => []))[0];
  if (!commit) throw new ApiError(404, 'REF_NOT_FOUND', 'This branch, tag or commit does not exist in this repository.');
  if (view === 'history') {
    const limit = Math.min(PUBLIC_HISTORY_MAX, Math.max(1, Number(url.searchParams.get('limit')) || 30));
    return Response.json({ ref, commits: commits(await source.log({ ref: commit.hash, limit })) } satisfies PublicHistory);
  }
  if (view === 'readme') {
    const { entries } = await rootEntries(source, commit.hash);
    const readme = entries.filter(entry => entry.type !== 'tree' && README_FILE.test(entry.name)).sort((a, b) => a.name.length - b.name.length)[0];
    if (!readme) throw new ApiError(404, 'FILE_NOT_FOUND', 'This repository has no README.');
    return publicSource(await sourceView(source, commit, 'file', readme.name, ref));
  }
  const kind = view === 'file' ? 'file' : 'tree';
  return publicSource(await sourceView(source, commit, kind, repositoryPath(url.searchParams.get('path') ?? '', kind === 'tree'), ref));
}

async function publicSource(response: Response): Promise<Response> {
  const value = await response.json() as (PublicTree | PublicFile) & { missionId?: unknown; source?: unknown };
  const { missionId: _missionId, source: _source, ...rest } = value;
  return Response.json(rest);
}

export async function publicRepositoryIndex(env: AppEnv, origin: string, client: string, limit = 50): Promise<string> {
  if (!env.GITFLARE_SECURITY || await consume(env, 'PUBLIC_READ_RATE_LIMIT', `ip:${client}`)) return '';
  const access = securityClient(env);
  const listings = (await access.publicListings().catch(() => [])).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, limit);
  const lines = await Promise.all(listings.map(async listing => {
    const repository = await env.GITFLARE_COORDINATOR.getByName(catalogName(listing.workspaceId)).getRepository(listing.repositoryId).catch(() => undefined);
    if (!repository || !await access.check(publicPrincipal(listing.workspaceId), 'read', 'repository', repository.id).then(() => true, () => false)) return null;
    const handle = await access.handleOf(listing.workspaceId);
    if (!handle) return null;
    const description = repository.description.replace(/\s+/g, ' ').trim().slice(0, 200);
    return `- [${handle}/${repositoryLabel(repository)}](${publicUrls(origin, handle, repository).url})${description ? `: ${description}` : ''}`;
  }));
  const found = lines.filter((line): line is string => !!line);
  return found.length ? `\n## Public repositories\n\n${found.join('\n')}\n` : '';
}

const PUBLIC_VIEWS = new Set(['', 'tree', 'file', 'history', 'branches', 'releases', 'readme', 'activity']);

export async function publicRepositoryApi(request: Request, env: AppEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const repositoryRoute = /^\/api\/public\/repos\/([^/]+)\/([^/]+)(?:\/([a-z]+))?$/.exec(url.pathname);
  const byId = /^\/api\/public\/repository\/([a-zA-Z0-9-]{1,100})$/.exec(url.pathname);
  if (!repositoryRoute && !byId) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Public repositories are read-only here.');
  const limited = await consume(env, 'PUBLIC_READ_RATE_LIMIT', `ip:${clientIp(request)}`);
  if (limited) return rateLimitedResponse(limited, 'public repository requests');
  const access = securityClient(env);
  const origin = siteOrigin(env, url.origin);
  if (byId) {
    const listing = await access.publicListing(byId[1]!);
    const repository = listing ? await env.GITFLARE_COORDINATOR.getByName(catalogName(listing.workspaceId)).getRepository(byId[1]!) : undefined;
    const allowed = repository ? await access.check(publicPrincipal(listing!.workspaceId), 'read', 'repository', repository.id).then(() => true, () => false) : false;
    const handle = allowed ? await access.handleOf(listing!.workspaceId) : null;
    if (!repository || !handle) notFound();
    return Response.json({ url: publicUrls('', handle, repository).path });
  }
  let handle: string; let name: string;
  try { handle = decodeURIComponent(repositoryRoute![1]!); name = decodeURIComponent(repositoryRoute![2]!); } catch { notFound(); }
  const view = repositoryRoute![3] ?? '';
  if (!PUBLIC_VIEWS.has(view)) notFound();
  const target = await resolvePublicRepository(env, access, handle.toLowerCase(), name);
  if (!target) notFound();
  if ('redirect' in target) return new Response(null, { status: 308, headers: { Location: `/api/public/repos/${target.redirect}/${encodeURIComponent(name)}${view ? `/${view}` : ''}${url.search}` } });
  return publicRead(env, access, target, view, url, origin);
}
