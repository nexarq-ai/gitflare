import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { NotificationItem } from '../src/shared/notifications';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../src/shared/notifications';
import { accountSection, accountSections } from '../src/ui/account-data';
import { badgeLabel, DEFAULT_INBOX_FILTERS, inboxCommand, inboxQuery, moveSelection, notificationLine, notificationsQuery, openTarget, selectionAfterRemoval, setReasonMode, threadFromSearch, threadRoute, withinAge } from '../src/ui/inbox-data';
import { isKnownAppRoute, keepsRouteAcrossWorkspaces } from '../src/ui/router';
import { chordMatcher } from '../src/ui/workspace-chord';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const key = (value: string, extra: Partial<KeyboardEvent> = {}, target: unknown = null) => ({ key: value, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: target as EventTarget | null, ...extra });
const element = (matches: string[]) => ({ isContentEditable: false, closest: (selector: string) => matches.some(match => selector.includes(match)) ? {} : null });

describe('inbox routes', () => {
  it('knows the inbox and the notification settings page', () => {
    expect(isKnownAppRoute('inbox')).toBe(true);
    expect(isKnownAppRoute('account/notifications')).toBe(true);
    expect(isKnownAppRoute('inbox/x')).toBe(false);
    expect(keepsRouteAcrossWorkspaces('inbox')).toBe(true);
    expect(accountSection('account/notifications')).toBe('notifications');
    expect(accountSections.map(section => section.id)).toContain('notifications');
  });

  it('opens the inbox on g then i and keeps g then w for workspaces', () => {
    let now = 0;
    const inbox = chordMatcher(() => now, 'i');
    const workspaces = chordMatcher(() => now);
    inbox(key('g')); workspaces(key('g'));
    now = 300;
    expect(inbox(key('i'))).toBe(true);
    expect(workspaces(key('i'))).toBe(false);
    inbox(key('g')); workspaces(key('g'));
    expect(inbox(key('w'))).toBe(false);
    expect(workspaces(key('w'))).toBe(true);
    inbox(key('g')); expect(inbox(key('i', {}, element(['textarea'])))).toBe(false);
    inbox(key('g')); now = 5000; expect(inbox(key('i'))).toBe(false);
  });

  it('reads deep links and falls back to the thread address', () => {
    expect(threadFromSearch('?thread=proposal%3Arepo%3Am1')).toBe('proposal:repo:m1');
    expect(threadFromSearch('?other=1')).toBeNull();
    expect(threadRoute('proposal:repo-1:m-1')).toBe('mission/m-1/discussion');
    expect(threadRoute('issue:repo-1:12')).toBe('repository/repo-1/issues/12');
    expect(threadRoute('issue:repo-1:abc')).toBeNull();
    expect(threadRoute('deployment:repo-1:d1')).toBeNull();
    expect(threadRoute('proposal:../x:m1')).toBeNull();
  });

  it('switches workspace only for workspace pages in another workspace', () => {
    const item = (route: string, workspaceId: string) => ({ route, subject: { workspaceId } as NotificationItem['subject'] });
    expect(openTarget(item('mission/m1/discussion', 'w2'), 'w1')).toEqual({ switchTo: 'w2', route: 'mission/m1/discussion' });
    expect(openTarget(item('mission/m1/discussion', 'w1'), 'w1')).toEqual({ switchTo: null, route: 'mission/m1/discussion' });
    expect(openTarget(item('acme/widgets/issues/3', 'w2'), 'w1')).toEqual({ switchTo: null, route: 'acme/widgets/issues/3' });
  });
});

describe('inbox keyboard', () => {
  it('maps keys to commands outside text fields and dialogs', () => {
    expect(inboxCommand(key('j'))).toBe('next');
    expect(inboxCommand(key('k'))).toBe('previous');
    expect(inboxCommand(key('o'))).toBe('open');
    expect(inboxCommand(key('Enter'))).toBe('open');
    expect(inboxCommand(key('e'))).toBe('archive');
    expect(inboxCommand(key('u'))).toBe('toggle-read');
    expect(inboxCommand(key('I', { shiftKey: true }))).toBe('read-all');
    expect(inboxCommand(key('J', { shiftKey: true }))).toBeNull();
    expect(inboxCommand(key('j', { metaKey: true }))).toBeNull();
    expect(inboxCommand(key('j', {}, element(['input'])))).toBeNull();
    expect(inboxCommand(key('e', {}, element(['dialog'])))).toBeNull();
    expect(inboxCommand(key('Enter', {}, element(['button'])))).toBeNull();
    expect(inboxCommand(key('x'))).toBeNull();
  });

  it('moves and keeps the selection in range', () => {
    expect(moveSelection(-1, 3, 1)).toBe(0);
    expect(moveSelection(0, 3, 1)).toBe(1);
    expect(moveSelection(2, 3, 1)).toBe(2);
    expect(moveSelection(0, 3, -1)).toBe(0);
    expect(moveSelection(0, 0, 1)).toBe(-1);
    expect(selectionAfterRemoval(2, 2)).toBe(1);
    expect(selectionAfterRemoval(0, 0)).toBe(-1);
    expect(selectionAfterRemoval(-1, 4)).toBe(0);
  });
});

describe('inbox presentation', () => {
  it('builds queries from filters', () => {
    expect(inboxQuery({ ...DEFAULT_INBOX_FILTERS, kind: 'awaiting_checks', repository: 'r1', age: '7', archived: true }, 30)).toBe('kind=awaiting_checks&repository=r1&age=7&archived=true&offset=30&limit=30');
    expect(inboxQuery(DEFAULT_INBOX_FILTERS)).toBe('limit=30');
    expect(notificationsQuery({ ...DEFAULT_INBOX_FILTERS, filter: 'all', reason: 'mention' })).toBe('filter=all&reason=mention&limit=30');
  });

  it('filters by age and caps the badge', () => {
    const now = Date.parse('2026-10-20T00:00:00Z');
    expect(withinAge('2026-10-19T12:00:00Z', '1', now)).toBe(true);
    expect(withinAge('2026-10-10T00:00:00Z', '7', now)).toBe(false);
    expect(withinAge('2020-01-01T00:00:00Z', '', now)).toBe(true);
    expect(badgeLabel(0)).toBe('');
    expect(badgeLabel(7)).toBe('7');
    expect(badgeLabel(140)).toBe('99+');
  });

  it('describes a notification by actor, event and count', () => {
    expect(notificationLine({ actor: { name: 'Asha Rao', handle: 'asha' }, event: 'commented', count: 3 })).toBe('@asha commented · 3 updates');
    expect(notificationLine({ actor: { name: 'Asha Rao', handle: null }, event: 'approved', count: 1 })).toBe('Asha Rao approved');
    expect(notificationLine({ actor: null, event: 'checks_failed', count: 1 })).toBe('checks failed');
  });

  it('changes one reason without touching the rest', () => {
    const next = setReasonMode(DEFAULT_NOTIFICATION_PREFERENCES, 'participating', 'digest');
    expect(next.reasons.participating).toBe('digest');
    expect(next.reasons.mention).toBe('instant');
    expect(DEFAULT_NOTIFICATION_PREFERENCES.reasons.participating).toBe('off');
    expect(next.email).toBe(false);
  });

  it('wires the page, nav badge and chord into the app', () => {
    const app = read('src/ui/App.tsx');
    expect(app).toContain('const Inbox = lazy(() => import("./Inbox"));');
    expect(app).toContain('workspaceChord(() => { if (!modal && !quickSearchOpen) navigate("inbox"); }, "i")');
    expect(app).toContain('inbox: "Inbox"');
    const inbox = read('src/ui/Inbox.tsx');
    expect(inbox).toContain('/run-checks');
    expect(inbox).toContain('confirmLabel: "Run checks"');
    expect(inbox).toContain('onSwitchWorkspace(target.switchTo)');
  });
});
