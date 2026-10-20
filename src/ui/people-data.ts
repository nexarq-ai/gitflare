import type { AccessSnapshot, Repository } from "../shared/types";
import { repositoryLabel } from "../shared/repository-names";

export type InviteScope = "organization" | "workspace" | "repository";
export type Invitation = AccessSnapshot["invitations"][number];
export type Member = AccessSnapshot["members"][number];

export const INVITE_ROLES = ["Viewer", "Triager", "Contributor", "Reviewer", "Maintainer", "Deployer"] as const;

export const ROLE_HELP: Record<string, string> = {
  Viewer: "Viewer: read code, proposals and checks.",
  Triager: "Triager: label, close, lock and moderate issues, cannot change code.",
  Contributor: "Contributor: propose changes and run agents, cannot land or deploy.",
  Reviewer: "Reviewer: review and approve proposals and triage issues, cannot change code.",
  Maintainer: "Maintainer: propose, review and land changes, cannot deploy.",
  Deployer: "Deployer: deploy to environments and read code.",
  Owner: "Owner: everything, including people, Cloudflare and settings.",
};

export function rolesFor(scope: InviteScope): string[] {
  return scope === "repository" ? INVITE_ROLES.filter(role => role !== "Deployer") : [...INVITE_ROLES];
}

export function parseEmails(value: string): string[] {
  return [...new Set(value.split(/[\s,;]+/).map(item => item.trim().toLowerCase()).filter(Boolean))];
}

export function pendingInvitations(data: AccessSnapshot, now = Date.now()): Invitation[] {
  return data.invitations.filter(item => !item.accepted && item.expiresAt > now).sort((a, b) => a.expiresAt - b.expiresAt);
}

export function repositoryName(repositories: Repository[], id: string, fallback?: string): string {
  const found = repositories.find(repo => repo.id === id);
  return found ? repositoryLabel(found) : fallback ?? "A removed repository";
}

export function invitationAccess(invitation: Invitation, repositories: Repository[]): string {
  const scope = invitation.scope;
  if (scope?.kind === "organization") return "All your workspaces";
  if (scope?.kind === "repository") return repositoryName(repositories, scope.repositoryId, scope.repositoryName);
  return "This workspace";
}

export function memberAccess(member: Member, repositories: Repository[]): string {
  if (member.role === "Owner" || !member.repositoryIds) return "All repositories";
  const ids = member.repositoryIds;
  if (!ids.length) return "No repositories";
  return ids.length === 1 ? repositoryName(repositories, ids[0]) : `${ids.length} repositories`;
}

export function expiresIn(expiresAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((expiresAt - now) / 60000));
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `in ${hours} h`;
}

const AUDIT_VERBS: Record<string, string> = {
  "access:invite:workspace": "invited someone to this workspace",
  "access:invite:repository": "invited someone to {resource}",
  "access:invite:organization": "invited someone to all their workspaces",
  "access:invite": "invited someone",
  "access:invite-resend": "resent an invitation",
  "access:invite-revoke": "withdrew an invitation",
  "access:accept-invite": "accepted an invitation",
  "access:repository-member": "joined {resource}",
  "access:membership": "changed {subject}'s access",
  "access:transfer": "transferred ownership to {subject}",
  "access:leave": "left the workspace",
  "access:workspace-rename": "renamed the workspace",
  "access:team-create": "created a team",
  "access:team-member": "changed a team",
  "access:grant": "gave {subject} access to a resource",
  "access:grant-revoke": "removed a resource grant",
  "access:credential-create": "created an agent task credential",
  "access:credential-revoke": "revoked an agent task credential",
  "access:protection": "changed what a change needs before it lands",
  "access:session-create": "created a personal MCP token",
  "access:session-revoke": "signed out a session",
  "access:client-connect": "connected an AI client",
  "access:user-create": "created {subject}'s account",
  "access:organization-member-added": "added {subject} from all their workspaces",
  "access:organization-member-removed": "removed {subject} from all their workspaces",
  "workspace:create": "created a workspace",
  "cloudflare:put": "connected a Cloudflare account",
  "cloudflare:delete": "disconnected Cloudflare",
  "workspace:switch": "switched into this workspace",
  "account:cloudflare-signin": "signed in with Cloudflare",
  "account:cloudflare-signup": "joined with Cloudflare",
};

const REQUEST_VERBS: Record<string, string> = { read: "read", contribute: "proposed changes in", execute: "ran agents in", review: "reviewed in", land: "landed changes in", deploy: "deployed", migrate: "ran migrations in", manage: "managed" };

type AuditEntry = { action: string; actorId: string; resourceId?: string; timestamp: string };
export function isRequestRecord(entry: { action: string }): boolean { return entry.action in REQUEST_VERBS; }

export function visibleAudit<T extends AuditEntry>(entries: T[], includeRequests: boolean): T[] {
  return entries.filter(entry => {
    if (!includeRequests && isRequestRecord(entry)) return false;
    if (entry.action !== "access:invite") return true;
    const at = Date.parse(entry.timestamp);
    return !entries.some(other => other.action.startsWith("access:invite:") && other.actorId === entry.actorId && Math.abs(Date.parse(other.timestamp) - at) < 2000);
  });
}

export function auditSentence(entry: { action: string; actorId: string; resourceId?: string }, names: (userId: string) => string, repositories: Repository[]): string {
  const actor = names(entry.actorId);
  if (isRequestRecord(entry)) return `${actor} ${REQUEST_VERBS[entry.action]} ${entry.resourceId && repositories.some(repo => repo.id === entry.resourceId) ? repositoryName(repositories, entry.resourceId) : "the workspace"}.`;
  const template = AUDIT_VERBS[entry.action];
  if (!template) return `${actor} · ${entry.action.replace(/[:_-]+/g, " ")}`;
  const resource = entry.resourceId ? repositoryName(repositories, entry.resourceId, "a repository") : "a repository";
  const subject = entry.resourceId ? names(entry.resourceId) : "someone";
  return `${actor} ${template.replace("{resource}", resource).replace("{subject}", subject)}.`;
}

export function personName(data: AccessSnapshot, userId: string): string {
  if (userId === data.user.id) return "You";
  if (userId === "bootstrap-owner") return "The installation owner token";
  if (userId === "platform-operator") return "The Gitflare operator";
  const member = data.members.find(item => item.userId === userId)?.user ?? data.organization?.members.find(item => item.userId === userId)?.user;
  return member?.name || member?.email || "A former member";
}
