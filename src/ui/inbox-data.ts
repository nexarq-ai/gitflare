import { EVENT_LABELS, REASON_LABELS, type EmailMode, type InboxKind, type InboxRow, type NotificationItem, type NotificationPerson, type NotificationPreferences, type NotificationReason } from "../shared/notifications";
import { typingTarget } from "./workspace-chord";

export type InboxSegment = "work" | "notifications";
export type NotificationFilter = "unread" | "all" | "archived";
export type InboxCommand = "next" | "previous" | "open" | "archive" | "toggle-read" | "read-all";

export interface InboxFilters {
  segment: InboxSegment;
  repository: string;
  kind: InboxKind | "";
  reason: NotificationReason | "";
  age: string;
  filter: NotificationFilter;
  archived: boolean;
}

export const INBOX_PAGE = 30;
export const DEFAULT_INBOX_FILTERS: InboxFilters = { segment: "work", repository: "", kind: "", reason: "", age: "", filter: "unread", archived: false };

export const KIND_LABELS: Record<InboxKind, string> = {
  review_requested: "Review requested",
  awaiting_checks: "Awaiting checks",
  needs_review: "Needs review",
  new_issue: "New issue",
  security_report: "Security report",
};

export const AGE_OPTIONS: [string, string][] = [["", "Any time"], ["1", "Last day"], ["7", "Last 7 days"], ["30", "Last 30 days"]];

export const MODE_LABELS: Record<EmailMode, string> = { instant: "Instant", digest: "Daily digest", off: "Off" };

export const REASON_TIPS: Record<NotificationReason, string> = {
  review_requested: "You are a code owner of changed files, or someone asked for your review.",
  mention: "Someone wrote your @handle in an issue, proposal or comment.",
  approval_needed: "A proposal you can approve has passed its checks.",
  deploy_failed: "A deploy of a repository you can land in failed.",
  participating: "Activity on threads you opened, commented on or reviewed.",
  watching: "Activity on threads you subscribed to or repositories you watch.",
};

export function inboxQuery(filters: InboxFilters, offset = 0): string {
  const params = new URLSearchParams();
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.repository) params.set("repository", filters.repository);
  if (filters.age) params.set("age", filters.age);
  if (filters.archived) params.set("archived", "true");
  if (offset) params.set("offset", String(offset));
  params.set("limit", String(INBOX_PAGE));
  return params.toString();
}

export function notificationsQuery(filters: InboxFilters, offset = 0): string {
  const params = new URLSearchParams({ filter: filters.filter });
  if (filters.reason) params.set("reason", filters.reason);
  if (filters.repository) params.set("repository", filters.repository);
  if (filters.age) params.set("age", filters.age);
  if (offset) params.set("offset", String(offset));
  params.set("limit", String(INBOX_PAGE));
  return params.toString();
}

export function withinAge(at: string, age: string, now = Date.now()): boolean {
  if (!age) return true;
  return Date.parse(at) >= now - Number(age) * 86_400_000;
}

type KeyLike = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "target">;

function insideControl(target: EventTarget | null, selector: string): boolean {
  return !!target && typeof (target as Element).closest === "function" && !!(target as Element).closest(selector);
}

export function inboxCommand(event: KeyLike): InboxCommand | null {
  if (event.metaKey || event.ctrlKey || event.altKey || typingTarget(event.target) || insideControl(event.target, "[role='dialog'], [role='alertdialog']")) return null;
  if (event.shiftKey) return event.key === "I" ? "read-all" : null;
  switch (event.key) {
    case "j": return "next";
    case "k": return "previous";
    case "o": return "open";
    case "Enter": return insideControl(event.target, "a, button") ? null : "open";
    case "e": return "archive";
    case "u": return "toggle-read";
    default: return null;
  }
}

export function moveSelection(current: number, length: number, delta: 1 | -1): number {
  if (!length) return -1;
  if (current < 0) return 0;
  return Math.max(0, Math.min(length - 1, current + delta));
}

export function selectionAfterRemoval(index: number, length: number): number {
  return length ? Math.min(Math.max(index, 0), length - 1) : -1;
}

export function threadFromSearch(search: string): string | null {
  const thread = new URLSearchParams(search).get("thread");
  return thread && thread.length <= 300 ? thread : null;
}

export function threadRoute(thread: string): string | null {
  const [kind, repositoryId, id] = thread.split(":");
  if (!repositoryId || !id || !/^[a-zA-Z0-9-]+$/.test(repositoryId) || !/^[a-zA-Z0-9-]+$/.test(id)) return null;
  if (kind === "issue" && /^\d+$/.test(id)) return `repository/${repositoryId}/issues/${id}`;
  if (kind === "proposal") return `mission/${id}/discussion`;
  return null;
}

export function workspaceRoute(route: string): boolean {
  return /^(?:repository|mission)\//.test(route);
}

export function openTarget(item: Pick<NotificationItem, "route" | "subject">, currentWorkspaceId: string): { switchTo: string | null; route: string } {
  const switchTo = workspaceRoute(item.route) && item.subject.workspaceId && item.subject.workspaceId !== currentWorkspaceId ? item.subject.workspaceId : null;
  return { switchTo, route: item.route };
}

export function badgeLabel(count: number): string {
  return count <= 0 ? "" : count > 99 ? "99+" : String(count);
}

export function personName(person: NotificationPerson | null | undefined): string {
  if (!person) return "Someone";
  return person.handle ? `@${person.handle}` : person.name;
}

export function notificationLine(item: Pick<NotificationItem, "actor" | "event" | "count">): string {
  const actor = item.event === "checks_passed" || item.event === "checks_failed" || item.event === "awaiting_checks" || item.event === "deploy_failed" ? "" : `${personName(item.actor)} `;
  return `${actor}${EVENT_LABELS[item.event]}${item.count > 1 ? ` · ${item.count} updates` : ""}`;
}

export function reasonList(reasons: NotificationReason[]): string {
  return reasons.map(reason => REASON_LABELS[reason]).join(" · ");
}

export function rowReference(row: Pick<InboxRow, "number" | "kind">): string {
  return row.kind === "new_issue" && row.number ? `#${row.number}` : "";
}

export function setReasonMode(preferences: NotificationPreferences, reason: NotificationReason, mode: EmailMode): NotificationPreferences {
  return { ...preferences, reasons: { ...preferences.reasons, [reason]: mode } };
}

export function sentTodayLabel(sent: number, limit: number): string {
  return `Sent today ${sent} of ${limit}`;
}
