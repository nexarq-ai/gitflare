import { describe, expect, it } from 'vitest';
import type { AccessSnapshot, Repository } from '../src/shared/types';
import { auditSentence, expiresIn, invitationAccess, memberAccess, parseEmails, pendingInvitations, personName, rolesFor, visibleAudit } from '../src/ui/people-data';
import { repositoryMembers } from '../src/ui/RepositoryAccess';
import { invitationFailure } from '../src/ui/InvitationScreen';
import { RequestError } from '../src/ui/api';

const repositories = [{ id: 'r1', name: 'billing-api' }, { id: 'r2', name: 'docs-site' }] as Repository[];
const now = Date.parse('2026-10-18T10:00:00Z');
const snapshot = {
  user: { id: 'u1', name: 'Asha Rao', email: 'asha@example.test' },
  role: 'Owner',
  members: [
    { userId: 'u1', workspaceId: 'w', role: 'Owner', user: { id: 'u1', name: 'Asha Rao', email: 'asha@example.test' } },
    { userId: 'u2', workspaceId: 'w', role: 'Contributor', user: { id: 'u2', name: 'Ben', email: 'ben@example.test' } },
    { userId: 'u3', workspaceId: 'w', role: 'Reviewer', repositoryIds: ['r1'], user: { id: 'u3', name: 'Carol', email: 'carol@example.test' } },
  ],
  invitations: [
    { id: 'i1', email: 'a@x.test', role: 'Viewer', expiresAt: now + 3_600_000, scope: { kind: 'repository', repositoryId: 'r2', repositoryName: 'docs-site' } },
    { id: 'i2', email: 'b@x.test', role: 'Viewer', expiresAt: now - 1, },
    { id: 'i3', email: 'c@x.test', role: 'Viewer', expiresAt: now + 60_000, accepted: true },
    { id: 'i4', email: 'd@x.test', role: 'Viewer', expiresAt: now + 120_000, scope: { kind: 'organization', ownerId: 'u1' } },
  ],
  organization: { members: [] },
} as unknown as AccessSnapshot;

describe('people settings data', () => {
  it('never offers Owner by invitation and no Deployer for one repository', () => {
    expect(rolesFor('workspace')).toEqual(['Viewer', 'Triager', 'Contributor', 'Reviewer', 'Maintainer', 'Deployer']);
    expect(rolesFor('organization')).not.toContain('Owner');
    expect(rolesFor('repository')).not.toContain('Deployer');
  });

  it('splits pasted addresses on commas, spaces and new lines without duplicates', () => {
    expect(parseEmails(' A@x.test, b@x.test\nb@x.test;c@x.test ')).toEqual(['a@x.test', 'b@x.test', 'c@x.test']);
    expect(parseEmails(' , ')).toEqual([]);
  });

  it('lists only open invitations, soonest expiry first, with their access in words', () => {
    const open = pendingInvitations(snapshot, now);
    expect(open.map(item => item.id)).toEqual(['i4', 'i1']);
    expect(invitationAccess(open[0], repositories)).toBe('All your workspaces');
    expect(invitationAccess(open[1], repositories)).toBe('docs-site');
    expect(expiresIn(now + 3_600_000, now)).toBe('in 1 h');
    expect(expiresIn(now + 120_000, now)).toBe('in 2 min');
  });

  it('describes member access and who can see a repository', () => {
    expect(snapshot.members.map(member => memberAccess(member, repositories))).toEqual(['All repositories', 'All repositories', 'billing-api']);
    expect(repositoryMembers(snapshot, 'r1').map(member => member.userId)).toEqual(['u1', 'u2', 'u3']);
    expect(repositoryMembers(snapshot, 'r2').map(member => member.userId)).toEqual(['u1', 'u2']);
  });

  it('writes audit entries as sentences and hides request records unless asked', () => {
    const names = (id: string) => personName(snapshot, id);
    expect(auditSentence({ action: 'access:invite:repository', actorId: 'u1', resourceId: 'r1' }, names, repositories)).toBe('You invited someone to billing-api.');
    expect(auditSentence({ action: 'access:repository-member', actorId: 'u3', resourceId: 'r1' }, names, repositories)).toBe('Carol joined billing-api.');
    expect(auditSentence({ action: 'read', actorId: 'u2', resourceId: 'r2' }, names, repositories)).toBe('Ben read docs-site.');
    const entries = [
      { action: 'access:invite', actorId: 'u1', timestamp: '2026-10-18T10:00:00.000Z' },
      { action: 'access:invite:workspace', actorId: 'u1', timestamp: '2026-10-18T10:00:00.400Z' },
      { action: 'read', actorId: 'u1', timestamp: '2026-10-18T10:00:01Z' },
      { action: 'access:invite', actorId: 'u1', timestamp: '2026-09-01T10:00:00Z' },
    ];
    expect(visibleAudit(entries, false).map(entry => entry.action)).toEqual(['access:invite:workspace', 'access:invite']);
    expect(visibleAudit(entries, true)).toHaveLength(3);
  });

  it('explains invitation failures in the words of the copy sheet', () => {
    expect(invitationFailure(new RequestError('x', 403, 'INVITATION_IDENTITY'))).toContain('different email address');
    expect(invitationFailure(new RequestError('x', 410, 'INVITATION_EXPIRED'))).toContain('expired');
  });
});
