export const HANDLE_MAX = 39;
export const HANDLE_REDIRECT_DAYS = 90;
export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;

export const PROFILE_LIMITS = { displayName: 80, bio: 300, links: 4, linkLength: 200, pinned: 6 } as const;

export const OPERATOR_HANDLES = ['gitflare', 'nexarq'] as const;

export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'about', 'access', 'account', 'accounts', 'activity', 'admin', 'administrator', 'agent', 'agents', 'ai', 'ai-clients', 'anonymous', 'api', 'app', 'apps', 'assets',
  'auth', 'billing', 'blog', 'boot-loader', 'changelog', 'cloudflare', 'connect', 'connectors', 'contact', 'cookies', 'dashboard', 'demo', 'deploy', 'developer', 'developers',
  'docs', 'download', 'downloads', 'edit', 'enterprise', 'explore', 'favicon', 'features', 'fonts', 'forgot-password', 'git', 'github', 'gitlab', 'gitflare', 'help', 'home',
  'inbox', 'install', 'invite', 'invitations', 'issues', 'join', 'legal', 'llms', 'login', 'logout', 'logo', 'marketplace', 'mcp', 'me', 'mission', 'missions', 'new',
  'nexarq', 'notifications', 'oauth', 'open-source', 'org', 'organization', 'organizations', 'orgs', 'overview', 'pricing', 'privacy', 'product', 'profile', 'proposal',
  'proposals', 'public', 'pulls', 'repositories', 'repository', 'repos', 'reset-password', 'robots', 'root', 'search', 'security', 'settings', 'signin', 'signout',
  'signup', 'site', 'sitemap', 'social', 'source', 'sponsors', 'staff', 'stars', 'status', 'support', 'system', 'team', 'teams', 'terms', 'topics', 'trending',
  'use-cases', 'user', 'users', 'verify-email', 'well-known', 'workspace', 'workspaces', 'www', 'acceptable-use',
]);

export type HandleProblem = { code: 'INVALID_HANDLE' | 'HANDLE_RESERVED'; message: string };

export function normalizeHandle(value: string): string { return value.trim().toLowerCase(); }

export function handleProblem(value: string, options: { operator?: boolean } = {}): HandleProblem | null {
  if (!HANDLE_PATTERN.test(value)) return { code: 'INVALID_HANDLE', message: `Use 1–${HANDLE_MAX} lowercase letters, numbers or single hyphens, starting and ending with a letter or number.` };
  if (options.operator && (OPERATOR_HANDLES as readonly string[]).includes(value)) return null;
  if (RESERVED_HANDLES.has(value)) return { code: 'HANDLE_RESERVED', message: `${value} is reserved. Choose another handle.` };
  return null;
}

export function suggestedHandle(name: string): string {
  const slug = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, HANDLE_MAX).replace(/-+$/g, '');
  return slug && !RESERVED_HANDLES.has(slug) ? slug : '';
}

export const PUBLIC_REPOSITORY_VIEWS = ['tree', 'blob', 'issues', 'commits', 'branches', 'releases', 'agents'] as const;
export const PUBLIC_ISSUE_PATH = /^(?:new|[1-9]\d{0,5})$/;
export type PublicRepositoryView = 'code' | typeof PUBLIC_REPOSITORY_VIEWS[number];

export function publicRepositoryPath(handle: string, repository: string, view: PublicRepositoryView = 'code', path = ''): string {
  const base = `/${encodeURIComponent(handle)}/${encodeURIComponent(repository)}`;
  if (view === 'code') return base;
  if ((view === 'tree' || view === 'blob') && path) return `${base}/${view}/${path.split('/').map(encodeURIComponent).join('/')}`;
  if (view === 'issues' && PUBLIC_ISSUE_PATH.test(path)) return `${base}/issues/${path}`;
  return view === 'tree' ? base : `${base}/${view}`;
}
