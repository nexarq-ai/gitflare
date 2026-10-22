export const NOTIFICATION_REASONS = ['review_requested', 'mention', 'approval_needed', 'deploy_failed', 'participating', 'watching', 'subscribed'] as const;
export type NotificationReason = typeof NOTIFICATION_REASONS[number];
export const EMAIL_MODES = ['instant', 'digest', 'off'] as const;
export type EmailMode = typeof EMAIL_MODES[number];
export const NOTIFICATION_EVENTS = ['opened', 'commented', 'reviewed', 'changes_requested', 'approved', 'checks_passed', 'checks_failed', 'awaiting_checks', 'landed', 'closed', 'reopened', 'review_requested', 'mentioned', 'deploy_failed', 'released'] as const;
export type NotificationEvent = typeof NOTIFICATION_EVENTS[number];
export type NotificationSubjectKind = 'issue' | 'proposal' | 'deployment' | 'revision' | 'release';
export type SubscriptionState = 'subscribed' | 'ignored' | 'none';

export interface NotificationPreferences { email: boolean; reasons: Record<NotificationReason, EmailMode> }
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  email: false,
  reasons: { review_requested: 'instant', mention: 'instant', approval_needed: 'digest', deploy_failed: 'instant', participating: 'off', watching: 'off', subscribed: 'digest' },
};

export interface NotificationSubject {
  kind: NotificationSubjectKind;
  workspaceId: string;
  repositoryId: string;
  repositoryName: string;
  title: string;
  number?: number;
  missionId?: string;
  deploymentId?: string;
  sha?: string;
  tag?: string;
  outsideAuthorId?: string;
  forkRepositoryId?: string;
  publicPath?: string;
}

export interface NotificationPerson { name: string; handle: string | null }

export interface NotificationItem {
  id: string;
  reason: NotificationReason;
  reasons: NotificationReason[];
  event: NotificationEvent;
  subject: NotificationSubject;
  actorId?: string;
  actor?: NotificationPerson | null;
  excerpt?: string;
  count: number;
  createdAt: string;
  updatedAt: string;
  readAt?: string;
  archivedAt?: string;
  route: string;
}

export interface NotificationList { items: NotificationItem[]; unread: number; total: number; offset: number; nextOffset: number | null }
export interface NotificationEmailStatus { address: string | null; verified: boolean; configured: boolean; nextDigestAt: string | null; sentToday: number; dailyLimit: number }
export interface NotificationSettings { preferences: NotificationPreferences; email: NotificationEmailStatus }

export const INBOX_KINDS = ['awaiting_checks', 'review_requested', 'needs_review', 'new_issue', 'security_report'] as const;
export type InboxKind = typeof INBOX_KINDS[number];
export interface InboxRow {
  id: string;
  kind: InboxKind;
  version: string;
  repositoryId: string;
  repositoryName: string;
  title: string;
  missionId?: string;
  number?: number;
  advisoryId?: string;
  authorId?: string;
  author?: NotificationPerson | null;
  outside?: boolean;
  owners?: string[];
  updatedAt: string;
  route: string;
  actions: ('run_checks' | 'open')[];
}
export interface InboxView { rows: InboxRow[]; archived: number; repositories: { id: string; name: string }[]; total: number; offset: number; nextOffset: number | null }

export interface CodeownerGroup { handles: string[]; userIds: string[]; paths: string[]; approvedBy?: string[] }
export interface ReviewRequests { epoch: number; candidateSha: string; baseSha: string; source: string | null; groups: CodeownerGroup[]; requestedAt: string }

export function threadKey(subject: Pick<NotificationSubject, 'kind' | 'repositoryId' | 'number' | 'missionId' | 'deploymentId' | 'sha' | 'tag'>): string {
  if (subject.kind === 'issue') return `issue:${subject.repositoryId}:${subject.number}`;
  if (subject.kind === 'proposal') return `proposal:${subject.repositoryId}:${subject.missionId}`;
  if (subject.kind === 'revision') return `revision:${subject.repositoryId}:${subject.sha}`;
  if (subject.kind === 'release') return `release:${subject.repositoryId}:${subject.tag}`;
  return `deployment:${subject.repositoryId}:${subject.deploymentId}`;
}

export const REASON_LABELS: Record<NotificationReason, string> = {
  review_requested: 'Review requested',
  mention: 'Mentioned',
  approval_needed: 'Approval needed',
  deploy_failed: 'Deploy failed',
  participating: 'Participating',
  watching: 'Watching',
  subscribed: 'Subscribed',
};

export const EVENT_LABELS: Record<NotificationEvent, string> = {
  opened: 'opened',
  commented: 'commented',
  reviewed: 'reviewed',
  changes_requested: 'requested changes',
  approved: 'approved',
  checks_passed: 'checks passed',
  checks_failed: 'checks failed',
  awaiting_checks: 'waiting for checks',
  landed: 'landed',
  closed: 'closed',
  reopened: 'reopened',
  review_requested: 'requested your review',
  mentioned: 'mentioned you',
  deploy_failed: 'deploy failed',
  released: 'published a release',
};
