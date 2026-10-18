import { ApiError } from './domain';

export const SESSION_COOKIE = 'gitflare_session';
export const SESSION_IDLE_MS = 7 * 86_400_000;
export const SESSION_ABSOLUTE_MS = 30 * 86_400_000;
export const SESSION_RENEW_INTERVAL_MS = 3_600_000;

export interface SlidingSession { expiresAt: number; authenticatedAt?: number; sliding?: boolean }

export function slidingExpiry(authenticatedAt: number, now: number): number {
  return Math.min(now + SESSION_IDLE_MS, authenticatedAt + SESSION_ABSOLUTE_MS);
}

export function renewedExpiry(session: SlidingSession, now: number): number | undefined {
  if (!session.sliding || session.authenticatedAt === undefined || session.expiresAt <= now) return undefined;
  const next = slidingExpiry(session.authenticatedAt, now);
  return next - session.expiresAt >= SESSION_RENEW_INTERVAL_MS ? next : undefined;
}

export function sessionCookie(token: string, maxAgeMs = SESSION_IDLE_MS): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`;
}

export const CLEAR_SESSION_COOKIE = sessionCookie('', 0);

export function sessionCookieValue(request: Request): string | undefined {
  return request.headers.get('Cookie')?.split(';').map(item => item.trim()).find(item => item.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1) || undefined;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// SameSite=Lax still attaches the cookie to sibling-subdomain requests, so cookie-authenticated writes must prove a same-origin browser context
export function assertCookieRequestOrigin(request: Request): void {
  if (SAFE_METHODS.has(request.method) || !sessionCookieValue(request) || request.headers.get('Authorization')?.startsWith('Bearer ')) return;
  const origin = request.headers.get('Origin');
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  const sameOrigin = origin ? origin === new URL(request.url).origin : fetchSite === 'same-origin';
  if (!sameOrigin || fetchSite !== null && fetchSite !== 'same-origin') throw new ApiError(403, 'ORIGIN_REJECTED', 'Requests must originate from this application.');
}
