import schema from '../../migrations/public-index/0001_init.sql?raw';
import activitySchema from '../../migrations/public-index/0002_activity.sql?raw';
import factsSchema from '../../migrations/public-index/0003_facts.sql?raw';
import type { ActivityWeek, AgentReadiness, ExploreFilters, ExploreSort, Issue, MissionSummary, PublicActivity, PublicExplore, Release, PublicHandleKind, PublicPathMatch, PublicPerson, PublicRepositoryCard, PublicSearch, PublicSearchType } from '../shared/types';
import { publicRepositoryPath } from '../shared/handles';
import { repositoryLabel } from '../shared/repository-names';
import { ApiError } from './domain';
import type { AppEnv } from './env';
import { scanRepository } from './deploy-detect';
import { detectLicense, publicTargetById } from './public-repositories';
import { securityClient, type PublicListing, type SecurityService } from './security';
import { ACTIVITY_WEEKS, activityWeeks, agentReadiness, parseReadiness, READINESS_FILES, sumWeeks, weekStart } from './public-activity';

export const PUBLIC_INDEX_PATH_LIMIT = 20_000;
export const PUBLIC_INDEX_PAGE = 20;
export const PUBLIC_INDEX_CURSOR_MAX = 1000;
export const PUBLIC_INDEX_CRON = '30 4 * * *';
const PATH_CHUNK = 1000;
const LANGUAGE_LIMIT = 12;
const FACET_LIMIT = 12;
const TRENDING_WEEKS = 4;
const READY_SCORE = 70;
const TOPIC_SCAN = 500;
const RECONCILE_CONCURRENCY = 4;
const BACKFILL_INTERVAL_MS = 10 * 60_000;
const ready = new WeakSet<D1Database>();
const backfilled = new WeakMap<D1Database, number>();

const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', py: 'Python', rs: 'Rust', go: 'Go', rb: 'Ruby',
  java: 'Java', kt: 'Kotlin', swift: 'Swift', c: 'C', h: 'C', cc: 'C++', cpp: 'C++', hpp: 'C++', cs: 'C#', php: 'PHP', scala: 'Scala', ex: 'Elixir', exs: 'Elixir', erl: 'Erlang', hs: 'Haskell',
  lua: 'Lua', dart: 'Dart', zig: 'Zig', sh: 'Shell', bash: 'Shell', css: 'CSS', scss: 'SCSS', html: 'HTML', vue: 'Vue', svelte: 'Svelte', sql: 'SQL', r: 'R', jl: 'Julia', ml: 'OCaml', clj: 'Clojure',
};

type RepositoryRow = { repository_id: string; workspace_id: string; handle: string; name: string; description: string; topics: string; language: string | null; license: string | null; stars: number; updated_at: string; published_at: string };
type PathRow = { repository_id: string; workspace_id: string; handle: string; name: string; path: string };
type HandleRow = { handle: string; kind: string; display_name: string };
type ActivityRow = { repository_id: string; week: string; landed_people: number; landed_agents: number; missions_run: number; reviews: number; releases: number; issues_opened: number };
type ReadinessRow = { repository_id: string; score: number; signals: string };
type IssuePager = { listIssues(query: { state: 'all'; offset: number; limit: number }): Promise<{ items: Issue[]; nextOffset: number | null }> };
const ACTIVITY_ISSUE_PAGE = 500;
const WEEK_MS = 7 * 86_400_000;
const READINESS_FILE_MAX = 65_536;
export type IndexEnv = Pick<AppEnv, 'PUBLIC_INDEX' | 'EDITION' | 'DEMO_MODE'>;
export interface IndexedPage<T> { value: T; repositoryIds: string[]; stale: string[] }

export function publicIndex(env: IndexEnv): D1Database | null {
  return env.EDITION === 'self-hosted' || env.DEMO_MODE === 'true' ? null : env.PUBLIC_INDEX ?? null;
}

export async function preparedIndex(db: D1Database): Promise<D1Database> {
  if (ready.has(db)) return db;
  await db.batch(`${schema}${activitySchema}${factsSchema}`.split(';').map(statement => statement.trim()).filter(Boolean).map(statement => db.prepare(statement)));
  ready.add(db);
  return db;
}

export function dominantLanguage(paths: Iterable<string>): string | null {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
    const language = extension ? LANGUAGES[extension] : undefined;
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, character => `\\${character}`)}%`;
}

export function searchQuery(value: string | null): string {
  const query = (value ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (query.length < 2 || query.length > 100) throw new ApiError(400, 'INVALID_QUERY', 'Search for 2 to 100 characters.');
  return query;
}

export function pageCursor(value: string | null): number {
  const cursor = Number(value ?? 0);
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > PUBLIC_INDEX_CURSOR_MAX) throw new ApiError(400, 'INVALID_CURSOR', 'The page cursor is not valid.');
  return cursor;
}

type CardRow = RepositoryRow & { readiness_score?: number | null; release_count?: number | null; landed_at?: string | null };

function card(row: CardRow): PublicRepositoryCard {
  const readiness = parseReadiness(row.readiness_score, null);
  return {
    handle: row.handle, name: row.name, description: row.description, language: row.language, topics: row.topics ? row.topics.split(',').filter(Boolean) : [], license: row.license,
    stars: row.stars, updatedAt: row.updated_at, publishedAt: row.published_at, url: publicRepositoryPath(row.handle, row.name), agentReady: readiness && { score: readiness.score, level: readiness.level },
    ...(row.release_count !== undefined ? { releases: row.release_count ?? 0, landedAt: row.landed_at ?? null } : {}),
  };
}

async function stillPublic(access: SecurityService, rows: { repository_id: string; workspace_id: string }[]): Promise<{ live: Set<string>; stale: string[] }> {
  const ids = [...new Set(rows.map(row => row.repository_id))];
  const listings = await access.publicListed(ids);
  const owner = new Map(rows.map(row => [row.repository_id, row.workspace_id]));
  const live = new Set(ids.filter((id, index) => listings[index]?.workspaceId === owner.get(id)));
  return { live, stale: ids.filter(id => !live.has(id)) };
}

function nextCursor(cursor: number, rows: unknown[]): number | null {
  return rows.length > PUBLIC_INDEX_PAGE && cursor + PUBLIC_INDEX_PAGE <= PUBLIC_INDEX_CURSOR_MAX ? cursor + PUBLIC_INDEX_PAGE : null;
}

function topTopics(lists: string[]): string[] {
  const counts = new Map<string, number>();
  for (const topic of lists.flatMap(list => list.split(',')).filter(Boolean)) counts.set(topic, (counts.get(topic) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, FACET_LIMIT).map(([topic]) => topic);
}

const EXPLORE_ORDER: Record<ExploreSort, string> = {
  stars: 'r.stars DESC, r.updated_at DESC',
  trending: 'COALESCE(t.recent, 0) DESC, r.stars DESC, r.updated_at DESC',
  landed: 'COALESCE(f.landed_at, r.updated_at) DESC',
  updated: 'r.updated_at DESC',
  new: 'r.published_at DESC',
  name: 'lower(r.name) ASC, r.handle ASC',
};

export async function explorePublic(env: IndexEnv, access: SecurityService, sort: ExploreSort, filters: ExploreFilters, cursor: number, now = Date.now()): Promise<IndexedPage<PublicExplore>> {
  const empty: PublicExplore = { ...filters, sort, items: [], languages: [], licenses: [], topics: [], total: 0, nextCursor: null, indexed: false };
  const db = publicIndex(env);
  if (!db) return { value: empty, repositoryIds: [], stale: [] };
  await preparedIndex(db);
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  const bind = (value: string | number) => { values.push(value); return `?${values.length}`; };
  if (filters.language) conditions.push(`r.language = ${bind(filters.language)}`);
  if (filters.license) conditions.push(`r.license = ${bind(filters.license)}`);
  if (filters.topic) conditions.push(`(',' || r.topics || ',') LIKE ${bind(likePattern(`,${filters.topic},`))} ESCAPE '\\'`);
  if (filters.releases) conditions.push('COALESCE(f.releases, 0) > 0');
  if (filters.agentReady) conditions.push(`COALESCE(a.score, 0) >= ${READY_SCORE}`);
  if (filters.query) {
    const pattern = bind(likePattern(filters.query));
    conditions.push(`(r.name LIKE ${pattern} ESCAPE '\\' OR r.description LIKE ${pattern} ESCAPE '\\' OR r.topics LIKE ${pattern} ESCAPE '\\' OR r.handle LIKE ${pattern} ESCAPE '\\')`);
  }
  const since = weekStart(now - (TRENDING_WEEKS - 1) * WEEK_MS);
  const recent = sort === 'trending' ? `LEFT JOIN (SELECT repository_id, SUM(landed_people + landed_agents + missions_run + reviews + releases + issues_opened) AS recent FROM activity WHERE week >= ${bind(since)} GROUP BY repository_id) t ON t.repository_id = r.repository_id` : '';
  const from = `FROM repositories r LEFT JOIN readiness a ON a.repository_id = r.repository_id LEFT JOIN facts f ON f.repository_id = r.repository_id ${recent} ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}`;
  const facet = (column: string) => db.prepare(`SELECT ${column} AS value FROM repositories WHERE ${column} IS NOT NULL AND ${column} <> '' GROUP BY ${column} ORDER BY COUNT(*) DESC, ${column} LIMIT ${column === 'language' ? LANGUAGE_LIMIT : FACET_LIMIT}`).all<{ value: string }>();
  const [rows, total, languages, licenses, topics] = await Promise.all([
    db.prepare(`SELECT r.*, a.score AS readiness_score, f.releases AS release_count, f.landed_at ${from} ORDER BY ${EXPLORE_ORDER[sort]}, r.repository_id LIMIT ${PUBLIC_INDEX_PAGE + 1} OFFSET ${cursor}`).bind(...values).all<CardRow>(),
    db.prepare(`SELECT COUNT(*) AS count ${from}`).bind(...values).first<{ count: number }>(),
    facet('language'),
    facet('license'),
    db.prepare(`SELECT topics FROM repositories WHERE topics <> '' LIMIT ${TOPIC_SCAN}`).all<{ topics: string }>(),
  ]);
  const { live, stale } = await stillPublic(access, rows.results);
  const items = rows.results.slice(0, PUBLIC_INDEX_PAGE).filter(row => live.has(row.repository_id));
  return {
    value: { ...empty, items: items.map(card), languages: languages.results.map(row => row.value), licenses: licenses.results.map(row => row.value), topics: topTopics(topics.results.map(row => row.topics)), total: Math.max(0, (total?.count ?? 0) - stale.length), nextCursor: nextCursor(cursor, rows.results), indexed: true },
    repositoryIds: items.map(row => row.repository_id), stale,
  };
}

export async function searchPublic(env: IndexEnv, access: SecurityService, query: string, type: PublicSearchType, cursor: number): Promise<IndexedPage<PublicSearch>> {
  const empty: PublicSearch = { query, type, repositories: [], paths: [], people: [], nextCursor: null, indexed: false };
  const db = publicIndex(env);
  if (!db) return { value: empty, repositoryIds: [], stale: [] };
  await preparedIndex(db);
  const pattern = likePattern(query);
  const page = `LIMIT ${PUBLIC_INDEX_PAGE + 1} OFFSET ${cursor}`;
  if (type === 'people') {
    const rows = await db.prepare(`SELECT handle, kind, display_name FROM handles WHERE handle LIKE ?1 ESCAPE '\\' OR display_name LIKE ?1 ESCAPE '\\' ORDER BY handle = ?2 DESC, handle ${page}`).bind(pattern, query.toLowerCase()).all<HandleRow>();
    const people: PublicPerson[] = rows.results.slice(0, PUBLIC_INDEX_PAGE).map(row => ({ handle: row.handle, kind: (row.kind === 'user' ? 'user' : 'workspace') as PublicHandleKind, displayName: row.display_name || row.handle, url: `/${row.handle}` }));
    return { value: { ...empty, people, nextCursor: nextCursor(cursor, rows.results), indexed: true }, repositoryIds: [], stale: [] };
  }
  if (type === 'paths') {
    const rows = await db.prepare(`SELECT p.repository_id, r.workspace_id, r.handle, r.name, p.path FROM paths p JOIN repositories r ON r.repository_id = p.repository_id WHERE p.path LIKE ?1 ESCAPE '\\' ORDER BY r.stars DESC, length(p.path), p.path ${page}`).bind(pattern).all<PathRow>();
    const { live, stale } = await stillPublic(access, rows.results);
    const matches = rows.results.slice(0, PUBLIC_INDEX_PAGE).filter(row => live.has(row.repository_id));
    const paths: PublicPathMatch[] = matches.map(row => ({ handle: row.handle, repository: row.name, path: row.path, url: publicRepositoryPath(row.handle, row.name, 'blob', row.path) }));
    return { value: { ...empty, paths, nextCursor: nextCursor(cursor, rows.results), indexed: true }, repositoryIds: [...new Set(matches.map(row => row.repository_id))], stale };
  }
  const rows = await db.prepare(`SELECT r.*, a.score AS readiness_score FROM repositories r LEFT JOIN readiness a ON a.repository_id = r.repository_id WHERE name LIKE ?1 ESCAPE '\\' OR description LIKE ?1 ESCAPE '\\' OR topics LIKE ?1 ESCAPE '\\' OR handle LIKE ?1 ESCAPE '\\' ORDER BY lower(name) = ?2 DESC, stars DESC, updated_at DESC, r.repository_id ${page}`).bind(pattern, query.toLowerCase()).all<RepositoryRow>();
  const { live, stale } = await stillPublic(access, rows.results);
  const items = rows.results.slice(0, PUBLIC_INDEX_PAGE).filter(row => live.has(row.repository_id));
  return { value: { ...empty, repositories: items.map(card), nextCursor: nextCursor(cursor, rows.results), indexed: true }, repositoryIds: items.map(row => row.repository_id), stale };
}

export async function indexedDetails(env: IndexEnv, repositoryIds: string[]): Promise<Map<string, Pick<PublicRepositoryCard, 'language' | 'license' | 'topics' | 'agentReady'>>> {
  const db = publicIndex(env);
  if (!db || !repositoryIds.length) return new Map();
  await preparedIndex(db);
  const rows = await db.prepare('SELECT r.repository_id, r.language, r.license, r.topics, a.score FROM repositories r LEFT JOIN readiness a ON a.repository_id = r.repository_id WHERE r.repository_id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(repositoryIds)).all<Pick<RepositoryRow, 'repository_id' | 'language' | 'license' | 'topics'> & { score: number | null }>();
  return new Map(rows.results.map(row => {
    const readiness = parseReadiness(row.score, null);
    return [row.repository_id, { language: row.language, license: row.license, topics: row.topics ? row.topics.split(',').filter(Boolean) : [], agentReady: readiness && { score: readiness.score, level: readiness.level } }];
  }));
}

export async function repositoryReadiness(env: IndexEnv, repositoryId: string): Promise<AgentReadiness | null> {
  const db = publicIndex(env);
  if (!db) return null;
  await preparedIndex(db);
  const row = await db.prepare('SELECT repository_id, score, signals FROM readiness WHERE repository_id = ?1').bind(repositoryId).first<ReadinessRow>();
  return row ? parseReadiness(row.score, row.signals) : null;
}

function activityRow(row: ActivityRow): ActivityWeek {
  return { week: row.week, people: row.landed_people, agents: row.landed_agents, missions: row.missions_run, reviews: row.reviews, releases: row.releases, issues: row.issues_opened };
}

export async function repositoryActivity(env: IndexEnv, repositoryIds: string[], now = Date.now()): Promise<PublicActivity> {
  const db = publicIndex(env);
  const since = weekStart(now - (ACTIVITY_WEEKS - 1) * WEEK_MS);
  if (!db || !repositoryIds.length) { const { weeks, totals } = sumWeeks([], now); return { since, weeks, totals, repositories: repositoryIds.length, indexed: !!db }; }
  await preparedIndex(db);
  const rows = await db.prepare('SELECT * FROM activity WHERE repository_id IN (SELECT value FROM json_each(?1)) AND week >= ?2').bind(JSON.stringify(repositoryIds), since).all<ActivityRow>();
  const groups = new Map<string, ActivityWeek[]>();
  for (const row of rows.results) groups.set(row.repository_id, [...(groups.get(row.repository_id) ?? []), activityRow(row)]);
  const { weeks, totals } = sumWeeks([...groups.values()], now);
  return { since, weeks, totals, repositories: repositoryIds.length, indexed: true };
}

async function collectIssues(records: IssuePager, since: string): Promise<Pick<Issue, 'createdAt'>[]> {
  const found: Pick<Issue, 'createdAt'>[] = [];
  for (let offset: number | null = 0; offset !== null;) {
    const page = await records.listIssues({ state: 'all', offset, limit: ACTIVITY_ISSUE_PAGE });
    found.push(...page.items.map(issue => ({ createdAt: issue.createdAt })));
    if (page.items.length && page.items.every(issue => issue.createdAt < since)) break;
    offset = page.nextOffset;
  }
  return found;
}

export async function removeIndexedRepositories(env: IndexEnv, repositoryIds: string[]): Promise<void> {
  const db = publicIndex(env);
  if (!db || !repositoryIds.length) return;
  await preparedIndex(db);
  const ids = JSON.stringify(repositoryIds);
  await db.batch([
    db.prepare('DELETE FROM paths WHERE repository_id IN (SELECT value FROM json_each(?1))').bind(ids),
    db.prepare('DELETE FROM activity WHERE repository_id IN (SELECT value FROM json_each(?1))').bind(ids),
    db.prepare('DELETE FROM readiness WHERE repository_id IN (SELECT value FROM json_each(?1))').bind(ids),
    db.prepare('DELETE FROM facts WHERE repository_id IN (SELECT value FROM json_each(?1))').bind(ids),
    db.prepare('DELETE FROM repositories WHERE repository_id IN (SELECT value FROM json_each(?1))').bind(ids),
  ]);
}

export async function updateIndexedStars(env: IndexEnv, repositoryId: string, stars: number): Promise<void> {
  const db = publicIndex(env);
  if (!db) return;
  await preparedIndex(db);
  await db.prepare('UPDATE repositories SET stars = ?1 WHERE repository_id = ?2').bind(stars, repositoryId).run();
}

async function indexHandle(db: D1Database, access: SecurityService, workspaceId: string, handle: string): Promise<void> {
  const [resolved, profile] = await Promise.all([access.resolveHandle(handle), access.profileOf(workspaceId)]);
  const kind = resolved && 'kind' in resolved ? resolved.kind : 'workspace';
  await db.batch([
    db.prepare('DELETE FROM handles WHERE workspace_id = ?1 AND handle <> ?2').bind(workspaceId, handle),
    db.prepare('INSERT INTO handles (handle, kind, workspace_id, display_name, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (handle) DO UPDATE SET kind = excluded.kind, workspace_id = excluded.workspace_id, display_name = excluded.display_name, updated_at = excluded.updated_at')
      .bind(handle, kind, workspaceId, profile?.displayName ?? '', new Date().toISOString()),
  ]);
}

export async function indexPublicRepository(env: AppEnv, repositoryId: string, access: SecurityService = securityClient(env)): Promise<'indexed' | 'removed' | 'skipped'> {
  const db = publicIndex(env);
  if (!db || !env.ARTIFACTS) return 'skipped';
  await preparedIndex(db);
  const target = await publicTargetById(env, access, repositoryId);
  if (!target) { await removeIndexedRepositories(env, [repositoryId]); return 'removed'; }
  const { repository, handle, workspaceId, listing } = target;
  using source = await env.ARTIFACTS.get(repository.name);
  const head = (await source.log({ ref: repository.defaultBranch, limit: 1 }).catch(() => []))[0];
  const existing = await db.prepare('SELECT head_sha, language, paths_truncated FROM repositories WHERE repository_id = ?1').bind(repositoryId).first<{ head_sha: string | null; language: string | null; paths_truncated: number }>();
  let language = existing?.language ?? null;
  let truncated = existing?.paths_truncated ?? 0;
  const writes: D1PreparedStatement[] = [];
  if (!head) {
    language = null; truncated = 0;
    writes.push(db.prepare('DELETE FROM paths WHERE repository_id = ?1').bind(repositoryId), db.prepare('DELETE FROM readiness WHERE repository_id = ?1').bind(repositoryId));
  } else if (head.hash !== existing?.head_sha) {
    const scan = await scanRepository(source, head.hash, PUBLIC_INDEX_PATH_LIMIT);
    const paths = [...scan.files.keys()].sort().slice(0, PUBLIC_INDEX_PATH_LIMIT);
    language = dominantLanguage(paths); truncated = scan.truncated ? 1 : 0;
    writes.push(db.prepare('DELETE FROM paths WHERE repository_id = ?1').bind(repositoryId));
    for (let start = 0; start < paths.length; start += PATH_CHUNK) writes.push(db.prepare('INSERT OR IGNORE INTO paths (repository_id, path) SELECT ?1, value FROM json_each(?2)').bind(repositoryId, JSON.stringify(paths.slice(start, start + PATH_CHUNK))));
    const files = Object.fromEntries(await Promise.all(READINESS_FILES.map(async path => [path, scan.files.has(path) ? await source.readFile({ ref: head.hash, path }).then(blob => blob && blob.size <= READINESS_FILE_MAX ? blob.text() : null).catch(() => null) : null] as const)));
    const readiness = agentReadiness(paths, files);
    writes.push(db.prepare('INSERT INTO readiness (repository_id, score, signals) VALUES (?1, ?2, ?3) ON CONFLICT (repository_id) DO UPDATE SET score = excluded.score, signals = excluded.signals').bind(repositoryId, readiness.score, JSON.stringify(readiness.signals)));
  }
  const records = env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`);
  const now = Date.now();
  const since = weekStart(now - (ACTIVITY_WEEKS - 1) * WEEK_MS);
  const [missions, releases, issues] = await Promise.all([
    Promise.resolve().then(() => records.listMissionSummaries() as Promise<MissionSummary[]>).catch(() => [] as MissionSummary[]),
    Promise.resolve().then(() => records.listReleases() as Promise<Release[]>).catch(() => [] as Release[]),
    collectIssues(records as unknown as IssuePager, since).catch(() => [] as Pick<Issue, 'createdAt'>[]),
  ]);
  writes.push(db.prepare('DELETE FROM activity WHERE repository_id = ?1').bind(repositoryId));
  const landedAt = missions.filter(mission => mission.status === 'integrated').map(mission => mission.updatedAt).sort().at(-1) ?? null;
  writes.push(db.prepare('INSERT INTO facts (repository_id, releases, landed_at) VALUES (?1, ?2, ?3) ON CONFLICT (repository_id) DO UPDATE SET releases = excluded.releases, landed_at = excluded.landed_at')
    .bind(repositoryId, releases.filter(release => !release.draft && release.publishedAt).length, landedAt));
  for (const week of activityWeeks({ missions, releases, issues, now })) {
    if (!week.people && !week.agents && !week.missions && !week.reviews && !week.releases && !week.issues) continue;
    writes.push(db.prepare('INSERT INTO activity (repository_id, week, landed_people, landed_agents, missions_run, reviews, releases, issues_opened) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)').bind(repositoryId, week.week, week.people, week.agents, week.missions, week.reviews, week.releases, week.issues));
  }
  const [license, [stats]] = await Promise.all([head ? detectLicense(source, head.hash).catch(() => null) : Promise.resolve(null), access.repositoryStats([repositoryId])]);
  writes.push(db.prepare(`INSERT INTO repositories (repository_id, workspace_id, handle, name, description, topics, language, license, stars, head_sha, paths_truncated, published_at, updated_at, indexed_at)
    VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
    ON CONFLICT (repository_id) DO UPDATE SET workspace_id = excluded.workspace_id, handle = excluded.handle, name = excluded.name, description = excluded.description, language = excluded.language, license = excluded.license,
      stars = excluded.stars, head_sha = excluded.head_sha, paths_truncated = excluded.paths_truncated, published_at = excluded.published_at, updated_at = excluded.updated_at, indexed_at = excluded.indexed_at`)
    .bind(repositoryId, workspaceId, handle, repositoryLabel(repository), repository.description.slice(0, 500), language, license?.spdx ?? null, stats?.stars ?? 0, head?.hash ?? null, truncated, listing.publishedAt, repository.updatedAt || listing.publishedAt, new Date().toISOString()));
  await db.batch(writes);
  await indexHandle(db, access, workspaceId, handle);
  return 'indexed';
}

export async function indexWorkspaceRepositories(env: AppEnv, workspaceId: string, access: SecurityService = securityClient(env)): Promise<void> {
  const db = publicIndex(env);
  if (!db) return;
  await preparedIndex(db);
  const listed = (await access.publicListings()).filter(listing => listing.workspaceId === workspaceId);
  const indexed = await db.prepare('SELECT repository_id FROM repositories WHERE workspace_id = ?1').bind(workspaceId).all<{ repository_id: string }>();
  for (const id of new Set([...listed.map(listing => listing.repositoryId), ...indexed.results.map(row => row.repository_id)])) await indexPublicRepository(env, id, access);
  if (!listed.length) await db.prepare('DELETE FROM handles WHERE workspace_id = ?1').bind(workspaceId).run();
}

export async function refreshIndexedHandle(env: AppEnv, workspaceId: string, access: SecurityService = securityClient(env)): Promise<void> {
  const db = publicIndex(env);
  if (!db) return;
  await preparedIndex(db);
  const [handle, listed] = await Promise.all([access.handleOf(workspaceId), access.publicListings()]);
  if (handle && listed.some(listing => listing.workspaceId === workspaceId)) await indexHandle(db, access, workspaceId, handle);
}

export async function reconcilePublicIndex(env: AppEnv, access: SecurityService = securityClient(env)): Promise<{ indexed: number; removed: number; failed: number }> {
  const db = publicIndex(env);
  if (!db) return { indexed: 0, removed: 0, failed: 0 };
  await preparedIndex(db);
  const listings: PublicListing[] = await access.publicListings();
  const listed = new Set(listings.map(listing => listing.repositoryId));
  const result = { indexed: 0, removed: 0, failed: 0 };
  const queue = [...listings];
  await Promise.all(Array.from({ length: RECONCILE_CONCURRENCY }, async () => {
    for (let listing = queue.shift(); listing; listing = queue.shift()) {
      try { const outcome = await indexPublicRepository(env, listing.repositoryId, access); if (outcome === 'indexed') result.indexed++; else if (outcome === 'removed') result.removed++; }
      catch (error) { result.failed++; console.warn(JSON.stringify({ event: 'public_index_reconcile_failed', repositoryId: listing.repositoryId, name: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message.slice(0, 200) : '' })); }
    }
  }));
  const rows = await db.prepare('SELECT repository_id FROM repositories').all<{ repository_id: string }>();
  const stale = rows.results.map(row => row.repository_id).filter(id => !listed.has(id));
  await removeIndexedRepositories(env, stale);
  result.removed += stale.length;
  const workspaces = [...new Set(listings.map(listing => listing.workspaceId))];
  await db.prepare('DELETE FROM handles WHERE workspace_id NOT IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(workspaces)).run();
  return result;
}

export async function indexedRepositoryCount(env: IndexEnv): Promise<number | null> {
  const db = publicIndex(env);
  if (!db) return null;
  await preparedIndex(db);
  return (await db.prepare('SELECT COUNT(*) AS n FROM repositories').first<{ n: number }>())?.n ?? 0;
}

export async function backfillEmptyIndex(env: AppEnv, access: SecurityService = securityClient(env), now = Date.now()): Promise<boolean> {
  const db = publicIndex(env);
  if (!db || now - (backfilled.get(db) ?? -Infinity) < BACKFILL_INTERVAL_MS) return false;
  backfilled.set(db, now);
  await preparedIndex(db);
  if (await db.prepare('SELECT 1 FROM repositories LIMIT 1').first()) return false;
  if (!(await access.publicListings()).length) return false;
  console.log(JSON.stringify({ event: 'public_index_backfilled', ...await reconcilePublicIndex(env, access) }));
  return true;
}
