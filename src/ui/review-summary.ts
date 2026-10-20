import type { CodeownerGroup, ReviewRequests } from "../shared/notifications";
import type { Mission } from "../shared/types";

export type ReviewVerdict = "comment" | "request_changes" | "approve";
export interface ApprovalProgress { approvals: number; requiredApprovals: number; ready: boolean; missingOwners?: string[][] }
export interface OwnerGroupStatus { handles: string[]; paths: string[]; state: "clear" | "missing" | "pending" }

export const VERDICTS: ReviewVerdict[] = ["comment", "request_changes", "approve"];
export const VERDICT_LABELS: Record<ReviewVerdict, string> = { comment: "Comment", request_changes: "Request changes", approve: "Approve" };

export function reviewKindLabel(kind: string): string {
  return kind === "approve" ? "Approved" : kind === "request_changes" ? "Changes requested" : "Comment";
}

export function currentReviewRequests(mission: Pick<Mission, "reviewRequests" | "epoch" | "candidateSha" | "baseSha">): ReviewRequests | null {
  const requests = mission.reviewRequests;
  if (!requests?.groups.length || requests.epoch !== mission.epoch || requests.candidateSha !== mission.candidateSha || requests.baseSha !== mission.baseSha) return null;
  return requests;
}

function sameMembers(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every(id => b.includes(id));
}

export function ownerGroupStatus(groups: CodeownerGroup[], missingOwners?: string[][]): OwnerGroupStatus[] {
  return groups.map(group => {
    const missing = !!missingOwners?.some(ids => sameMembers(ids, group.userIds));
    const state = missing ? "missing" : group.approvedBy?.length || missingOwners ? "clear" : "pending";
    return { handles: group.handles, paths: group.paths, state };
  });
}

export function verdictAvailable(verdict: ReviewVerdict, context: { canReview: boolean; canComment: boolean; readyForApproval: boolean }): boolean {
  if (verdict === "comment") return context.canComment || context.canReview;
  if (verdict === "request_changes") return context.canReview;
  return context.canReview && context.readyForApproval;
}

export function submitReviewBody(verdict: ReviewVerdict, mission: Pick<Mission, "epoch" | "candidateSha" | "baseSha">, body: string, extra: { approveDependencies?: boolean; commitMessage?: string } = {}) {
  const text = body.trim();
  return {
    verdict,
    epoch: mission.epoch,
    candidateSha: mission.candidateSha,
    baseSha: mission.baseSha,
    ...(text ? { body: text } : {}),
    ...(verdict === "approve" && extra.approveDependencies !== undefined ? { approveDependencies: extra.approveDependencies } : {}),
    ...(verdict === "approve" && extra.commitMessage !== undefined ? { commitMessage: extra.commitMessage } : {}),
  };
}
