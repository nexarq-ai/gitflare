import type { IssueDetail, IssueList, IssuePerson, PublicActivity, PublicExplore, PublicFile, PublicHistory, PublicProfile, PublicReleases, PublicRepositoryCard, PublicRepositorySummary, PublicTree } from '../shared/types';
import { publicRepositoryPath, type PublicRepositoryView } from '../shared/handles';
import { exploreStateFrom } from '../shared/explore';
import { exploreRequest, publicProfileRequests, publicRepositoryRequests } from '../ui/public-requests';
import { publicProfileLocation, publicRepositoryLocation, routeFromLocation, type PublicRepositoryLocation } from '../ui/router';
import { escapeHtml, markdownSummary, markdownToHtml } from './markdown-html';
import type { AppEnv } from './env';
import { publicError } from './domain';
import { servePublicCached } from './public-cache';
import { publicShellVisit } from './public-preload';
import { clientIp, consume } from './rate-limits';
import { searchRole } from './search-indexing';

export const SSR_CONTAINER_ID = 'gitflare-ssr';
export const SSR_FILE_MAX = 100_000;
export const SSR_TREE_MAX = 500;
export const SSR_LIST_MAX = 100;
const SSR_RELEASE_MAX = 20;
const SSR_COMMENT_MAX = 50;
const TITLE_DESCRIPTION_MAX = 90;
const DESCRIPTION_MAX = 200;

export interface Loaded<T> { status: number; data: T | null; location: string | null }
export type PublicLoader = <T>(path: string) => Promise<Loaded<T>>;
export type ServerTarget = { kind: 'repository'; location: PublicRepositoryLocation; ref: string } | { kind: 'profile'; handle: string } | { kind: 'explore'; search: string };
export interface ServerPage { status: number; location?: string; title?: string; description?: string; head: string; body: string }

const STYLE = `<style>#${SSR_CONTAINER_ID}~#root{visibility:hidden;height:0;overflow:hidden}.ssr{--ssr-text:var(--gf-color-text,#eceef1);--ssr-muted:var(--gf-color-text-secondary,#9aa0ab);--ssr-border:var(--gf-color-border,rgba(255,255,255,.09));--ssr-accent:var(--gf-color-accent,#f6821f);min-height:100vh;color:var(--ssr-text);background:var(--gf-color-bg,#08090b);font:15px/1.6 var(--gf-font-sans,'Instrument Sans',system-ui,sans-serif)}html[data-theme=light] .ssr{--ssr-text:#18212f;--ssr-muted:#4d596b;--ssr-border:rgba(24,33,47,.12);background:#fff}.ssr a{color:inherit}.ssr-top{max-width:1180px;margin:0 auto;padding:18px 24px;display:flex;align-items:center;gap:20px}.ssr-brand{display:inline-flex;align-items:center;gap:10px;font-weight:600;font-size:18px;text-decoration:none}.ssr-top nav{display:flex;gap:18px;margin-left:auto;font-size:14px}.ssr-top nav a,.ssr-muted,.ssr-crumbs{color:var(--ssr-muted);text-decoration:none}.ssr-main{max-width:1180px;margin:0 auto;padding:8px 24px 48px}.ssr-crumbs ol{display:flex;flex-wrap:wrap;gap:6px;list-style:none;margin:0 0 12px;padding:0;font-size:13px}.ssr-crumbs li+li:before{content:"/";margin-right:6px}.ssr h1{font-size:30px;line-height:1.2;margin:4px 0 8px;overflow-wrap:anywhere}.ssr-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:18px 0;padding:0;list-style:none}.ssr-tabs a{display:inline-block;padding:6px 12px;border:1px solid var(--ssr-border);border-radius:99px;text-decoration:none;font-size:14px}.ssr-tabs a[aria-current]{border-color:var(--ssr-accent)}.ssr-facts{display:flex;flex-wrap:wrap;gap:8px 24px;margin:12px 0;font-size:14px}.ssr-facts div{display:flex;gap:6px}.ssr-facts dt{color:var(--ssr-muted)}.ssr-facts dd{margin:0}.ssr-panel{border:1px solid var(--ssr-border);border-radius:12px;padding:16px 20px;margin:16px 0;overflow-wrap:anywhere}.ssr-panel>h2{font-size:15px;margin:0 0 10px}.ssr-list{list-style:none;margin:0;padding:0}.ssr-list li{padding:6px 0;border-top:1px solid var(--ssr-border)}.ssr-list li:first-child{border-top:0}.ssr pre{overflow:auto;padding:14px;border-radius:8px;border:1px solid var(--ssr-border);font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;tab-size:2}.ssr code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}.ssr img{max-width:100%;height:auto}.ssr-table{overflow:auto}.ssr table{border-collapse:collapse}.ssr td,.ssr th{border:1px solid var(--ssr-border);padding:4px 10px}.ssr-markdown h2,.ssr-markdown h3{margin:1.4em 0 .5em;line-height:1.3}.ssr-footer{max-width:1180px;margin:0 auto;padding:24px;border-top:1px solid var(--ssr-border);display:flex;flex-wrap:wrap;gap:16px;font-size:13px}@media(max-width:640px){.ssr-top nav{display:none}.ssr h1{font-size:24px}.ssr-main,.ssr-top{padding-left:16px;padding-right:16px}}</style>`;

export function serverTarget(url: URL): ServerTarget | null {
  const route = routeFromLocation(url.pathname, '');
  if (route === 'explore') return { kind: 'explore', search: url.search };
  const location = publicRepositoryLocation(route);
  if (location) return { kind: 'repository', location, ref: url.searchParams.get('ref') ?? '' };
  const profile = publicProfileLocation(route);
  return profile ? { kind: 'profile', handle: profile.handle } : null;
}

function jsonLd(value: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(value).replace(/</g, '\\u003c')}</script>`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function day(value: string | null | undefined): string {
  return value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';
}

function time(value: string | null | undefined): string {
  const date = day(value);
  return date ? `<time datetime="${escapeHtml(value!)}">${date}</time>` : '';
}

function subject(message: string): string {
  return message.split('\n', 1)[0]!.trim();
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function crumbs(origin: string, items: [string, string][]): { html: string; data: unknown } {
  const html = `<nav class="ssr-crumbs" aria-label="Breadcrumb"><ol>${items.map(([name, path], index) => `<li>${index === items.length - 1 ? `<span aria-current="page">${escapeHtml(name)}</span>` : `<a href="${escapeHtml(path)}">${escapeHtml(name)}</a>`}</li>`).join('')}</ol></nav>`;
  const data = { '@type': 'BreadcrumbList', itemListElement: items.map(([name, path], index) => ({ '@type': 'ListItem', position: index + 1, name, item: `${origin}${path}` })) };
  return { html, data };
}

function frame(main: string): string {
  return `<div id="${SSR_CONTAINER_ID}" class="ssr">${STYLE}<header class="ssr-top"><a class="ssr-brand" href="/"><img src="/logo.svg" alt="Gitflare" width="28" height="28">Gitflare</a><nav aria-label="Main navigation"><a href="/explore">Explore</a><a href="/product">Product</a><a href="/open-source">Open source</a><a href="/docs">Docs</a><a href="/signin">Sign in</a></nav></header><main class="ssr-main">${main}</main><footer class="ssr-footer"><span class="ssr-muted">Gitflare · Git hosting for people and AI agents, built on Cloudflare</span><a href="/explore">Explore repositories</a><a href="/gitflare/gitflare">Gitflare source</a><a href="/docs">Documentation</a></footer></div>`;
}

function repositoryCards(cards: PublicRepositoryCard[], owner: boolean): string {
  return `<ul class="ssr-list">${cards.slice(0, SSR_LIST_MAX).map(card => {
    const path = publicRepositoryPath(card.handle, card.name);
    const facts = [card.language, card.license, `${plural(card.stars, 'star')}`, card.updatedAt ? `updated ${day(card.updatedAt)}` : ''].filter(Boolean).join(' · ');
    return `<li><a href="${escapeHtml(path)}"><strong>${owner ? `${escapeHtml(card.handle)}/` : ''}${escapeHtml(card.name)}</strong></a>${owner ? ` <span class="ssr-muted">by <a href="/${escapeHtml(encodeURIComponent(card.handle))}">@${escapeHtml(card.handle)}</a></span>` : ''}${card.description ? `<div>${escapeHtml(card.description)}</div>` : ''}<div class="ssr-muted">${escapeHtml(facts)}</div></li>`;
  }).join('')}</ul>`;
}

const VIEW_LABELS: Partial<Record<PublicRepositoryView, string>> = { commits: 'Revisions', issues: 'Issues', releases: 'Releases', branches: 'Branches', security: 'Security', agents: 'Agents' };

function activityLine(activity: PublicActivity | null): string {
  if (!activity) return '';
  const { totals } = activity;
  const landed = totals.people + totals.agents;
  if (!landed && !totals.missions && !totals.reviews && !totals.releases && !totals.issues) return '';
  const weeks = activity.weeks.length || 1;
  return `In the last ${plural(weeks, 'week')}: ${plural(landed, 'change')} landed (${totals.agents} by agents, ${totals.people} by people), ${plural(totals.missions, 'mission')} run, ${plural(totals.reviews, 'review')}, ${plural(totals.releases, 'release')} and ${plural(totals.issues, 'issue')} opened.`;
}

function personName(people: Record<string, IssuePerson> | undefined, id: string): { name: string; handle: string | null } {
  const person = people?.[id];
  return { name: person?.name || person?.handle || 'Gitflare user', handle: person?.handle ?? null };
}

function personLink(person: { name: string; handle: string | null }): string {
  return person.handle ? `<a href="/${escapeHtml(encodeURIComponent(person.handle))}">${escapeHtml(person.name)}</a>` : escapeHtml(person.name);
}

async function repositoryPage(target: Extract<ServerTarget, { kind: 'repository' }>, origin: string, load: PublicLoader): Promise<ServerPage | null> {
  const { location, ref } = target;
  const { handle: requestedHandle, repository: requestedName, view, path } = location;
  const requests = publicRepositoryRequests(location, ref);
  const base = requests.summary;
  const issuesPath = view === 'issues' ? path ? `${base}/issues/${path}` : `${base}/issues?${new URLSearchParams({ state: 'open', offset: '0' })}` : null;
  const optional = <T>(url: string | null) => url ? load<T>(url) : Promise.resolve(null);
  const [summary, profile, tree, file, readme, history, releases, activity, issues] = await Promise.all([
    load<PublicRepositorySummary>(base), load<PublicProfile>(publicProfileRequests(requestedHandle).profile),
    optional<PublicTree>(requests.tree), optional<PublicFile>(requests.file), optional<PublicFile>(requests.readme), optional<PublicHistory>(requests.history),
    optional<PublicReleases>(requests.releases), optional<PublicActivity>(requests.activity), optional<IssueList | IssueDetail>(issuesPath),
  ]);
  if (summary.status === 308 && summary.location) {
    const moved = /^\/api\/public\/repos\/([^/?]+)\//.exec(summary.location)?.[1];
    if (!moved) return null;
    const url = new URL(publicRepositoryPath(decodeURIComponent(moved), requestedName, view, path), origin);
    if (ref) url.searchParams.set('ref', ref);
    return { status: 308, location: `${url.pathname}${url.search}`, head: '', body: '' };
  }
  if (summary.status === 404) return { status: 404, head: '', body: '' };
  const repository = summary.data;
  if (summary.status !== 200 || !repository) return null;
  const primary = view === 'blob' ? file : view === 'tree' ? tree : view === 'issues' && path ? issues : null;
  if (primary?.status === 404) return { status: 404, head: '', body: '' };

  const { handle, name } = repository;
  const repoPath = publicRepositoryPath(handle, name);
  const label = `${handle}/${name}`;
  const query = ref ? `?${new URLSearchParams({ ref })}` : '';
  const link = (targetView: PublicRepositoryView, targetPath = '') => `${publicRepositoryPath(handle, name, targetView, targetPath)}${targetView === 'code' || targetView === 'tree' || targetView === 'blob' ? query : ''}`;
  const owner = profile.status === 200 ? profile.data : null;
  const ownerName = owner?.displayName || handle;
  const trail: [string, string][] = [['Gitflare', '/'], [ownerName, `/${encodeURIComponent(handle)}`], [name, repoPath]];
  const segments = path ? path.split('/') : [];
  if (view === 'tree' || view === 'blob') segments.forEach((segment, index) => trail.push([segment, link(index === segments.length - 1 && view === 'blob' ? 'blob' : 'tree', segments.slice(0, index + 1).join('/'))]));
  else if (VIEW_LABELS[view]) trail.push([VIEW_LABELS[view]!, publicRepositoryPath(handle, name, view)]);
  const issue = view === 'issues' && path && issues?.status === 200 ? issues.data as IssueDetail : null;
  if (issue) trail.push([`#${issue.number}`, publicRepositoryPath(handle, name, 'issues', String(issue.number))]);
  const breadcrumb = crumbs(origin, trail);

  const readmeHtml = readme?.status === 200 && readme.data ? markdownToHtml(readme.data.content, { images: readme.data.images, repository: { handle, name, commitSha: readme.data.commitSha, path: readme.data.path }, ref, headingOffset: 1 }) : '';
  const readmeLead = readme?.status === 200 && readme.data ? markdownSummary(readme.data.content) : '';
  const lead = repository.description.trim();
  const repoDescription = clip(lead && readmeLead && lead.length < 120 ? `${lead.replace(/[.!?]?$/, '.')} ${readmeLead}` : lead || readmeLead || `${label}, a public repository on Gitflare.`, DESCRIPTION_MAX);

  const tabs = `<nav aria-label="Repository"><ul class="ssr-tabs">${([['code', 'Code'], ['commits', 'Revisions'], ['issues', 'Issues'], ['releases', 'Releases']] as [PublicRepositoryView, string][]).map(([item, text]) => `<li><a href="${escapeHtml(publicRepositoryPath(handle, name, item))}"${(item === 'code' ? ['code', 'tree', 'blob'].includes(view) : item === view) ? ' aria-current="page"' : ''}>${text}</a></li>`).join('')}</ul></nav>`;
  const repoLine = `<p class="ssr-muted"><a href="/${escapeHtml(encodeURIComponent(handle))}">${escapeHtml(handle)}</a> / <a href="${escapeHtml(repoPath)}">${escapeHtml(name)}</a></p>`;
  const entries = (listing: PublicTree) => {
    const sorted = [...listing.entries].sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1);
    return `<ul class="ssr-list">${sorted.slice(0, SSR_TREE_MAX).map(entry => `<li><a href="${escapeHtml(link(entry.type === 'directory' ? 'tree' : 'blob', entry.path))}">${escapeHtml(entry.name)}${entry.type === 'directory' ? '/' : ''}</a></li>`).join('')}</ul>${sorted.length > SSR_TREE_MAX ? `<p class="ssr-muted">${sorted.length - SSR_TREE_MAX} more entries</p>` : ''}`;
  };

  let heading = label;
  let title = lead ? `${label}: ${clip(lead, TITLE_DESCRIPTION_MAX)}` : label;
  let description = repoDescription;
  let content = '';
  const graph: unknown[] = [];
  const latest = repository.latestRelease;
  const author = { '@type': owner?.kind === 'user' ? 'Person' : 'Organization', name: ownerName, url: `${origin}/${encodeURIComponent(handle)}` };
  graph.push({
    '@type': 'SoftwareSourceCode', '@id': `${origin}${repoPath}#repository`, name: label, url: `${origin}${repoPath}`, codeRepository: `${origin}${repoPath}`, description: repoDescription, author,
    ...(repository.language ? { programmingLanguage: repository.language } : {}), ...(repository.license?.spdx ? { license: `https://spdx.org/licenses/${repository.license.spdx}.html` } : {}),
    ...(day(repository.updatedAt) ? { dateModified: repository.updatedAt } : {}), ...(latest ? { version: latest.tag } : {}),
  });

  if (view === 'code' || view === 'tree') {
    const listing = tree?.status === 200 ? tree.data : null;
    if (view === 'code' && !path) {
      const facts: [string, string][] = [];
      if (repository.license?.spdx) facts.push(['License', escapeHtml(repository.license.spdx)]);
      if (repository.language) facts.push(['Language', escapeHtml(repository.language)]);
      if (latest) facts.push(['Latest release', `<a href="${escapeHtml(`${publicRepositoryPath(handle, name, 'releases')}#release-${encodeURIComponent(latest.tag)}`)}">${escapeHtml(latest.tag)}</a> ${time(latest.publishedAt)}`]);
      facts.push(['Default branch', escapeHtml(repository.defaultBranch)]);
      facts.push(['Stars', String(repository.stars)], ['Watchers', String(repository.watchers)], ['Forks', String(repository.forks ?? 0)]);
      if (day(repository.updatedAt)) facts.push(['Updated', time(repository.updatedAt)]);
      const commit = repository.latestCommit ? `<p>Latest revision: <a href="${escapeHtml(publicRepositoryPath(handle, name, 'commits'))}">${escapeHtml(subject(repository.latestCommit.message))}</a> <code>${escapeHtml(repository.latestCommit.sha.slice(0, 12))}</code></p>` : '';
      const landing = activityLine(activity?.status === 200 ? activity.data : null);
      content = `${lead ? `<p>${escapeHtml(lead)}</p>` : ''}<dl class="ssr-facts">${facts.map(([key, value]) => `<div><dt>${key}</dt><dd>${value}</dd></div>`).join('')}</dl>${commit}${landing ? `<p>${escapeHtml(landing)}</p>` : ''}<p>Clone: <code>git clone ${escapeHtml(repository.cloneUrl)}</code></p>${tabs}`
        + `${listing ? `<section class="ssr-panel" aria-labelledby="ssr-files"><h2 id="ssr-files">Files</h2>${entries(listing)}</section>` : ''}`
        + `${readmeHtml ? `<section class="ssr-panel" aria-labelledby="ssr-readme"><h2 id="ssr-readme">${escapeHtml(readme!.data!.path)}</h2><article class="ssr-markdown">${readmeHtml}</article></section>` : ''}`;
    } else {
      heading = `${path || name}`;
      title = `${path} at ${ref || repository.defaultBranch} · ${label}`;
      description = clip(`Files in ${path} of ${label}. ${repoDescription}`, DESCRIPTION_MAX);
      content = `${repoLine}${tabs}${listing ? `<section class="ssr-panel">${entries(listing)}</section>` : ''}${readmeHtml ? `<section class="ssr-panel"><article class="ssr-markdown">${readmeHtml}</article></section>` : ''}`;
    }
  } else if (view === 'blob') {
    const source = file?.status === 200 ? file.data : null;
    const extension = /\.([A-Za-z0-9]{1,12})$/.exec(path)?.[1]?.toLowerCase();
    heading = segments.at(-1) ?? path;
    title = `${path} at ${ref || repository.defaultBranch} · ${label}`;
    description = clip(`${path} in ${label}${repository.language ? `, a ${repository.language} repository` : ''}. ${repoDescription}`, DESCRIPTION_MAX);
    const code = source ? `<pre><code${extension ? ` class="language-${extension}"` : ''}>${escapeHtml(source.content.slice(0, SSR_FILE_MAX))}</code></pre>${source.content.length > SSR_FILE_MAX ? `<p class="ssr-muted">Showing the first ${SSR_FILE_MAX.toLocaleString('en-US')} characters.</p>` : ''}` : '';
    content = `${repoLine}${tabs}<p class="ssr-muted">${escapeHtml(path)}${source ? ` · ${source.content.split('\n').length} lines · revision <code>${escapeHtml(source.commitSha.slice(0, 12))}</code>` : ''}</p>${code}`;
  } else if (view === 'commits') {
    const list = history?.status === 200 ? history.data!.commits : [];
    heading = 'Revisions';
    title = `Revisions · ${label}`;
    description = clip(`Recent revisions of ${label}${list[0] ? `, latest: ${subject(list[0].message)}` : ''}.`, DESCRIPTION_MAX);
    content = `${repoLine}${tabs}<section class="ssr-panel"><ol class="ssr-list">${list.map(commit => `<li><a href="${escapeHtml(`${repoPath}?${new URLSearchParams({ ref: commit.sha })}`)}">${escapeHtml(subject(commit.message))}</a> <code>${escapeHtml(commit.sha.slice(0, 12))}</code></li>`).join('')}</ol></section>`;
  } else if (view === 'releases') {
    const list = releases?.status === 200 ? releases.data!.releases.slice(0, SSR_RELEASE_MAX) : [];
    heading = 'Releases';
    title = `Releases · ${label}`;
    description = clip(list[0] ? `${plural(list.length, 'release')} of ${label}. Latest: ${list[0].name || list[0].tag}${list[0].publishedAt ? `, ${day(list[0].publishedAt)}` : ''}.` : `Releases of ${label}.`, DESCRIPTION_MAX);
    content = `${repoLine}${tabs}${list.map(release => `<article class="ssr-panel" id="release-${escapeHtml(encodeURIComponent(release.tag))}"><h2>${escapeHtml(release.name || release.tag)}</h2><p class="ssr-muted"><code>${escapeHtml(release.tag)}</code>${release.prerelease ? ' · Pre-release' : ''}${release.publishedAt ? ` · ${time(release.publishedAt)}` : ''}</p>${release.notes.trim() ? `<div class="ssr-markdown">${markdownToHtml(release.notes, { images: release.images, repository: { handle, name, commitSha: release.targetSha, path: 'RELEASE.md' }, headingOffset: 2 })}</div>` : ''}${release.assets?.length ? `<ul>${release.assets.map(asset => `<li><a href="${escapeHtml(asset.downloadUrl)}" rel="nofollow">${escapeHtml(asset.name)}</a></li>`).join('')}</ul>` : ''}</article>`).join('') || '<p>No releases yet.</p>'}`;
    if (list.length) graph.push({ '@type': 'ItemList', name: `Releases of ${label}`, itemListElement: list.map((release, index) => ({ '@type': 'ListItem', position: index + 1, name: release.name || release.tag, url: `${origin}${publicRepositoryPath(handle, name, 'releases')}#release-${encodeURIComponent(release.tag)}` })) });
  } else if (view === 'issues' && issue) {
    const authorOf = (id: string) => personName(issue.people, id);
    const comments = issue.comments.filter(comment => !comment.hidden).slice(0, SSR_COMMENT_MAX);
    const markdown = (body: string) => markdownToHtml(body, { repository: { handle, name, path: '' }, headingOffset: 2 });
    heading = issue.title;
    title = `${issue.title} · Issue #${issue.number} · ${label}`;
    description = clip(issue.body || `Issue #${issue.number} in ${label}: ${issue.title}`, DESCRIPTION_MAX);
    content = `${repoLine}${tabs}<p class="ssr-muted">Issue #${issue.number} · ${issue.state === 'open' ? 'Open' : 'Closed'} · opened ${time(issue.createdAt)} by ${personLink(authorOf(issue.authorId))} · ${plural(issue.commentCount, 'comment')}${issue.labels.length ? ` · ${issue.labels.map(escapeHtml).join(', ')}` : ''}</p><article class="ssr-panel ssr-markdown">${issue.body.trim() ? markdown(issue.body) : '<p class="ssr-muted">No description provided.</p>'}</article>`
      + `${comments.length ? `<section aria-labelledby="ssr-comments"><h2 id="ssr-comments">Comments</h2>${comments.map(comment => `<article class="ssr-panel" id="comment-${escapeHtml(comment.id)}"><p class="ssr-muted">${personLink(authorOf(comment.authorId))} · ${time(comment.createdAt)}</p><div class="ssr-markdown">${markdown(comment.body)}</div></article>`).join('')}</section>` : ''}`;
    const url = `${origin}${publicRepositoryPath(handle, name, 'issues', String(issue.number))}`;
    graph.push({
      '@type': 'DiscussionForumPosting', '@id': url, url, headline: clip(issue.title, 110), text: clip(issue.body || issue.title, 5000), datePublished: issue.createdAt, dateModified: issue.updatedAt, author: { '@type': 'Person', name: authorOf(issue.authorId).name },
      commentCount: issue.commentCount, isPartOf: { '@id': `${origin}${repoPath}#repository` },
      comment: comments.slice(0, 20).map(comment => ({ '@type': 'Comment', text: clip(comment.body, 2000), datePublished: comment.createdAt, author: { '@type': 'Person', name: authorOf(comment.authorId).name } })),
    });
  } else if (view === 'issues') {
    const list = issues?.status === 200 ? issues.data as IssueList : null;
    heading = 'Issues';
    title = `Issues · ${label}`;
    description = clip(`${list ? `${list.openCount} open and ${list.closedCount} closed issues` : 'Issues'} in ${label}. ${repoDescription}`, DESCRIPTION_MAX);
    content = `${repoLine}${tabs}${list ? `<p class="ssr-muted">${list.openCount} open · ${list.closedCount} closed</p><section class="ssr-panel"><ul class="ssr-list">${list.items.map(item => `<li><a href="${escapeHtml(publicRepositoryPath(handle, name, 'issues', String(item.number)))}">${escapeHtml(item.title)}</a> <span class="ssr-muted">#${item.number} · opened ${time(item.createdAt)} by ${escapeHtml(personName(list.people, item.authorId).name)} · ${plural(item.commentCount, 'comment')}</span></li>`).join('') || '<li>No open issues.</li>'}</ul></section>` : ''}`;
  } else {
    heading = `${VIEW_LABELS[view] ?? 'Repository'}`;
    title = `${heading} · ${label}`;
    content = `${repoLine}${tabs}<p>${escapeHtml(repoDescription)}</p>`;
  }
  graph.push(breadcrumb.data);
  const feeds = repository.feeds ? (['releases', 'commits', 'issues'] as const).map(kind => `<link rel="alternate" type="application/atom+xml" title="${escapeHtml(`${label} ${kind === 'commits' ? 'revisions' : kind}`)}" href="${escapeHtml(repository.feeds![kind].atom)}">`).join('') : '';
  const feedLinks = repository.feeds ? `<p class="ssr-muted">Feeds: <a href="${escapeHtml(repository.feeds.commits.atom)}">revisions</a> · <a href="${escapeHtml(repository.feeds.releases.atom)}">releases</a> · <a href="${escapeHtml(repository.feeds.issues.atom)}">issues</a> · <a href="/explore">Explore more repositories</a></p>` : '';
  const body = frame(`${breadcrumb.html}<h1>${escapeHtml(heading)}</h1>${content}${feedLinks}`);
  return { status: 200, title, description, head: `${feeds}${jsonLd({ '@context': 'https://schema.org', '@graph': graph })}`, body };
}

async function profilePage(handle: string, origin: string, load: PublicLoader): Promise<ServerPage | null> {
  const loaded = await load<PublicProfile>(publicProfileRequests(handle).profile);
  if (loaded.status === 308 && loaded.location) {
    const moved = /^\/api\/public\/profiles\/([^/?]+)/.exec(loaded.location)?.[1];
    return moved ? { status: 308, location: `/${moved}`, head: '', body: '' } : null;
  }
  if (loaded.status === 404) return { status: 404, head: '', body: '' };
  const profile = loaded.data;
  if (loaded.status !== 200 || !profile) return null;
  const name = profile.displayName || profile.handle;
  const path = `/${encodeURIComponent(profile.handle)}`;
  const pinned = profile.pinned.map(item => profile.repositories.find(card => card.name === item)).filter((card): card is PublicRepositoryCard => !!card);
  const readme = profile.readme ? markdownToHtml(profile.readme.content, { images: profile.readme.images, repository: { handle: profile.handle, name: profile.readme.repository, commitSha: profile.readme.commitSha, path: profile.readme.path }, headingOffset: 1 }) : '';
  const website = /^https?:\/\//i.test(profile.website) ? profile.website : '';
  const links = [...new Set([website, ...profile.links.filter(item => /^https?:\/\//i.test(item))].filter(Boolean))];
  const breadcrumb = crumbs(origin, [['Gitflare', '/'], ['Explore', '/explore'], [name, path]]);
  const description = clip(profile.bio || (profile.readme ? markdownSummary(profile.readme.content) : '') || `${plural(profile.repositories.length, 'public repository', 'public repositories')} by @${profile.handle} on Gitflare.`, DESCRIPTION_MAX);
  const main = `${breadcrumb.html}<h1>${escapeHtml(name)}</h1><p class="ssr-muted">@${escapeHtml(profile.handle)}${profile.location ? ` · ${escapeHtml(profile.location)}` : ''}</p>${profile.bio ? `<p>${escapeHtml(profile.bio)}</p>` : ''}`
    + `${links.length ? `<ul>${links.map(item => `<li><a href="${escapeHtml(item)}" rel="nofollow ugc me noopener">${escapeHtml(item.replace(/^https?:\/\//i, ''))}</a></li>`).join('')}</ul>` : ''}`
    + `${readme ? `<section class="ssr-panel" aria-labelledby="ssr-profile-readme"><h2 id="ssr-profile-readme">${escapeHtml(profile.readme!.path)}</h2><article class="ssr-markdown">${readme}</article></section>` : ''}`
    + `${pinned.length ? `<section class="ssr-panel" aria-labelledby="ssr-pinned"><h2 id="ssr-pinned">Pinned</h2>${repositoryCards(pinned, false)}</section>` : ''}`
    + `<section class="ssr-panel" aria-labelledby="ssr-repositories"><h2 id="ssr-repositories">Repositories</h2>${profile.repositories.length ? repositoryCards(profile.repositories, false) : '<p>No public repositories yet.</p>'}</section><p><a href="/explore">Explore more repositories</a></p>`;
  const entity = { '@type': profile.kind === 'user' ? 'Person' : 'Organization', '@id': `${origin}${path}#owner`, name, alternateName: `@${profile.handle}`, url: `${origin}${path}`, ...(profile.bio ? { description: profile.bio } : {}), ...(links.length ? { sameAs: links } : {}) };
  const data = { '@context': 'https://schema.org', '@graph': [{ '@type': 'ProfilePage', url: `${origin}${path}`, mainEntity: entity }, breadcrumb.data] };
  return { status: 200, title: name === profile.handle ? `@${profile.handle}` : `${name} (@${profile.handle})`, description, head: jsonLd(data), body: frame(main) };
}

async function explorePage(search: string, origin: string, load: PublicLoader): Promise<ServerPage | null> {
  const loaded = await load<PublicExplore>(exploreRequest(exploreStateFrom(new URLSearchParams(search))));
  if (loaded.status !== 200 || !loaded.data) return null;
  const items = loaded.data.items;
  const breadcrumb = crumbs(origin, [['Gitflare', '/'], ['Explore', '/explore']]);
  const main = `${breadcrumb.html}<h1>Explore public repositories</h1><p>${plural(loaded.data.total, 'public repository', 'public repositories')} hosted on Gitflare.</p><section class="ssr-panel">${items.length ? repositoryCards(items, true) : '<p>No public repositories yet.</p>'}</section>`;
  const data = { '@context': 'https://schema.org', '@graph': [{ '@type': 'CollectionPage', url: `${origin}/explore`, name: 'Explore public repositories', mainEntity: { '@type': 'ItemList', itemListElement: items.slice(0, SSR_LIST_MAX).map((card, index) => ({ '@type': 'ListItem', position: index + 1, url: `${origin}${publicRepositoryPath(card.handle, card.name)}`, name: `${card.handle}/${card.name}` })) } }, breadcrumb.data] };
  return { status: 200, head: jsonLd(data), body: frame(main) };
}

export async function renderPublicPage(target: ServerTarget, origin: string, load: PublicLoader): Promise<ServerPage | null> {
  if (target.kind === 'repository') return repositoryPage(target, origin, load);
  if (target.kind === 'profile') return profilePage(target.handle, origin, load);
  return explorePage(target.search, origin, load);
}

type Waiter = { waitUntil(promise: Promise<unknown>): void } | undefined;
type Produce = (request: Request, env: AppEnv) => Promise<Response>;

export function serverRenderedTarget(request: Request, env: AppEnv): ServerTarget | null {
  if (request.method !== 'GET' || env.EDITION === 'self-hosted' || env.DEMO_MODE === 'true' || !env.GITFLARE_SECURITY) return null;
  const url = new URL(request.url);
  if (searchRole(env, url.origin) !== 'site' || !publicShellVisit(request, env)) return null;
  return serverTarget(url);
}

export function publicLoader(request: Request, env: AppEnv, ctx: Waiter, produce: Produce): PublicLoader {
  const origin = new URL(request.url).origin;
  const internalEnv = { ...env, PUBLIC_READ_RATE_LIMIT: undefined } as unknown as AppEnv;
  const headers = { 'CF-Connecting-IP': clientIp(request) };
  return async <T>(path: string): Promise<Loaded<T>> => {
    const internal = new Request(new URL(path, origin), { headers, redirect: 'manual' });
    let response: Response;
    try { response = await servePublicCached(internal, internalEnv, ctx, () => produce(internal, internalEnv)); }
    catch (error) { return { status: publicError(error).status, data: null, location: null }; }
    if (response.status !== 200) { await response.body?.cancel(); return { status: response.status, data: null, location: response.headers.get('Location') }; }
    try { return { status: 200, data: await response.json() as T, location: null }; }
    catch { return { status: 502, data: null, location: null }; }
  };
}

export async function serverPage(request: Request, env: AppEnv, ctx: Waiter, target: ServerTarget, produce: Produce): Promise<ServerPage | null> {
  if (await consume(env, 'PUBLIC_READ_RATE_LIMIT', `ip:${clientIp(request)}`)) return null;
  try { return await renderPublicPage(target, new URL(request.url).origin, publicLoader(request, env, ctx, produce)); }
  catch { return null; }
}
