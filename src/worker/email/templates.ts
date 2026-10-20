import { plainLine, renderEmail, type EmailContext, type RenderedEmail } from './layout';
import { EVENT_LABELS, REASON_LABELS, type NotificationEvent, type NotificationReason } from '../../shared/notifications';

export type InvitationEmailScope = { kind: 'workspace' } | { kind: 'organization'; ownerName: string } | { kind: 'repository'; repositoryName: string };
export interface InvitationTemplateInput { email: string; workspaceName: string; link: string; role?: string; sentAt?: Date; scope?: InvitationEmailScope; inviterName?: string }
export interface AccountTemplateInput { email: string; link: string; sentAt?: Date }

export function formatSentAt(date = new Date()): string {
  return `${date.toLocaleString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} UTC`;
}

export function invitationScopeLine(scope: InvitationEmailScope | undefined, workspaceName: string): string {
  const workspace = plainLine(workspaceName, 100) || 'a Gitflare workspace';
  if (scope?.kind === 'organization') return `all workspaces of ${plainLine(scope.ownerName, 100) || 'the inviting owner'}`;
  if (scope?.kind === 'repository') return `${plainLine(scope.repositoryName, 100) || 'one repository'} in ${workspace}`;
  return workspace;
}

const ROLE_HELP: Record<string, string> = {
  Viewer: 'read code, proposals and history',
  Contributor: 'propose changes and run agents, cannot land or deploy',
  Reviewer: 'review and approve changes, cannot land',
  Maintainer: 'land approved changes and manage repository settings',
  Deployer: 'deploy and promote environments',
};

export function invitationReach(scope: InvitationEmailScope | undefined, workspaceName: string): string {
  if (scope?.kind === 'organization') return `You will also join any workspace ${plainLine(scope.ownerName, 100) || 'they'} creates later.`;
  if (scope?.kind === 'repository') return `You will see only ${plainLine(scope.repositoryName, 100) || 'this repository'}.`;
  return `You will see every repository in ${plainLine(workspaceName, 100) || 'the workspace'}.`;
}

export function invitationEmail(input: InvitationTemplateInput, context: EmailContext): RenderedEmail {
  const workspace = plainLine(input.workspaceName, 100) || 'a Gitflare workspace';
  const target = invitationScopeLine(input.scope, input.workspaceName);
  const inviter = input.inviterName ? plainLine(input.inviterName, 100) : '';
  const role = input.role ? plainLine(input.role, 40) : '';
  const help = role ? ROLE_HELP[role] : undefined;
  return renderEmail({
    subject: `Invitation to ${target}`,
    preheader: `${inviter || 'A workspace owner'} invited you to ${target} on Gitflare.`,
    eyebrow: 'Workspace invitation',
    heading: `${inviter || 'You are'} invited ${inviter ? 'you ' : ''}to ${target} on Gitflare.`,
    accent: target,
    paragraphs: [
      'Gitflare is where people and AI agents propose, review and land changes together.',
      invitationReach(input.scope, input.workspaceName),
      ...(role ? [`Role: ${role}${help ? ` — ${help}` : ''}.`] : []),
    ],
    action: { label: 'Accept invitation', url: input.link },
    details: [...(input.scope && input.scope.kind !== 'workspace' ? [['Access', target] as [string, string], ['Invited from', workspace] as [string, string]] : [['Workspace', workspace] as [string, string]]), ...(role ? [['Role', role] as [string, string]] : []), ['Invited address', input.email], ['Sent', formatSentAt(input.sentAt)], ['Expires', '24 hours after sending']],
    note: `Sign in with the account for ${input.email}. The link works once and expires in 24 hours. If you did not expect this, ignore this email; nothing happens until you accept.`,
    reason: `You received this email because ${inviter || 'a workspace owner'} invited ${input.email} to Gitflare.`,
  }, context);
}

export function verificationEmail(input: AccountTemplateInput, context: EmailContext): RenderedEmail {
  return renderEmail({
    subject: 'Verify your Gitflare email address',
    preheader: `Confirm that ${input.email} belongs to you.`,
    eyebrow: 'Account verification',
    heading: 'Verify your email address',
    accent: 'email',
    paragraphs: [`Confirm that ${input.email} belongs to you so Gitflare can send you account and security email.`],
    action: { label: 'Verify email address', url: input.link },
    details: [['Account', input.email], ['Sent', formatSentAt(input.sentAt)], ['Expires', '24 hours after sending']],
    note: 'This link can only be used once. If you did not create a Gitflare account, you can ignore this email.',
    reason: `You received this email because someone used ${input.email} for a Gitflare account.`,
  }, context);
}

export function passwordResetEmail(input: AccountTemplateInput, context: EmailContext): RenderedEmail {
  return renderEmail({
    subject: 'Reset your Gitflare password',
    preheader: `Choose a new password for ${input.email}.`,
    eyebrow: 'Password reset',
    heading: 'Choose a new password',
    accent: 'password',
    paragraphs: [`Someone asked to reset the password for ${input.email}. Choose a new password to continue.`, 'Choosing a new password signs out every existing session.'],
    action: { label: 'Choose a new password', url: input.link },
    details: [['Account', input.email], ['Requested', formatSentAt(input.sentAt)], ['Expires', '1 hour after sending']],
    note: 'This link can only be used once. If you did not ask for this, you can ignore this email and your password stays the same.',
    reason: `You received this email because a password reset was requested for ${input.email}.`,
  }, context);
}

export interface NotificationEmailItem { reason: NotificationReason; event: NotificationEvent; repository: string; title: string; reference: string; actor?: string; excerpt?: string; url: string }
export interface NotificationEmailInput { email: string; items: NotificationEmailItem[]; digest: boolean; inboxUrl: string; settingsUrl: string; unsubscribeUrl: string; sentAt?: Date }

function notificationLine(item: NotificationEmailItem): string {
  const label = EVENT_LABELS[item.event];
  const lead = item.actor ? `${plainLine(item.actor, 60)} ${label}` : `${label[0]!.toUpperCase()}${label.slice(1)}`;
  return `${lead}${item.excerpt ? `: ${plainLine(item.excerpt, 280)}` : '.'}`;
}

export function notificationEmail(input: NotificationEmailInput, context: EmailContext): RenderedEmail {
  const items = input.items.slice(0, 20);
  const first = items[0]!;
  const title = plainLine(first.title, 120) || 'Untitled';
  const repository = plainLine(first.repository, 120);
  if (input.digest) {
    const count = input.items.length;
    return renderEmail({
      subject: `Gitflare digest: ${count} update${count === 1 ? '' : 's'}`,
      preheader: `${count} update${count === 1 ? '' : 's'} across your repositories since the last digest.`,
      eyebrow: 'Daily digest',
      heading: `${count} update${count === 1 ? '' : 's'} waiting in your inbox`,
      accent: 'inbox',
      paragraphs: ['A summary of what happened in the repositories and threads you follow. Each item links to the inbox, where you can open, mark read or archive it.'],
      action: { label: 'Open inbox', url: input.inboxUrl },
      details: items.map(item => [`${plainLine(item.repository, 60)} ${plainLine(item.reference, 20)}`, `${plainLine(item.title, 100)} — ${notificationLine(item)}`] as [string, string]),
      note: `${count > items.length ? `Showing ${items.length} of ${count}. ` : ''}Choose which notifications reach your email, or turn email off, in Account → Notifications: ${input.settingsUrl}`,
      reason: `You received this email because notification email is on for ${input.email}.`,
      unsubscribe: { label: 'Unsubscribe from all Gitflare notification email', url: input.unsubscribeUrl },
    }, context);
  }
  const label = REASON_LABELS[first.reason];
  return renderEmail({
    subject: `[${repository}] ${title} (${first.reference})`,
    preheader: notificationLine(first),
    eyebrow: label,
    heading: title,
    accent: title,
    paragraphs: [notificationLine(first)],
    action: { label: 'Open in Gitflare', url: first.url },
    details: [['Repository', repository], ['Item', `${plainLine(first.reference, 20)} ${title}`], ['Reason', label], ['Sent', formatSentAt(input.sentAt)]],
    note: `Gitflare sends at most a few of these an hour; the rest wait for your daily digest. Change what reaches your email in Account → Notifications: ${input.settingsUrl}`,
    reason: `You received this email because ${label.toLowerCase()} notifications are on for ${input.email}.`,
    unsubscribe: { label: `Stop ${label.toLowerCase()} email`, url: input.unsubscribeUrl },
  }, context);
}

const SAMPLE_SENT_AT = new Date('2026-10-17T09:42:00Z');
const SAMPLE_TOKEN = '0123456789abcdef'.repeat(4);
export const emailPreviews: Record<string, (context: EmailContext) => RenderedEmail> = {
  'invitation-organization': context => invitationEmail({ email: 'new.member@example.com', workspaceName: 'Acme Platform', role: 'Contributor', scope: { kind: 'organization', ownerName: 'Asha Rao' }, inviterName: 'Asha Rao', sentAt: SAMPLE_SENT_AT, link: `${context.origin}/invite#token=${SAMPLE_TOKEN}` }, context),
  'invitation-repository': context => invitationEmail({ email: 'new.member@example.com', workspaceName: 'Acme Platform', role: 'Viewer', scope: { kind: 'repository', repositoryName: 'billing-api' }, inviterName: 'Asha Rao', sentAt: SAMPLE_SENT_AT, link: `${context.origin}/invite#token=${SAMPLE_TOKEN}` }, context),
  invitation: context => invitationEmail({ email: 'new.member@example.com', workspaceName: 'Acme <Platform> & Friends', role: 'Maintainer', sentAt: SAMPLE_SENT_AT, link: `${context.origin}/invite#token=${SAMPLE_TOKEN}` }, context),
  verification: context => verificationEmail({ email: 'new.member@example.com', sentAt: SAMPLE_SENT_AT, link: `${context.origin}/verify-email#${SAMPLE_TOKEN}` }, context),
  'password-reset': context => passwordResetEmail({ email: 'new.member@example.com', sentAt: SAMPLE_SENT_AT, link: `${context.origin}/reset-password#${SAMPLE_TOKEN}` }, context),
  'notification-review': context => notificationEmail({ email: 'new.member@example.com', digest: false, sentAt: SAMPLE_SENT_AT, inboxUrl: `${context.origin}/inbox`, settingsUrl: `${context.origin}/account/notifications`, unsubscribeUrl: `${context.origin}/api/public/notifications/unsubscribe?user=u1&token=${SAMPLE_TOKEN}&reason=review_requested`, items: [{ reason: 'review_requested', event: 'review_requested', repository: 'acme/billing-api', title: 'Retry webhooks with backoff', reference: 'proposal', actor: 'Asha Rao', excerpt: 'You own src/webhooks/ in CODEOWNERS.', url: `${context.origin}/inbox?thread=proposal%3Arepo%3Am1` }] }, context),
  'notification-digest': context => notificationEmail({ email: 'new.member@example.com', digest: true, sentAt: SAMPLE_SENT_AT, inboxUrl: `${context.origin}/inbox`, settingsUrl: `${context.origin}/account/notifications`, unsubscribeUrl: `${context.origin}/api/public/notifications/unsubscribe?user=u1&token=${SAMPLE_TOKEN}&reason=all`, items: [
    { reason: 'approval_needed', event: 'checks_passed', repository: 'acme/billing-api', title: 'Format totals per currency', reference: 'proposal', url: `${context.origin}/inbox` },
    { reason: 'mention', event: 'commented', repository: 'acme/widgets', title: 'Crash on empty cart', reference: '#42', actor: 'Ana', excerpt: '@asha can you confirm the fix covers guest checkout?', url: `${context.origin}/inbox` },
    { reason: 'deploy_failed', event: 'deploy_failed', repository: 'acme/storefront', title: 'production deploy of 3f2a91c', reference: 'deploy', excerpt: 'Build failed: missing environment variable STRIPE_KEY.', url: `${context.origin}/inbox` },
  ] }, context),
};
