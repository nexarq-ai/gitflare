import type { Mission, PullRequestState } from './types';

export function pullRequestState(mission: Pick<Mission, 'status' | 'branchChange'>): PullRequestState {
  if (mission.branchChange?.closedAt) return 'closed';
  if (mission.status === 'integrated') return 'landed';
  if (mission.status === 'approved' || mission.status === 'integrating') return 'approved';
  if (mission.status === 'needs_review') return 'needs_review';
  return 'open';
}

export function isOutsideProposal(mission: Pick<Mission, 'branchChange'>): boolean { return !!mission.branchChange?.source; }

export function proposalAuthor(mission: Pick<Mission, 'authorization' | 'branchChange'>): string | undefined { return mission.authorization?.creatorId ?? mission.branchChange?.source?.authorId; }

export function waitingForMaintainer(mission: Pick<Mission, 'branchChange' | 'status'>): boolean { return !!mission.branchChange?.gate && mission.status === 'draft' && !mission.branchChange.closedAt; }
