import { diffHasLine, parseFilePatch } from '../shared/diff';
import type { Mission, ReviewMissionInput } from '../shared/types';
import { ApiError, requireString } from './domain';
import { validGitSha } from './artifacts';

function lineAnchor(body: Record<string, unknown>): Pick<ReviewMissionInput, 'path' | 'line' | 'side'> {
  if (body.path === undefined && body.line === undefined && body.side === undefined) return {};
  if (body.action === 'resolve') throw new ApiError(400, 'INVALID_REVIEW', 'A resolution cannot target a line.');
  const path = requireString(body.path, 'File path', 1000);
  if (!Number.isSafeInteger(body.line) || Number(body.line) < 1) throw new ApiError(400, 'INVALID_REVIEW', 'A line comment needs a positive line number.');
  if (body.side !== 'old' && body.side !== 'new') throw new ApiError(400, 'INVALID_REVIEW', 'A line comment side must be old or new.');
  return { path, line: Number(body.line), side: body.side };
}

export const REVIEW_VERDICTS = ['comment', 'approve', 'request_changes'] as const;
export type ReviewVerdict = typeof REVIEW_VERDICTS[number];

export function reviewMissionInput(body: Record<string, unknown>): ReviewMissionInput {
  const summary = body.summary === true;
  if (body.summary !== undefined && typeof body.summary !== 'boolean') throw new ApiError(400, 'INVALID_REVIEW', 'summary must be true or false.');
  if (!['comment', 'request_changes', 'resolve', ...(summary ? ['approve'] : [])].includes(String(body.action))) throw new ApiError(400, 'INVALID_REVIEW', 'Choose a comment, request changes, or resolve a review.');
  if (summary && (body.action === 'resolve' || body.path !== undefined || body.line !== undefined)) throw new ApiError(400, 'INVALID_REVIEW', 'A review summary covers the whole revision.');
  if (!Number.isSafeInteger(body.epoch) || Number(body.epoch) < 1) throw new ApiError(400, 'INVALID_REVIEW', 'An exact execution attempt is required.');
  const candidateSha = requireString(body.candidateSha, 'Candidate commit', 40, 40);
  const baseSha = requireString(body.baseSha, 'Base commit', 40, 40);
  if (!validGitSha(candidateSha) || !validGitSha(baseSha)) throw new ApiError(400, 'INVALID_COMMIT', 'Commit identifiers must be 40 lowercase hexadecimal characters.');
  const action = body.action as ReviewMissionInput['action'];
  const message = action === 'resolve' ? { reviewId: requireString(body.reviewId, 'Review', 100) } : action === 'approve' ? { body: body.body === undefined || body.body === '' ? '' : requireString(body.body, 'Review message', 8000) } : { body: requireString(body.body, 'Review message', 8000) };
  return { action, epoch: Number(body.epoch), candidateSha, baseSha, ...message, ...(summary ? { summary: true } : {}), ...lineAnchor(body) };
}

export function assertLineInCandidate(mission: Mission, input: ReviewMissionInput): void {
  if (input.path === undefined) return;
  const change = mission.changes.find((entry) => entry.path === input.path);
  if (!change) throw new ApiError(400, 'REVIEW_LINE_NOT_IN_DIFF', 'This file is not part of the current candidate changes.');
  if (!diffHasLine(parseFilePatch(change.patch, change.path), input.side!, input.line!)) throw new ApiError(400, 'REVIEW_LINE_NOT_IN_DIFF', 'This line is not shown in the current candidate diff.');
}

export function isOutdatedReview(mission: Pick<Mission, 'epoch' | 'candidateSha' | 'baseSha'>, review: { epoch: number; candidateSha: string; baseSha: string }): boolean {
  return review.epoch !== mission.epoch || review.candidateSha !== mission.candidateSha || review.baseSha !== mission.baseSha;
}

export function currentReviewRequests(mission: Mission) {
  return (mission.reviews ?? []).filter((review) => review.kind === 'request_changes' && !review.resolvedAt && review.epoch === mission.epoch && review.candidateSha === mission.candidateSha && review.baseSha === mission.baseSha);
}

export function assertReviewClear(mission: Mission): void {
  if (currentReviewRequests(mission).length) throw new ApiError(409, 'CHANGES_REQUESTED', 'Resolve the current reviewer requests before approving or landing this candidate.');
}
