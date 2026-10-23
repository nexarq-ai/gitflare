import { useEffect, useSyncExternalStore } from "react";
import { hostOrigins, PRERENDER_APP_LINK, PRERENDER_APP_ORIGIN, type HostOrigins } from "../shared/hosts";
import { hasSignedInHint, SIGNED_IN_STATUS_PATH } from "../shared/signed-in-hint";
import { isPublicProductRoute, isSiteRoute, SIGNED_IN_PRODUCT_ROUTES } from "./router";
import { pageCookie, pageLocation, serverPageContext } from "./page-context";

function meta(name: string): string | undefined {
  return typeof document === "undefined" ? undefined : document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content;
}

export function pageHostOrigins(): HostOrigins | null {
  const server = serverPageContext();
  if (server) return hostOrigins(server.siteOrigin, server.appOrigin);
  return hostOrigins(meta("gitflare-site-origin"), meta("gitflare-app-origin"));
}

function onOrigin(origin: string | undefined, path: string): string {
  return origin && origin !== pageLocation().origin ? `${origin}${path}` : path;
}

const prerendering = () => typeof window === "undefined" && import.meta.env.GITFLARE_PRERENDER === "true";

export function appHref(path: string): string {
  return prerendering() ? `${PRERENDER_APP_LINK}${path}` : onOrigin(pageHostOrigins()?.app, path);
}

export function siteHref(path: string): string {
  return prerendering() ? path : onOrigin(pageHostOrigins()?.site, path);
}

export function appOrigin(): string {
  return prerendering() ? PRERENDER_APP_ORIGIN : pageHostOrigins()?.app ?? window.location.origin;
}

export function crossHostTarget(origins: HostOrigins | null, current: string, route: string, location: string, signedIn: boolean | null): string | null {
  if (!origins) return null;
  if (current === origins.site) return isSiteRoute(route) ? null : `${origins.app}${location}`;
  if (current !== origins.app || signedIn === null) return null;
  if (route === "home") return `${origins.app}${signedIn ? "/overview" : "/signin"}`;
  if (!isPublicProductRoute(route) || (signedIn && SIGNED_IN_PRODUCT_ROUTES.includes(route))) return null;
  return `${origins.site}${route === "repositories" ? "/explore" : location}`;
}

const SITE_SESSION_CHECKED = "gitflare:site-session-checked";
const SITE_SESSION_EVENT = "gitflare:site-session";
let siteSessionCheck: Promise<boolean> | null = null;
let confirmed: boolean | null = null;
let hintedAtLoad: boolean | null = null;

export function siteVisit(origins: HostOrigins | null = pageHostOrigins()): boolean {
  return !!origins && (!!serverPageContext() || typeof window !== "undefined") && pageLocation().origin === origins.site;
}

export function siteSignedInHint(origins: HostOrigins | null = pageHostOrigins()): boolean {
  if (!siteVisit(origins)) return false;
  if (serverPageContext()) return hasSignedInHint(pageCookie());
  return confirmed ?? hasSignedInHint(pageCookie());
}

function checkedThisVisit(): boolean {
  try { return sessionStorage.getItem(SITE_SESSION_CHECKED) === "1"; } catch { return false; }
}

function settleSiteSession(signedIn: boolean): boolean {
  try { sessionStorage.setItem(SITE_SESSION_CHECKED, "1"); } catch {}
  const before = siteSignedInHint();
  confirmed = signedIn;
  if (before !== signedIn) window.dispatchEvent(new Event(SITE_SESSION_EVENT));
  return signedIn;
}

export function confirmSiteSession(origins: HostOrigins | null = pageHostOrigins()): Promise<boolean> {
  if (!origins || !siteVisit(origins)) return Promise.resolve(false);
  if (siteSessionCheck) return siteSessionCheck;
  if (confirmed !== null || checkedThisVisit()) return Promise.resolve(siteSignedInHint(origins));
  siteSessionCheck = fetch(`${origins.app}${SIGNED_IN_STATUS_PATH}`, { credentials: "include", cache: "no-store" })
    .then(response => response.ok ? response.json() as Promise<{ signedIn?: unknown }> : null)
    .then(body => body ? settleSiteSession(body.signedIn === true) : siteSignedInHint(origins), () => siteSignedInHint(origins));
  return siteSessionCheck;
}

function subscribeSiteSession(listener: () => void): () => void {
  window.addEventListener(SITE_SESSION_EVENT, listener);
  return () => window.removeEventListener(SITE_SESSION_EVENT, listener);
}

function hydrationSignedIn(): boolean {
  if (serverPageContext()) return siteSignedInHint();
  hintedAtLoad ??= siteVisit() && hasSignedInHint(pageCookie());
  return hintedAtLoad;
}

export function useSiteSignedInHint(): boolean {
  const signedIn = useSyncExternalStore(subscribeSiteSession, () => siteSignedInHint(), hydrationSignedIn);
  useEffect(() => {
    if (!siteVisit()) return;
    const run = () => void confirmSiteSession();
    const idle = typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(run, { timeout: 4000 }) : null;
    const timer = idle === null ? setTimeout(run, 2000) : undefined;
    return () => {
      if (idle !== null) window.cancelIdleCallback(idle);
      clearTimeout(timer);
    };
  }, []);
  return signedIn;
}

export function anonymousSiteVisit(origins: HostOrigins | null = pageHostOrigins()): boolean {
  return siteVisit(origins) && !hasSignedInHint(pageCookie());
}
