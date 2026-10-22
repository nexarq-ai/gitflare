import { afterEach, describe, expect, it, vi } from 'vitest';
import { isKnownAppRoute, keepsRouteAcrossWorkspaces, routeFromLocation } from '../src/ui/router';
import { chordMatcher } from '../src/ui/workspace-chord';
import { rememberedWorkspace, rememberWorkspace } from '../src/ui/api';
import { workspaceSwitchEntries } from '../src/ui/QuickSearch';
import { invitationCode, joinErrorMessage } from '../src/ui/WorkspaceSwitcher';
import { RequestError } from '../src/ui/api';

afterEach(() => vi.unstubAllGlobals());

const key = (value: string, target: unknown = null, extra: Partial<KeyboardEvent> = {}) => ({ key: value, metaKey: false, ctrlKey: false, altKey: false, target: target as EventTarget | null, ...extra });

describe('workspace routes', () => {
  it('redirects old addresses into the settings tree', () => {
    expect(routeFromLocation('/access', '')).toBe('settings/people');
    expect(routeFromLocation('/repository/r1/cloudflare', '')).toBe('repository/r1/settings/cloudflare');
    expect(routeFromLocation('/repository/r1/streams', '')).toBe('repository/r1/settings/branches');
  });

  it('knows every settings page and nothing else', () => {
    for (const route of ['settings', 'settings/people', 'settings/cloudflare', 'settings/models', 'settings/audit', 'admin', 'account/clients', 'repository/r1/settings', 'repository/r1/settings/deploys', 'repository/r1/settings/previews', 'repository/r1/settings/secrets', 'repository/r1/settings/cloudflare', 'repository/r1/settings/access']) expect(isKnownAppRoute(route)).toBe(true);
    for (const route of ['settings/teams', 'repository/r1/cloudflare', 'repository/r1/settings/unknown', 'admin/x', 'account/tokens']) expect(isKnownAppRoute(route)).toBe(false);
  });

  it('keeps workspace-independent pages after a switch and leaves repository pages', () => {
    for (const route of ['settings', 'settings/people', 'account/profile', 'account/clients', 'overview', 'docs/mcp', 'admin']) expect(keepsRouteAcrossWorkspaces(route)).toBe(true);
    for (const route of ['repository/r1/code', 'mission/m1', 'proposals/new', 'repository/r1/settings']) expect(keepsRouteAcrossWorkspaces(route)).toBe(false);
  });
});

describe('workspace switcher', () => {
  it('opens on g then w, outside text fields only, within the chord window', () => {
    let now = 0;
    const matches = chordMatcher(() => now);
    expect(matches(key('g'))).toBe(false);
    now = 500; expect(matches(key('w'))).toBe(true);
    expect(matches(key('w'))).toBe(false);
    now = 1000; matches(key('g')); now = 3000; expect(matches(key('w'))).toBe(false);
    matches(key('g')); expect(matches(key('w', null, { metaKey: true }))).toBe(false);
    const input = { closest: (selector: string) => selector.includes('input') ? {} : null, isContentEditable: false };
    matches(key('g', input)); expect(matches(key('w', input))).toBe(false);
  });

  it('remembers the chosen workspace per user and survives blocked storage', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    rememberWorkspace('user-1', 'w-2');
    expect(rememberedWorkspace('user-1')).toBe('w-2');
    expect(rememberedWorkspace('user-2')).toBeNull();
    expect([...store.keys()]).toEqual(['gitflare:workspace:user-1']);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(() => rememberWorkspace('user-1', 'w-3')).not.toThrow();
    expect(rememberedWorkspace('user-1')).toBeNull();
  });

  it('offers quick-search entries for every other workspace', () => {
    const entries = workspaceSwitchEntries([{ id: 'a', name: 'Acme Platform', role: 'Owner' }, { id: 'b', name: 'Billing', role: 'Viewer' }], 'a');
    expect(entries).toEqual([{ id: 'workspace:b', workspaceId: 'b', title: 'Switch to Billing', detail: 'Viewer', category: 'Workspace' }]);
  });

  it('accepts a pasted invitation link or bare code and explains a different email', () => {
    const token = 'ab'.repeat(32);
    expect(invitationCode(token)).toBe(token);
    expect(invitationCode(`https://gitflare.io/invite#token=${token.toUpperCase()}&mode=signin`)).toBe(token);
    expect(invitationCode('not a code')).toBeNull();
    expect(joinErrorMessage(new RequestError('x', 403, 'INVITATION_IDENTITY'))).toBe('This invitation is for a different email address.');
    expect(joinErrorMessage(new RequestError('Expired.', 410, 'INVITATION_EXPIRED'))).toBe('Expired.');
  });
});
