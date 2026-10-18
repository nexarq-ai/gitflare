import { hasSignedInHint, SIGNED_IN_HINT_COOKIE, signedInHintDomain } from '../shared/signed-in-hint';
import type { AppEnv } from './env';
import { SESSION_ABSOLUTE_MS, SESSION_COOKIE, sessionCookieValue } from './session-policy';

export function signedInHintCookie(domain: string, maxAgeSeconds: number): string {
  return `${SIGNED_IN_HINT_COOKIE}=${maxAgeSeconds > 0 ? '1' : ''}; Domain=${domain}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; Secure; SameSite=Lax`;
}

function issuedSession(response: Response): { value: string; maxAge: number } | null {
  const cookie = response.headers.getSetCookie().find(item => item.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) return null;
  const value = cookie.slice(SESSION_COOKIE.length + 1).split(';')[0];
  const maxAge = Number(/;\s*Max-Age=(\d+)/i.exec(cookie)?.[1] ?? 0);
  return { value, maxAge: value ? maxAge : 0 };
}

function hintFor(request: Request, response: Response, domain: string): string | null {
  const issued = issuedSession(response);
  if (issued) {
    if (issued.maxAge === 0) return signedInHintCookie(domain, 0);
    if (issued.value !== sessionCookieValue(request)) return signedInHintCookie(domain, SESSION_ABSOLUTE_MS / 1000);
    return hasSignedInHint(request.headers.get('Cookie')) ? null : signedInHintCookie(domain, issued.maxAge);
  }
  const cookieAuthenticated = !!sessionCookieValue(request) && !request.headers.get('Authorization')?.startsWith('Bearer ');
  const sessionRejected = response.status === 401 && cookieAuthenticated && request.method === 'GET' && new URL(request.url).pathname === '/api/session';
  return sessionRejected && hasSignedInHint(request.headers.get('Cookie')) ? signedInHintCookie(domain, 0) : null;
}

export function withSignedInHint(request: Request, response: Response, env: Pick<AppEnv, 'SITE_ORIGIN' | 'APP_ORIGIN'>): Response {
  if (response.status === 101) return response;
  const domain = signedInHintDomain(env.SITE_ORIGIN, env.APP_ORIGIN);
  const hint = domain ? hintFor(request, response, domain) : null;
  if (!hint) return response;
  const marked = new Response(response.body, response);
  marked.headers.append('Set-Cookie', hint);
  return marked;
}
