import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { followsSavedTheme, publicSearchRoute, isAppPath, isKnownAppRoute, isPublicDiscoveryRoute, isSiteRoute, POLICY_ROUTES, PUBLIC_DOC_IDS, PUBLIC_PRODUCT_ROUTES, publicProfileLocation, publicRepositoryLocation, routeFromLocation } from '../src/ui/router';
import { RESERVED_HANDLES } from '../src/shared/handles';
import { appLinks } from './app-links';
import { exploreParams, exploreStateFrom } from '../src/shared/explore';

const KNOWN_ROUTES = ['home', 'signin', 'signup', 'source/gitflare', 'deploy', 'overview', 'missions', 'activity', 'admin', 'account/profile', 'account/security', 'account/sessions', 'account/clients', 'proposals/new', 'settings', 'settings/people', 'docs', 'docs/overview', 'mission/x', 'repository/x', 'repository/x/code', 'forgot-password', 'reset-password', 'verify-email', 'invite', 'use-cases', 'use-cases/x', 'login', 'access', 'connect', 'repositories', ...PUBLIC_PRODUCT_ROUTES, ...POLICY_ROUTES, ...PUBLIC_DOC_IDS.map(id => `docs/${id}`)];

describe('public discovery routes', () => {
  it('parses explore, search and profiles', () => {
    expect(routeFromLocation('/explore', '')).toBe('explore');
    expect(routeFromLocation('/search', '')).toBe('search');
    expect(isPublicDiscoveryRoute('explore')).toBe(true);
    expect(isPublicDiscoveryRoute('search')).toBe(true);
    expect(publicSearchRoute('a b&c')).toBe('search?q=a+b%26c');
    expect(publicProfileLocation('acme')).toEqual({ handle: 'acme' });
    expect(publicProfileLocation('a-b-1')).toEqual({ handle: 'a-b-1' });
    expect(publicProfileLocation('gitflare')).toEqual({ handle: 'gitflare' });
    expect(publicProfileLocation('nexarq')).toEqual({ handle: 'nexarq' });
  });

  it('rejects malformed or multi-segment profile addresses', () => {
    for (const route of ['', 'Acme', '-acme', 'acme-', 'ac--me', 'acme/widgets', 'acme/', 'a.b', 'a_b', 'a'.repeat(40), 'explore', 'search', 'api', 'stars']) expect(publicProfileLocation(route), route).toBe(null);
  });

  it('never claims existing product routes or app links', () => {
    for (const route of KNOWN_ROUTES) {
      expect(publicProfileLocation(route), route).toBe(null);
      expect(isPublicDiscoveryRoute(route), route).toBe(false);
    }
    for (const path of appLinks()) {
      const route = routeFromLocation(path, '');
      if (route === 'explore' || route === 'search') continue;
      expect(publicProfileLocation(route), path).toBe(null);
    }
  });

  it('reserves explore and search as handles', () => {
    expect(RESERVED_HANDLES.has('explore')).toBe(true);
    expect(RESERVED_HANDLES.has('search')).toBe(true);
  });

  it('stays on the site host and is handled as client navigation', () => {
    for (const path of ['/explore', '/search', '/acme', '/gitflare']) {
      const route = routeFromLocation(path, '');
      expect(isPublicDiscoveryRoute(route), path).toBe(true);
      expect(isKnownAppRoute(route), path).toBe(false);
      expect(isSiteRoute(route), path).toBe(true);
      expect(isAppPath(path), path).toBe(true);
    }
  });

  it('follows the saved theme only on repository and discovery pages', () => {
    for (const route of ['explore', 'search', 'acme', 'acme/widgets', 'acme/widgets/blob/README.md']) {
      expect(followsSavedTheme(route), route).toBe(true);
    }
    for (const route of ['home', 'product', 'docs', 'docs/overview', 'terms', 'privacy', 'use-cases', 'deploy', 'source/gitflare', 'signin', 'overview']) expect(followsSavedTheme(route), route).toBe(false);
    expect(publicRepositoryLocation('acme')).toBe(null);
  });
});

describe('boot loader theme', () => {
  const source = readFileSync(new URL('../public/boot-loader.js', import.meta.url), 'utf8');

  function boot({ origin, pathname, stored, systemDark = false, follow = false }: { origin: string; pathname: string; stored: string | null; systemDark?: boolean; follow?: boolean }) {
    const metas: Record<string, string> = { 'gitflare-site-origin': 'https://gitflare.io', 'gitflare-app-origin': 'https://app.gitflare.io', ...(follow ? { 'gitflare-theme': 'system' } : {}) };
    const dataset: Record<string, string> = {};
    const classes = new Set<string>();
    const document = {
      documentElement: { dataset, style: {} as Record<string, string>, classList: { toggle: (name: string, on: boolean) => on ? classes.add(name) : classes.delete(name) } },
      querySelector: (selector: string) => {
        const name = /meta\[name="([^"]+)"\]/.exec(selector)?.[1];
        return name && metas[name] ? { content: metas[name], setAttribute: () => {} } : null;
      },
      getElementById: () => null,
    };
    runInNewContext(source, {
      HTMLElement: class {}, customElements: { get: () => true },
      localStorage: { getItem: () => stored }, matchMedia: () => ({ matches: systemDark }),
      location: { origin, pathname }, document, window: {}, setTimeout, clearTimeout,
    });
    return { theme: dataset.gfTheme, dark: classes.has('dark') };
  }

  it('keeps the marketing site dark on the site host', () => {
    expect(boot({ origin: 'https://gitflare.io', pathname: '/product', stored: 'light' })).toEqual({ theme: 'dark', dark: true });
  });

  it('follows the saved or system theme when the page asks for it', () => {
    expect(boot({ origin: 'https://gitflare.io', pathname: '/acme/widgets', stored: 'light', follow: true })).toEqual({ theme: 'light', dark: false });
    expect(boot({ origin: 'https://gitflare.io', pathname: '/explore', stored: null, systemDark: false, follow: true })).toEqual({ theme: 'light', dark: false });
    expect(boot({ origin: 'https://gitflare.io', pathname: '/explore', stored: null, systemDark: true, follow: true })).toEqual({ theme: 'dark', dark: true });
  });

  it('uses the saved theme on the app host', () => {
    expect(boot({ origin: 'https://app.gitflare.io', pathname: '/acme', stored: 'light' })).toEqual({ theme: 'light', dark: false });
  });
});

describe('explore listing address', () => {
  it('reads and writes every filter as shareable query parameters', () => {
    const state = exploreStateFrom(new URLSearchParams('q=widgets&sort=landed&language=TypeScript&license=MIT&topic=cli&releases=1&agent=ready'));
    expect(state).toEqual({ sort: 'landed', query: 'widgets', language: 'TypeScript', license: 'MIT', topic: 'cli', releases: true, agentReady: true });
    expect(exploreParams(state, { omitDefaultSort: true }).toString()).toBe('q=widgets&sort=landed&language=TypeScript&license=MIT&topic=cli&releases=1&agent=ready');
    expect(exploreParams(exploreStateFrom(new URLSearchParams('sort=random&releases=yes')), { omitDefaultSort: true }).toString()).toBe('');
    expect(exploreParams(exploreStateFrom(new URLSearchParams('')), { cursor: 20 }).toString()).toBe('sort=stars&cursor=20');
  });

  it('offers one public listing in the site navigation', () => {
    const shell = readFileSync(new URL('../src/ui/PublicShell.tsx', import.meta.url), 'utf8');
    expect(shell).toContain('["/explore", "Explore"]');
    expect(shell).not.toContain('"/repositories"');
    expect(PUBLIC_PRODUCT_ROUTES).toContain('repositories');
  });
});
