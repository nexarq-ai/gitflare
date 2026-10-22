import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { currentReviewRequests, ownerGroupStatus, reviewKindLabel, submitReviewBody, verdictAvailable } from '../src/ui/review-summary';
import { nextSubscription, publicThreadTarget, subscriptionQuery } from '../src/ui/SubscribeButton';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('thread subscriptions', () => {
  it('toggles between subscribed and ignored', () => {
    expect(nextSubscription('subscribed')).toBe('ignored');
    expect(nextSubscription('ignored')).toBe('subscribed');
    expect(nextSubscription('none')).toBe('subscribed');
  });

  it('addresses member and public threads', () => {
    expect(subscriptionQuery({ kind: 'proposal', repositoryId: 'r1', missionId: 'm1' })).toBe('kind=proposal&repositoryId=r1&missionId=m1');
    expect(publicThreadTarget('/api/public/repos/acme/widgets', 3)).toEqual({ kind: 'issue', handle: 'acme', repository: 'widgets', number: 3 });
    expect(subscriptionQuery(publicThreadTarget('/api/public/repos/acme/my%20repo', 4)!)).toBe('kind=issue&handle=acme&repository=my+repo&number=4');
    expect(publicThreadTarget('/api/repositories/r1', 3)).toBeNull();
  });

  it('shows the bell on issues, public issues and proposals', () => {
    expect(read('src/ui/Issues.tsx')).toContain('<SubscribeButton target={{ kind: "issue", repositoryId: repository.id, number: issue.number }} />');
    expect(read('src/ui/PublicIssues.tsx')).toContain('viewer.signedIn && subscription && <div className="pub-issue-subscribe"><SubscribeButton target={subscription} /></div>');
    expect(read('src/ui/MissionDetail.tsx')).toContain('<SubscribeButton target={{ kind: "proposal", repositoryId: mission.repositoryId, missionId: mission.id }} />');
  });
});

describe('review summaries', () => {
  const mission = { epoch: 2, candidateSha: 'c'.repeat(40), baseSha: 'b'.repeat(40) };

  it('labels approvals, change requests and comments', () => {
    expect(reviewKindLabel('approve')).toBe('Approved');
    expect(reviewKindLabel('request_changes')).toBe('Changes requested');
    expect(reviewKindLabel('comment')).toBe('Comment');
    expect(read('src/ui/UpstreamProposals.tsx')).toContain('{reviewKindLabel(review.kind)}');
  });

  it('binds a review to the exact revision', () => {
    expect(submitReviewBody('comment', mission, '  Looks good  ')).toEqual({ verdict: 'comment', ...mission, body: 'Looks good' });
    expect(submitReviewBody('approve', mission, '', { approveDependencies: true, commitMessage: 'Ship it' })).toEqual({ verdict: 'approve', ...mission, approveDependencies: true, commitMessage: 'Ship it' });
    expect(submitReviewBody('request_changes', mission, 'Fix', { approveDependencies: true })).toEqual({ verdict: 'request_changes', ...mission, body: 'Fix' });
  });

  it('offers approve only to reviewers when the revision is ready', () => {
    const base = { canReview: true, canComment: true, readyForApproval: true };
    expect(verdictAvailable('approve', base)).toBe(true);
    expect(verdictAvailable('approve', { ...base, readyForApproval: false })).toBe(false);
    expect(verdictAvailable('request_changes', { ...base, canReview: false })).toBe(false);
    expect(verdictAvailable('comment', { ...base, canReview: false })).toBe(true);
  });

  it('routes the discussion approve through the shared confirm and submit-review', () => {
    const detail = read('src/ui/MissionDetail.tsx');
    expect(detail).toContain('if (chosenVerdict === "approve") openConfirm("approve", true);');
    expect(detail).toContain('if (action === "approve" && approveFromReview.current) void submitReview("approve", message); else void act(action, message);');
    expect(detail).toContain('/submit-review');
  });
});

describe('code owner review requests', () => {
  const requests = { epoch: 2, candidateSha: 'c1', baseSha: 'b1', source: '.gitflare/CODEOWNERS', requestedAt: '2026-10-20T00:00:00Z', groups: [{ handles: ['asha'], userIds: ['u1'], paths: ['src/a.ts'] }, { handles: ['lee', 'kim'], userIds: ['u2', 'u3'], paths: ['docs/x.md'] }] };

  it('shows requests for the current revision only', () => {
    expect(currentReviewRequests({ reviewRequests: requests, epoch: 2, candidateSha: 'c1', baseSha: 'b1' })).toBe(requests);
    expect(currentReviewRequests({ reviewRequests: requests, epoch: 3, candidateSha: 'c1', baseSha: 'b1' })).toBeNull();
    expect(currentReviewRequests({ reviewRequests: { ...requests, groups: [] }, epoch: 2, candidateSha: 'c1', baseSha: 'b1' })).toBeNull();
  });

  it('marks groups still missing an approval', () => {
    expect(ownerGroupStatus(requests.groups).map(group => group.state)).toEqual(['pending', 'pending']);
    expect(ownerGroupStatus(requests.groups, [['u3', 'u2']]).map(group => group.state)).toEqual(['clear', 'missing']);
    expect(ownerGroupStatus([{ ...requests.groups[0]!, approvedBy: ['u1'] }]).map(group => group.state)).toEqual(['clear']);
  });

  it('offers the code owner rule in stream protection', () => {
    const source = read('src/ui/BranchProtection.tsx');
    expect(source).toContain('Require code owner approval');
    expect(source).toContain('...(codeowners ? { codeowners: true } : {})');
  });
});
