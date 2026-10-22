import type { Issue, IssueList, Release } from '../shared/types';
import { repositoryLabel } from '../shared/repository-names';
import type { AppEnv } from './env';
import { clientIp, consume, rateLimitedResponse } from './rate-limits';
import { publicUrls, resolvePublicRepository, siteOrigin, type PublicTarget } from './public-repositories';
import { securityClient, type SecurityService } from './security';

export const FEED_KINDS = ['releases', 'commits', 'issues'] as const;
export type FeedKind = typeof FEED_KINDS[number];
export type FeedFormat = 'atom' | 'rss';
export const FEED_ENTRIES = 30;
const FEED_PATH = /^\/([^/]+)\/([^/]+)\/(releases|commits|issues)\.(atom|rss)$/;
const SUMMARY_MAX = 2000;
const TYPES: Record<FeedFormat, string> = { atom: 'application/atom+xml; charset=utf-8', rss: 'application/rss+xml; charset=utf-8' };

export interface FeedEntry { id: string; title: string; url: string; updated: string; author: string | null; summary: string; categories?: string[] }
export interface Feed { id: string; title: string; subtitle: string; url: string; self: string; updated: string; entries: FeedEntry[] }

export function xml(value: string): string {
  return [...value].filter(char => { const code = char.codePointAt(0)!; return code === 9 || code === 10 || code === 13 || code >= 0x20 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000; }).join('').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
}

const text = (value: string, max = SUMMARY_MAX) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
const line = (value: string) => text(value.split('\n')[0]!.trim() || 'Untitled', 200);
const iso = (value: string | null | undefined, fallback: string) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : fallback;

export function atom(feed: Feed): string {
  const entries = feed.entries.map(entry => `<entry><id>${xml(entry.id)}</id><title>${xml(entry.title)}</title><link rel="alternate" type="text/html" href="${xml(entry.url)}"/><updated>${entry.updated}</updated>${entry.author ? `<author><name>${xml(entry.author)}</name></author>` : ''}${(entry.categories ?? []).map(category => `<category term="${xml(category)}"/>`).join('')}<summary type="text">${xml(entry.summary)}</summary></entry>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><id>${xml(feed.id)}</id><title>${xml(feed.title)}</title><subtitle>${xml(feed.subtitle)}</subtitle><link rel="alternate" type="text/html" href="${xml(feed.url)}"/><link rel="self" type="application/atom+xml" href="${xml(feed.self)}"/><updated>${feed.updated}</updated><author><name>Gitflare</name></author><generator uri="https://gitflare.io">Gitflare</generator>${entries}</feed>\n`;
}

export function rss(feed: Feed): string {
  const date = (value: string) => new Date(value).toUTCString();
  const items = feed.entries.map(entry => `<item><title>${xml(entry.title)}</title><link>${xml(entry.url)}</link><guid isPermaLink="false">${xml(entry.id)}</guid><pubDate>${date(entry.updated)}</pubDate>${entry.author ? `<dc:creator>${xml(entry.author)}</dc:creator>` : ''}${(entry.categories ?? []).map(category => `<category>${xml(category)}</category>`).join('')}<description>${xml(entry.summary)}</description></item>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>${xml(feed.title)}</title><link>${xml(feed.url)}</link><description>${xml(feed.subtitle)}</description><atom:link href="${xml(feed.self)}" rel="self" type="application/rss+xml"/><lastBuildDate>${date(feed.updated)}</lastBuildDate><generator>Gitflare</generator>${items}</channel></rss>\n`;
}

function person(people: Record<string, { name: string; handle: string | null }>, id: string): string | null {
  if (id.startsWith('github:')) return id.slice('github:'.length);
  const found = people[id];
  return found ? found.handle ?? found.name : null;
}

async function entries(env: AppEnv, access: SecurityService, target: PublicTarget, kind: FeedKind, url: string, fallback: string): Promise<FeedEntry[]> {
  const { repository } = target;
  const records = env.GITFLARE_COORDINATOR.getByName(`repository:${repository.id}`);
  if (kind === 'releases') {
    const releases = (await records.listReleases() as Release[]).filter(release => !release.draft && release.publishedAt).sort((a, b) => b.publishedAt!.localeCompare(a.publishedAt!)).slice(0, FEED_ENTRIES);
    const people = await access.profiles([...new Set(releases.map(release => release.authorId))]).catch(() => ({}));
    return releases.map(release => ({ id: `${url}/releases#${release.tag}`, title: line(release.name || release.tag), url: `${url}/releases#${encodeURIComponent(release.tag)}`, updated: iso(release.publishedAt, fallback), author: person(people, release.authorId), summary: text(release.notes || release.tag), categories: release.prerelease ? ['prerelease'] : [] }));
  }
  if (kind === 'issues') {
    const list = await records.listIssues({ state: 'all', limit: FEED_ENTRIES }) as IssueList;
    const issues: Issue[] = [...list.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const people = await access.profiles([...new Set(issues.map(issue => issue.authorId).filter(id => !id.startsWith('github:')))]).catch(() => ({}));
    return issues.map(issue => ({ id: `${url}/issues/${issue.number}`, title: `#${issue.number} ${line(issue.title)}`, url: `${url}/issues/${issue.number}`, updated: iso(issue.createdAt, fallback), author: person(people, issue.authorId), summary: text(issue.body), categories: [issue.state, ...issue.labels] }));
  }
  using source = await env.ARTIFACTS!.get(repository.name);
  const commits = await source.log({ ref: repository.defaultBranch, limit: FEED_ENTRIES }).catch(() => []);
  return commits.map(commit => ({ id: `${url}/commit/${commit.hash}`, title: line(commit.message), url: `${url}?ref=${commit.hash}`, updated: fallback, author: null, summary: text(commit.message) }));
}

export async function buildFeed(env: AppEnv, access: SecurityService, target: PublicTarget, kind: FeedKind, format: FeedFormat, origin: string): Promise<string> {
  const { url } = publicUrls(origin, target.handle, target.repository);
  const name = `${target.handle}/${repositoryLabel(target.repository)}`;
  const fallback = iso(target.repository.updatedAt, new Date(0).toISOString());
  const items = await entries(env, access, target, kind, url, fallback);
  const updated = items.reduce((latest, entry) => entry.updated > latest ? entry.updated : latest, fallback);
  const feed: Feed = { id: `${url}/${kind}`, title: `${name} ${kind}`, subtitle: kind === 'commits' ? `Commits on ${target.repository.defaultBranch}` : kind === 'releases' ? 'Published releases' : 'Issues', url: kind === 'commits' ? `${url}/commits` : `${url}/${kind}`, self: `${url}/${kind}.${format}`, updated, entries: items };
  return format === 'atom' ? atom(feed) : rss(feed);
}

export async function feedResponse(request: Request, env: AppEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const match = FEED_PATH.exec(url.pathname);
  if (!match || request.method !== 'GET' && request.method !== 'HEAD') return null;
  const notFound = () => new Response('Not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  if (!env.GITFLARE_SECURITY || !env.ARTIFACTS || env.EDITION === 'self-hosted' || env.DEMO_MODE === 'true') return notFound();
  const limited = await consume(env, 'PUBLIC_READ_RATE_LIMIT', `ip:${clientIp(request)}`);
  if (limited) return rateLimitedResponse(limited, 'public repository requests');
  let handle: string; let name: string;
  try { handle = decodeURIComponent(match[1]!).toLowerCase(); name = decodeURIComponent(match[2]!); } catch { return notFound(); }
  const access = securityClient(env);
  const target = await resolvePublicRepository(env, access, handle, name);
  if (!target) return notFound();
  if ('redirect' in target) return new Response(null, { status: 308, headers: { Location: `/${target.redirect}/${encodeURIComponent(name)}/${match[3]}.${match[4]}`, 'Cache-Control': 'no-store' } });
  const body = await buildFeed(env, access, target, match[3] as FeedKind, match[4] as FeedFormat, siteOrigin(env, url.origin));
  return new Response(request.method === 'HEAD' ? null : body, { headers: { 'Content-Type': TYPES[match[4] as FeedFormat], 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Access-Control-Allow-Origin': '*' } });
}
