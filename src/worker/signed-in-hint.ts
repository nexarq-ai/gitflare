import { hasSignedInHint, SIGNED_IN_HINT_COOKIE, SIGNED_IN_STATUS_PATH, signedInHintDomain } from '../shared/signed-in-hint';
import type { AppEnv } from './env';
import { envHostOrigins } from './host-split';
import { clientIp, consume, rateLimitedResponse } from './rate-limits';
import { SESSION_ABSOLUTE_MS, SESSION_COOKIE, SESSION_IDLE_MS, sessionCookieValue } from './session-policy';

type HintEnv = Pick<AppEnv, 'SITE_ORIGIN' | 'APP_ORIGIN'>;
export type SignedIn = (request: Request) => Promise<boolean>;

const REFRESHED_HINT_SECONDS = SESSION_IDLE_MS / 1000;

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

function cookieSession(request: Request): boolean {
  return !!sessionCookieValue(request) && !request.headers.get('Authorization')?.startsWith('Bearer ');
}

async function hintFor(request: Request, response: Response, env: HintEnv, domain: string, signedIn: SignedIn): Promise<string | null> {
  const hinted = hasSignedInHint(request.headers.get('Cookie'));
  const issued = issuedSession(response);
  if (issued) {
    if (issued.maxAge === 0) return signedInHintCookie(domain, 0);
    if (issued.value !== sessionCookieValue(request)) return signedInHintCookie(domain, SESSION_ABSOLUTE_MS / 1000);
    return hinted ? null : signedInHintCookie(domain, issued.maxAge);
  }
  if (request.method !== 'GET' || !cookieSession(request)) return null;
  const url = new URL(request.url);
  if (url.pathname === '/api/session') {
    if (response.status === 401) return hinted ? signedInHintCookie(domain, 0) : null;
    return response.status === 200 && !hinted ? signedInHintCookie(domain, REFRESHED_HINT_SECONDS) : null;
  }
  const appDocument = url.origin === envHostOrigins(env)?.app && response.status === 200 && !!response.headers.get('Content-Type')?.includes('text/html');
  return !hinted && appDocument && await signedIn(request) ? signedInHintCookie(domain, REFRESHED_HINT_SECONDS) : null;
}

export async function withSignedInHint(request: Request, response: Response, env: HintEnv, signedIn: SignedIn): Promise<Response> {
  if (response.status === 101) return response;
  const domain = signedInHintDomain(env.SITE_ORIGIN, env.APP_ORIGIN);
  const hint = domain ? await hintFor(request, response, env, domain, signedIn) : null;
  if (!hint) return response;
  const marked = new Response(response.body, response);
  marked.headers.append('Set-Cookie', hint);
  return marked;
}

export async function signedInStatusResponse(request: Request, env: AppEnv, signedIn: SignedIn): Promise<Response | null> {
  const url = new URL(request.url);
  const origins = envHostOrigins(env);
  const domain = signedInHintDomain(env.SITE_ORIGIN, env.APP_ORIGIN);
  if (url.pathname !== SIGNED_IN_STATUS_PATH || !origins || !domain || url.origin !== origins.app) return null;
  const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' });
  if (request.method !== 'GET') { headers.set('Allow', 'GET'); return new Response(null, { status: 405, headers }); }
  if (request.headers.get('Origin') !== origins.site) return Response.json({ error: { code: 'ORIGIN_REJECTED', message: 'This check answers only the Gitflare site.' } }, { status: 403, headers });
  headers.set('Access-Control-Allow-Origin', origins.site);
  headers.set('Access-Control-Allow-Credentials', 'true');
  const limited = await consume(env, 'API_RATE_LIMIT', `ip:${clientIp(request)}`);
  if (limited) {
    const response = rateLimitedResponse(limited, 'session checks');
    for (const [name, value] of headers) response.headers.set(name, value);
    return response;
  }
  const active = cookieSession(request) && await signedIn(request);
  const hinted = hasSignedInHint(request.headers.get('Cookie'));
  if (active !== hinted) headers.append('Set-Cookie', signedInHintCookie(domain, active ? REFRESHED_HINT_SECONDS : 0));
  return Response.json({ signedIn: active }, { headers });
}
