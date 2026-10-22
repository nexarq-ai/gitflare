import { describe, expect, it } from 'vitest';
import { isAppPath, isKnownAppRoute, isSiteRoute, POLICY_ROUTES, PUBLIC_PRODUCT_ROUTES, publicRepositoryLocation, routeFromLocation } from '../src/ui/router';
import { publicRepositoryPath, RESERVED_HANDLES } from '../src/shared/handles';
import { appLinks } from './app-links';

describe('public repository routes', () => {
  it('parses every repository view', () => {
    expect(publicRepositoryLocation('acme/widgets')).toEqual({ handle: 'acme', repository: 'widgets', view: 'code', path: '' });
    expect(publicRepositoryLocation('acme/widgets/tree')).toEqual({ handle: 'acme', repository: 'widgets', view: 'code', path: '' });
    expect(publicRepositoryLocation('acme/widgets/tree/src/ui')).toEqual({ handle: 'acme', repository: 'widgets', view: 'tree', path: 'src/ui' });
    expect(publicRepositoryLocation('acme/Widgets.js/blob/docs/A guide.md')).toEqual({ handle: 'acme', repository: 'Widgets.js', view: 'blob', path: 'docs/A guide.md' });
    for (const view of ['issues', 'commits', 'branches', 'releases'] as const) expect(publicRepositoryLocation(`acme/widgets/${view}`)).toEqual({ handle: 'acme', repository: 'widgets', view, path: '' });
    expect(publicRepositoryLocation('acme/widgets/issues/new')).toEqual({ handle: 'acme', repository: 'widgets', view: 'issues', path: 'new' });
    expect(publicRepositoryLocation('acme/widgets/issues/42')).toEqual({ handle: 'acme', repository: 'widgets', view: 'issues', path: '42' });
    expect(publicRepositoryLocation('gitflare/gitflare')?.handle).toBe('gitflare');
    expect(publicRepositoryLocation('nexarq/site')?.handle).toBe('nexarq');
  });

  it('rejects unsafe or malformed addresses', () => {
    for (const route of ['acme', 'Acme/widgets', '-acme/widgets', 'ac--me/widgets', 'acme/.widgets', 'acme/widgets.git', 'acme/widgets.GIT', 'acme/wid gets', 'acme/widgets/blob', 'acme/widgets/blob/../secret', 'acme/widgets/tree/a//b', 'acme/widgets/blob/a/./b', 'acme/widgets/blob/a\\b', 'acme/widgets/blob/a\u0001b', 'acme/widgets/commits/x', 'acme/widgets/raw/a.ts', 'acme/widgets/issues/x', 'acme/widgets/issues/0', 'acme/widgets/issues/01', 'acme/widgets/issues/1/2', 'acme/widgets/issues/new/x', 'acme/widgets/issues/1234567', `acme/${'a'.repeat(101)}`]) expect(publicRepositoryLocation(route), route).toBe(null);
  });

  it('never claims existing product routes', () => {
    for (const route of ['account/profile', 'account/security', 'settings/people', 'docs/overview', 'mission/x', 'mission/x/agents/run', 'repository/x', 'repository/x/code', 'use-cases/x', 'source/gitflare', 'source/gitflare/blob/README.md', 'proposals/new', 'reset-password/x', 'verify-email/x', 'invite', 'api/workspace', 'assets/x', 'social/x', 'oauth/authorize']) expect(publicRepositoryLocation(route), route).toBe(null);
    for (const path of appLinks()) expect(publicRepositoryLocation(routeFromLocation(path, '')), path).toBe(null);
  });

  it('reserves every first segment the product uses', () => {
    const knownRoutes = ['home', 'signin', 'signup', 'source/gitflare', 'deploy', 'overview', 'missions', 'activity', 'admin', 'account/profile', 'proposals/new', 'settings', 'docs', 'mission/x', 'repository/x', 'forgot-password', 'reset-password', 'verify-email', 'invite', 'use-cases', 'login', 'access'];
    const segments = new Set([...knownRoutes, ...appLinks().map(path => routeFromLocation(path, '')), ...PUBLIC_PRODUCT_ROUTES, ...POLICY_ROUTES].map(route => route.split(/[/?]/)[0]!));
    for (const segment of segments) expect(RESERVED_HANDLES.has(segment), segment).toBe(true);
    for (const segment of ['api', 'mcp', 'oauth', 'well-known', 'llms', 'assets', 'social', 'git', 'favicon', 'robots']) expect(RESERVED_HANDLES.has(segment), segment).toBe(true);
  });

  it('stays a site route that the app treats as client navigation', () => {
    for (const view of ['code', 'tree', 'blob', 'issues', 'commits', 'branches', 'releases'] as const) {
      const url = publicRepositoryPath('acme', 'widgets', view, view === 'tree' || view === 'blob' ? 'src/main.ts' : '');
      const route = routeFromLocation(url, '');
      expect(publicRepositoryLocation(route)?.view, url).toBe(view);
      expect(isKnownAppRoute(route), url).toBe(false);
      expect(isSiteRoute(route), url).toBe(true);
      expect(isAppPath(url), url).toBe(true);
    }
    for (const path of ['new', '7']) {
      const url = publicRepositoryPath('acme', 'widgets', 'issues', path);
      expect(url).toBe(`/acme/widgets/issues/${path}`);
      expect(publicRepositoryLocation(routeFromLocation(url, ''))).toEqual({ handle: 'acme', repository: 'widgets', view: 'issues', path });
      expect(isSiteRoute(routeFromLocation(url, '')), url).toBe(true);
      expect(isAppPath(url), url).toBe(true);
    }
    expect(publicRepositoryPath('acme', 'widgets', 'issues', '../x')).toBe('/acme/widgets/issues');
    for (const path of ['/acme/widgets.git', '/favicon.svg', '/assets/index.js']) expect(isAppPath(path), path).toBe(false);
  });
});
