import { hostOrigins, type HostOrigins } from "../shared/hosts";
import { hasSignedInHint } from "../shared/signed-in-hint";
import { isPublicProductRoute, isSiteRoute, SIGNED_IN_PRODUCT_ROUTES } from "./router";

function meta(name: string): string | undefined {
  return typeof document === "undefined" ? undefined : document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content;
}

export function pageHostOrigins(): HostOrigins | null {
  return hostOrigins(meta("gitflare-site-origin"), meta("gitflare-app-origin"));
}

function onOrigin(origin: string | undefined, path: string): string {
  return origin && origin !== window.location.origin ? `${origin}${path}` : path;
}

export function appHref(path: string): string {
  return onOrigin(pageHostOrigins()?.app, path);
}

export function siteHref(path: string): string {
  return onOrigin(pageHostOrigins()?.site, path);
}

export function appOrigin(): string {
  return pageHostOrigins()?.app ?? window.location.origin;
}

export function crossHostTarget(origins: HostOrigins | null, current: string, route: string, location: string, signedIn: boolean | null): string | null {
  if (!origins) return null;
  if (current === origins.site) return isSiteRoute(route) ? null : `${origins.app}${location}`;
  if (current !== origins.app || signedIn === null) return null;
  if (route === "home") return `${origins.app}${signedIn ? "/overview" : "/signin"}`;
  if (!isPublicProductRoute(route) || (signedIn && SIGNED_IN_PRODUCT_ROUTES.includes(route))) return null;
  return `${origins.site}${location}`;
}

export function siteSignedInHint(origins: HostOrigins | null = pageHostOrigins()): boolean {
  return !!origins && typeof document !== "undefined" && window.location.origin === origins.site && hasSignedInHint(document.cookie);
}
