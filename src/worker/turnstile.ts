import { ApiError } from './domain';
import type { AppEnv } from './env';

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function turnstileSiteKey(env: Pick<AppEnv, 'TURNSTILE_SITE_KEY' | 'TURNSTILE_SECRET_KEY'>): string | null {
  return env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? env.TURNSTILE_SITE_KEY : null;
}

export async function verifyTurnstile(env: Pick<AppEnv, 'TURNSTILE_SITE_KEY' | 'TURNSTILE_SECRET_KEY'>, token: unknown, client: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (!turnstileSiteKey(env)) return;
  if (typeof token !== 'string' || !token || token.length > 2048) throw new ApiError(403, 'TURNSTILE_REQUIRED', 'Confirm you are human to post. New accounts do this for their first 7 days.');
  const form = new FormData();
  form.set('secret', env.TURNSTILE_SECRET_KEY!);
  form.set('response', token);
  if (client !== 'local') form.set('remoteip', client);
  const result = await fetcher(TURNSTILE_VERIFY_URL, { method: 'POST', body: form }).then(response => response.json() as Promise<{ success?: boolean }>).catch(() => null);
  if (!result?.success) throw new ApiError(403, 'TURNSTILE_REQUIRED', 'The human check expired or failed. Complete it again and resend.');
}
