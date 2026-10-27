import { describe, expect, it } from 'vitest';
import type { AccessSnapshot } from '../src/shared/types';
import { approvalWarning, eligibleApprovers, offeredChecks, selfApprovalNote } from '../src/ui/approvals';

const members = [
  { userId: 'o', role: 'Owner' },
  { userId: 'r', role: 'Reviewer', repositoryIds: ['r1'] },
  { userId: 'c', role: 'Contributor' },
  { userId: 'm', role: 'Maintainer' },
] as unknown as AccessSnapshot['members'];

describe('approval guard', () => {
  it('counts who can approve, in the workspace and in one repository', () => {
    expect(eligibleApprovers(members)).toBe(3);
    expect(eligibleApprovers(members, 'r1')).toBe(3);
    expect(eligibleApprovers(members, 'r2')).toBe(2);
  });

  it('blocks a requirement nobody could meet and warns when authors cannot approve themselves', () => {
    expect(approvalWarning(3, 2, false)).toEqual({ blocking: true, text: 'Only 2 people can approve here, so nothing could land. Lower this or invite reviewers.' });
    expect(approvalWarning(1, 0, false)?.text).toBe('Nobody here can approve yet, so nothing could land. Lower this or invite reviewers.');
    expect(approvalWarning(2, 2, true)).toEqual({ blocking: false, text: 'When one of the 2 approvers writes a change, only 1 other person can approve it.' });
    expect(approvalWarning(1, 1, true)?.text).toContain('your own changes could never land');
    expect(approvalWarning(1, 3, true)).toBeNull();
    expect(approvalWarning(0, 0, true)).toBeNull();
    expect(selfApprovalNote(1)).toContain('only person who can approve');
  });

  it('offers only checks that run on every landing revision, with visual checks once seen', () => {
    const missions = [
      { repositoryId: 'r1', checks: [{ name: 'bot: repository tests (exit code only) (tests added by the agent; the repository had none)' }, { name: 'Combined candidate tests (single agent: reused the exact verified candidate checks)' }, { name: 'licence: repository tests' }] },
      { repositoryId: 'r2', checks: [{ name: 'Visual: console errors' }, { name: 'Lighthouse' }] },
    ];
    expect(offeredChecks(missions, 'r1').map(check => check.label)).toEqual(['Tests']);
    expect(offeredChecks(missions).map(check => check.name)).toEqual(['Combined candidate tests', 'Visual: console errors', 'Lighthouse']);
    expect(offeredChecks([]).map(check => check.name)).toEqual(['Combined candidate tests']);
  });
});
