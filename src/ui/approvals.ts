import type { AccessSnapshot } from "../shared/types";
import { checkIdentity, REQUIRABLE_CHECKS, type RequirableCheck } from "../shared/checks";

const APPROVER_ROLES = new Set(["Reviewer", "Maintainer", "Owner"]);

export function eligibleApprovers(members: AccessSnapshot["members"], repositoryId?: string): number {
  return members.filter(member => APPROVER_ROLES.has(member.role) && (!repositoryId || member.role === "Owner" || !member.repositoryIds || member.repositoryIds.includes(repositoryId))).length;
}

const people = (count: number) => count === 1 ? "1 person" : `${count} people`;

export function approvalWarning(required: number, approvers: number, preventSelfApproval: boolean): { blocking: boolean; text: string } | null {
  if (required <= 0) return null;
  if (required > approvers) return { blocking: true, text: approvers === 0 ? "Nobody here can approve yet, so nothing could land. Lower this or invite reviewers." : `Only ${people(approvers)} can approve here, so nothing could land. Lower this or invite reviewers.` };
  if (preventSelfApproval && required > approvers - 1) return { blocking: false, text: approvers === 1 ? "You are the only person who can approve. With authors unable to approve their own changes, your own changes could never land." : `When one of the ${approvers} approvers writes a change, only ${approvers === 2 ? "1 other person" : `${approvers - 1} others`} can approve it.` };
  return null;
}

export function selfApprovalNote(approvers: number): string {
  return approvers <= 1
    ? "Whoever writes a change cannot approve it. You are the only person who can approve here, so turning this on means your own changes need a reviewer you have not invited yet."
    : "Whoever writes a change cannot approve it, so another person has to.";
}

export function offeredChecks(missions: { repositoryId: string; checks: { name?: string }[] }[], repositoryId?: string): RequirableCheck[] {
  const seen = new Set<string>();
  for (const mission of missions) if (!repositoryId || mission.repositoryId === repositoryId) for (const check of mission.checks) if (check.name) seen.add(checkIdentity(check.name));
  return REQUIRABLE_CHECKS.filter(check => !check.visual || seen.has(check.name));
}
