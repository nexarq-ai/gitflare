export interface HostOrigins { site: string; app: string }

function origin(value: string | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.origin === value.replace(/\/+$/, '') ? url.origin : null; } catch { return null; }
}

export function hostOrigins(siteOrigin: string | undefined, appOrigin: string | undefined): HostOrigins | null {
  const site = origin(siteOrigin); const app = origin(appOrigin);
  return site && app && site !== app ? { site, app } : null;
}

export const PRERENDER_SITE_ORIGIN = 'https://site.prerender.gitflare.invalid';
export const PRERENDER_APP_ORIGIN = 'https://app.prerender.gitflare.invalid';
export const PRERENDER_APP_LINK = 'https://app-link.prerender.gitflare.invalid';
