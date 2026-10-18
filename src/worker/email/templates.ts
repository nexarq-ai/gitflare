import { plainLine, renderEmail, type EmailContext, type RenderedEmail } from './layout';

export type InvitationEmailScope = { kind: 'workspace' } | { kind: 'organization'; ownerName: string } | { kind: 'repository'; repositoryName: string };
export interface InvitationTemplateInput { email: string; workspaceName: string; link: string; role?: string; sentAt?: Date; scope?: InvitationEmailScope }
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

export function invitationEmail(input: InvitationTemplateInput, context: EmailContext): RenderedEmail {
  const workspace = plainLine(input.workspaceName, 100) || 'a Gitflare workspace';
  const target = invitationScopeLine(input.scope, input.workspaceName);
  const reach = input.scope?.kind === 'organization' ? 'You will also join any workspace they create later.' : input.scope?.kind === 'repository' ? 'You will see only this repository.' : '';
  return renderEmail({
    subject: `Invitation to ${target}`,
    preheader: `You have been invited to join ${target} on Gitflare.`,
    eyebrow: 'Workspace invitation',
    heading: 'You’re invited to build together',
    accent: 'together',
    paragraphs: [`You have been invited to join ${target} on Gitflare, where people and AI agents propose, review and land changes together.${reach ? ` ${reach}` : ''}`, `Accept the invitation and sign in with the account for ${input.email}.`],
    action: { label: 'Accept invitation', url: input.link },
    details: [...(input.scope && input.scope.kind !== 'workspace' ? [['Access', target] as [string, string], ['Invited from', workspace] as [string, string]] : [['Workspace', workspace] as [string, string]]), ...(input.role ? [['Role', plainLine(input.role, 40)] as [string, string]] : []), ['Invited address', input.email], ['Sent', formatSentAt(input.sentAt)], ['Expires', '24 hours after sending']],
    note: 'This invitation can only be used once. If you were not expecting it, you can ignore this email and nothing will change.',
    reason: `You received this email because a workspace owner invited ${input.email} to Gitflare.`,
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

const SAMPLE_SENT_AT = new Date('2026-10-17T09:42:00Z');
const SAMPLE_TOKEN = '0123456789abcdef'.repeat(4);
export const emailPreviews: Record<string, (context: EmailContext) => RenderedEmail> = {
  'invitation-organization': context => invitationEmail({ email: 'new.member@example.com', workspaceName: 'Acme Platform', role: 'Contributor', scope: { kind: 'organization', ownerName: 'Asha Rao' }, sentAt: SAMPLE_SENT_AT, link: `${context.origin}/invite#token=${SAMPLE_TOKEN}` }, context),
  'invitation-repository': context => invitationEmail({ email: 'new.member@example.com', workspaceName: 'Acme Platform', role: 'Viewer', scope: { kind: 'repository', repositoryName: 'billing-api' }, sentAt: SAMPLE_SENT_AT, link: `${context.origin}/invite#token=${SAMPLE_TOKEN}` }, context),
  invitation: context => invitationEmail({ email: 'new.member@example.com', workspaceName: 'Acme <Platform> & Friends', role: 'Maintainer', sentAt: SAMPLE_SENT_AT, link: `${context.origin}/invite#token=${SAMPLE_TOKEN}` }, context),
  verification: context => verificationEmail({ email: 'new.member@example.com', sentAt: SAMPLE_SENT_AT, link: `${context.origin}/verify-email#${SAMPLE_TOKEN}` }, context),
  'password-reset': context => passwordResetEmail({ email: 'new.member@example.com', sentAt: SAMPLE_SENT_AT, link: `${context.origin}/reset-password#${SAMPLE_TOKEN}` }, context),
};
