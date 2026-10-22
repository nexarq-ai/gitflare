import { describe, expect, it } from 'vitest';
import { emptySuggestions, paletteKey, PUBLIC_DOCS, resultCountLabel, scoreEntry, searchPalette, staticEntries, workspaceEntries, type PaletteContext, type PaletteEntry } from '../src/ui/command-palette';
import { PUBLIC_DOC_IDS, isKnownAppRoute, isPublicDiscoveryRoute, isPublicDocumentationRoute } from '../src/ui/router';
import type { Workspace } from '../src/shared/types';

const owner: PaletteContext = { edition: 'hosted', permissions: ['read', 'contribute', 'land', 'manage'], role: 'Owner', aiEnabled: true, personalAccount: true, installationAdmin: false, connected: true, demo: false, theme: 'light', workspaces: [{ id: 'w1', name: 'Acme', role: 'Owner' }, { id: 'w2', name: 'Billing', role: 'Viewer' }], currentWorkspaceId: 'w1', canSwitchWorkspace: true };
const viewer: PaletteContext = { ...owner, permissions: ['read'], role: 'Viewer' };

function titles(context: PaletteContext, query: string, section?: string): string[] {
  return searchPalette(staticEntries(context), query).filter(group => !section || group.section === section).flatMap(group => group.entries.map(entry => entry.title));
}

function first(context: PaletteContext, query: string): PaletteEntry | undefined {
  return searchPalette(staticEntries(context), query)[0]?.entries[0];
}

describe('command palette matching', () => {
  it('finds AI clients, the MCP guide and the MCP URL for "MCP"', () => {
    const groups = searchPalette(staticEntries(owner), 'MCP');
    expect(groups.map(group => group.section)).toEqual(['pages', 'actions', 'docs']);
    expect(groups[0]!.entries[0]).toMatchObject({ title: 'AI clients', route: 'account/clients' });
    expect(groups[1]!.entries.map(entry => entry.title)).toContain('Copy MCP server URL');
    expect(groups[2]!.entries[0]).toMatchObject({ title: 'Connect through MCP', route: 'docs/mcp' });
  });

  it('maps synonyms to the right page or action', () => {
    for (const query of ['connector', 'claude', 'ChatGPT', 'token']) expect(first(owner, query)?.route).toBe('account/clients');
    for (const query of ['api key', 'model', 'gateway']) expect(titles(owner, query, 'pages')[0]).toBe('AI models');
    for (const query of ['invite', 'members', 'team']) expect(titles(owner, query, 'pages')[0]).toBe('People');
    expect(titles(owner, 'theme', 'actions')).toEqual(['Switch to dark theme']);
    expect(titles({ ...owner, theme: 'dark' }, 'dark', 'actions')).toEqual(['Switch to light theme']);
    for (const query of ['logout', 'sign out']) expect(titles(owner, query, 'actions')[0]).toBe('Sign out');
  });

  it('finds repository settings only inside a repository', () => {
    expect(titles(owner, 'deploy', 'pages')).not.toContain('Deploys');
    const inside = { ...owner, repository: { id: 'r1', name: 'billing-api' } };
    const deploys = searchPalette(staticEntries(inside), 'deploy')[0]!.entries[0]!;
    expect(deploys).toMatchObject({ title: 'Deploys', route: 'repository/r1/settings/deploys', detail: 'Repository · billing-api' });
    for (const query of ['secrets', 'branch rules', 'previews', 'github mirror', 'community ai', 'checks']) expect(titles(inside, query, 'pages').length).toBeGreaterThan(0);
  });

  it('is case-insensitive, matches word prefixes and needs every word', () => {
    expect(first(owner, 'AUDIT')?.title).toBe('Audit log');
    expect(first(owner, 'not')?.title).toBe('Notifications');
    expect(scoreEntry({ id: 'x', section: 'pages', title: 'Audit log', icon: 'audit' }, 'audit zebra')).toBe(0);
    expect(scoreEntry({ id: 'x', section: 'pages', title: 'Audit log', icon: 'audit' }, 'log')).toBeGreaterThan(0);
  });

  it('only routes to pages the app knows', () => {
    const inside = { ...owner, installationAdmin: true, repository: { id: 'r1', name: 'api' } };
    for (const entry of staticEntries(inside)) if (entry.route) expect(isKnownAppRoute(entry.route) || isPublicDocumentationRoute(entry.route) || isPublicDiscoveryRoute(entry.route), entry.route).toBe(true);
  });

  it('lists exactly the public documentation catalog', () => {
    expect(PUBLIC_DOCS.map(doc => doc.id)).toEqual(PUBLIC_DOC_IDS);
    expect(staticEntries(owner).filter(entry => entry.section === 'docs').map(entry => entry.route)).toEqual(PUBLIC_DOC_IDS.map(id => `docs/${id}`));
  });
});

describe('command palette permissions', () => {
  it('hides actions the role cannot take', () => {
    const actions = (context: PaletteContext) => staticEntries(context).filter(entry => entry.section === 'actions').map(entry => entry.title);
    expect(actions(owner)).toEqual(['New mission', 'New repository', 'Import from GitHub', 'Invite people', 'Switch to dark theme', 'Switch to Billing', 'Copy MCP server URL', 'Sign out']);
    expect(actions(viewer)).toEqual(['Switch to dark theme', 'Switch to Billing', 'Copy MCP server URL', 'Sign out']);
    expect(actions({ ...owner, demo: true })).not.toContain('Invite people');
    expect(actions({ ...owner, connected: false })).not.toContain('Sign out');
    expect(actions({ ...owner, canSwitchWorkspace: false })).not.toContain('Switch to Billing');
  });

  it('hides AI surfaces when AI is off', () => {
    const off = { ...owner, aiEnabled: false };
    expect(titles(off, 'mcp', 'pages')).toEqual([]);
    expect(titles(off, 'model', 'pages')).not.toContain('AI models');
    expect(titles(off, 'new mission', 'actions')).toEqual([]);
    expect(titles(off, 'mcp', 'docs')).toEqual(['Connect through MCP']);
  });

  it('keeps hosted-only and admin-only pages out of other editions and roles', () => {
    const selfHosted = { ...owner, edition: 'self-hosted' as const, repository: { id: 'r1', name: 'api' } };
    const routes = staticEntries(selfHosted).map(entry => entry.route);
    expect(routes).not.toContain('explore');
    expect(routes).not.toContain('import/github');
    expect(routes).not.toContain('repository/r1/settings/community');
    expect(routes).not.toContain('admin');
    expect(staticEntries({ ...owner, installationAdmin: true }).map(entry => entry.route)).toContain('admin');
    expect(staticEntries({ ...owner, personalAccount: false }).map(entry => entry.route)).not.toContain('inbox');
    expect(staticEntries({ ...owner, permissions: ['read', 'contribute'] }).map(entry => entry.route)).not.toContain('import/github');
  });
});

describe('command palette results', () => {
  const workspace = { name: 'Acme', mode: 'connected', integrations: [], repositories: [{ id: 'r1', name: 'billing-api', description: 'Invoices' }], missions: [{ id: 'm1', title: 'Add MCP rate limits', repositoryId: 'r1' }] } as unknown as Workspace;

  it('orders sections and shows only the ones with matches', () => {
    const groups = searchPalette([...staticEntries(owner), ...workspaceEntries(workspace)], 'mcp');
    expect(groups.map(group => group.label)).toEqual(['Pages & settings', 'Actions', 'Proposals', 'Docs']);
    expect(searchPalette(workspaceEntries(workspace), 'billing').map(group => group.section)).toEqual(['repositories', 'proposals']);
  });

  it('shows actions, repositories and proposals before typing', () => {
    expect(searchPalette([...staticEntries(owner), ...workspaceEntries(workspace)], '  ').map(group => group.section)).toEqual(['actions', 'repositories', 'proposals']);
  });

  it('suggests docs and public search when nothing matches', () => {
    expect(searchPalette(staticEntries(owner), 'qwxz')).toEqual([]);
    expect(emptySuggestions('qwxz', owner).map(entry => entry.route)).toEqual(['docs?q=qwxz', 'search?q=qwxz', 'docs']);
    expect(emptySuggestions('qwxz', { edition: 'self-hosted' }).map(entry => entry.route)).toEqual(['docs?q=qwxz', 'docs']);
    expect(resultCountLabel(1)).toBe('1 result');
    expect(resultCountLabel(0)).toBe('0 results');
  });
});

describe('command palette keyboard', () => {
  it('moves through results, wraps and chooses with Enter', () => {
    expect(paletteKey('ArrowDown', 0, 3)).toEqual({ selected: 1 });
    expect(paletteKey('ArrowDown', 2, 3)).toEqual({ selected: 0 });
    expect(paletteKey('ArrowUp', 0, 3)).toEqual({ selected: 2 });
    expect(paletteKey('Home', 2, 3)).toEqual({ selected: 0 });
    expect(paletteKey('End', 0, 3)).toEqual({ selected: 2 });
    expect(paletteKey('Enter', 1, 3)).toEqual({ selected: 1, choose: true });
    expect(paletteKey('a', 1, 3)).toEqual({ selected: 1 });
  });

  it('does nothing without results', () => {
    expect(paletteKey('Enter', 0, 0)).toEqual({ selected: 0 });
    expect(paletteKey('ArrowDown', 0, 0)).toEqual({ selected: 0 });
  });
});
