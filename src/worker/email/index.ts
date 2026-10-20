import { absoluteUrl, type EmailContext, type RenderedEmail } from './layout';
import { invitationEmail, passwordResetEmail, verificationEmail, type InvitationEmailScope } from './templates';

export interface InvitationEmailEnv { EMAIL?: SendEmail; EMAIL_FROM?: string; EMAIL_REPLY_TO?: string; EDITION?: string }
export interface InvitationEmailInput { email: string; token: string; workspaceName: string; origin: string; role?: string; scope?: InvitationEmailScope; inviterName?: string }
export interface AccountEmailInput { email: string; token: string; origin: string }
export type InvitationDelivery = { status: 'sent'; messageId: string } | { status: 'unconfigured' | 'error'; code: string; message: string };
export interface EmailSender { email: string; name: string }

const DELIVERY_FAILURE_CODES = ['E_RECIPIENT_NOT_ALLOWED', 'E_RECIPIENT_SUPPRESSED', 'E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED', 'E_DELIVERY_FAILED', 'E_INTERNAL_SERVER_ERROR', 'E_CONTENT_TOO_LARGE'];
const NOT_ONBOARDED_CODES = ['E_SENDER_NOT_VERIFIED', 'E_SENDER_DOMAIN_NOT_AVAILABLE'];
const DEFAULT_SENDER_NAME = 'Gitflare';

function validEmail(value: string): boolean { return value.length <= 254 && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(value); }

export function parseSender(value: string | undefined): EmailSender | null {
  const raw = value?.trim();
  if (!raw) return null;
  const named = /^([^<>"\r\n]{1,64})<([^<>\s]+)>$/.exec(raw);
  const sender = named ? { name: named[1].trim(), email: named[2] } : { name: DEFAULT_SENDER_NAME, email: raw };
  return sender.name && validEmail(sender.email) ? sender : null;
}

export function emailConfigured(env: InvitationEmailEnv): boolean { return !!env.EMAIL && !!env.EMAIL_FROM; }

type Wording = { unconfigured: string; prepare: string; origin: string; insecure: string; rejected: string; notOnboarded: string };
async function deliver(env: InvitationEmailEnv, input: { email: string; token: string; origin: string }, route: string, compose: (link: string, context: EmailContext) => RenderedEmail, wording: Wording): Promise<InvitationDelivery> {
  if (!env.EMAIL || !env.EMAIL_FROM) return { status: 'unconfigured', code: 'EMAIL_NOT_CONFIGURED', message: wording.unconfigured };
  const sender = parseSender(env.EMAIL_FROM);
  const replyTo = env.EMAIL_REPLY_TO?.trim();
  if (!sender || replyTo && !validEmail(replyTo)) return { status: 'unconfigured', code: 'EMAIL_SENDER_INVALID', message: 'This installation has an invalid email sender configuration (EMAIL_FROM or EMAIL_REPLY_TO).' };
  if (!validEmail(input.email) || !/^[a-f0-9]{64}$/i.test(input.token)) return { status: 'error', code: 'INVALID_EMAIL_INPUT', message: wording.prepare };
  let origin: URL;
  try { origin = new URL(input.origin); } catch { return { status: 'error', code: 'INVALID_INVITATION_ORIGIN', message: wording.origin }; }
  try { absoluteUrl(origin.href); } catch { return { status: 'error', code: 'INVALID_INVITATION_ORIGIN', message: wording.insecure }; }
  const context: EmailContext = { edition: env.EDITION === 'self-hosted' ? 'self-hosted' : 'hosted', origin: origin.origin };
  const message = compose(`${origin.origin}/${route}${encodeURIComponent(input.token)}`, context);
  try {
    const result = await env.EMAIL.send({ from: sender, to: input.email, ...(replyTo ? { replyTo } : {}), ...message });
    return { status: 'sent', messageId: result.messageId };
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    if (NOT_ONBOARDED_CODES.includes(code)) return { status: 'error', code, message: wording.notOnboarded.replace('{domain}', sender.email.split('@')[1]) };
    return { status: 'error', code: DELIVERY_FAILURE_CODES.includes(code) ? code : 'EMAIL_SEND_FAILED', message: wording.rejected };
  }
}

export function deliverInvitation(env: InvitationEmailEnv, input: InvitationEmailInput): Promise<InvitationDelivery> {
  return deliver(env, input, 'invite#token=', (link, context) => invitationEmail({ email: input.email, workspaceName: input.workspaceName, role: input.role, scope: input.scope, inviterName: input.inviterName, link }, context), {
    unconfigured: 'The invitation is ready. This installation has no email sender configured.',
    prepare: 'The invitation email could not be prepared.',
    origin: 'The invitation link origin is invalid.',
    insecure: 'The invitation link needs a secure application origin.',
    rejected: 'The invitation is ready, but the email service did not accept delivery. You can share the invitation securely or retry with a new invitation.',
    notOnboarded: 'The invitation is ready, but no email was sent: Cloudflare Email Sending is not onboarded for {domain}. Share the invitation securely or ask the operator to finish Email Sending setup.',
  });
}

const accountWording: Wording = {
  unconfigured: 'This installation has no email sender configured.',
  prepare: 'The email could not be prepared.',
  origin: 'The link origin is invalid.',
  insecure: 'The link needs a secure application origin.',
  rejected: 'The email service did not accept delivery.',
  notOnboarded: 'No email was sent: Cloudflare Email Sending is not onboarded for {domain}.',
};
export function deliverVerification(env: InvitationEmailEnv, input: AccountEmailInput): Promise<InvitationDelivery> {
  return deliver(env, input, 'verify-email#', (link, context) => verificationEmail({ email: input.email, link }, context), accountWording);
}
export function deliverPasswordReset(env: InvitationEmailEnv, input: AccountEmailInput): Promise<InvitationDelivery> {
  return deliver(env, input, 'reset-password#', (link, context) => passwordResetEmail({ email: input.email, link }, context), accountWording);
}

export async function deliverNotificationEmail(env: InvitationEmailEnv, input: { email: string; message: RenderedEmail; unsubscribeUrl: string }): Promise<InvitationDelivery> {
  if (!env.EMAIL || !env.EMAIL_FROM) return { status: 'unconfigured', code: 'EMAIL_NOT_CONFIGURED', message: accountWording.unconfigured };
  const sender = parseSender(env.EMAIL_FROM);
  if (!sender || !validEmail(input.email)) return { status: 'error', code: 'INVALID_EMAIL_INPUT', message: accountWording.prepare };
  try {
    const result = await env.EMAIL.send({ from: sender, to: input.email, headers: { 'List-Unsubscribe': `<${absoluteUrl(input.unsubscribeUrl)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }, ...input.message });
    return { status: 'sent', messageId: result.messageId };
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    return { status: 'error', code: DELIVERY_FAILURE_CODES.includes(code) || NOT_ONBOARDED_CODES.includes(code) ? code : 'EMAIL_SEND_FAILED', message: accountWording.rejected };
  }
}
