import { hostOrigins } from './hosts';

export const SIGNED_IN_HINT_COOKIE = 'gf_signed_in';
export const SIGNED_IN_STATUS_PATH = '/api/session/signed-in';

const SHARED_HOST_SUFFIXES = ['workers.dev', 'pages.dev', 'github.io', 'vercel.app', 'netlify.app', 'herokuapp.com', 'co.uk', 'org.uk', 'com.au', 'co.in', 'co.jp'];

function labels(hostname: string): string[] | null {
  if (!hostname.includes('.') || /^[\d.]+$/.test(hostname) || hostname.includes(':')) return null;
  return hostname.toLowerCase().split('.');
}

export function signedInHintDomain(siteOrigin: string | undefined, appOrigin: string | undefined): string | null {
  const origins = hostOrigins(siteOrigin, appOrigin);
  if (!origins) return null;
  const site = new URL(origins.site); const app = new URL(origins.app);
  if (site.protocol !== 'https:' || app.protocol !== 'https:' || site.port !== app.port) return null;
  const siteLabels = labels(site.hostname); const appLabels = labels(app.hostname);
  if (!siteLabels || !appLabels) return null;
  const shared: string[] = [];
  while (shared.length < Math.min(siteLabels.length, appLabels.length) && siteLabels[siteLabels.length - 1 - shared.length] === appLabels[appLabels.length - 1 - shared.length]) shared.unshift(siteLabels[siteLabels.length - 1 - shared.length]);
  if (shared.length < 2) return null;
  const domain = shared.join('.');
  return SHARED_HOST_SUFFIXES.some(suffix => domain === suffix || domain.endsWith(`.${suffix}`)) ? null : domain;
}

export function hasSignedInHint(cookieHeader: string | null | undefined): boolean {
  return !!cookieHeader?.split(';').some(item => item.trim() === `${SIGNED_IN_HINT_COOKIE}=1`);
}
