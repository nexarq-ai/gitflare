import { useEffect, useState } from "react";
import { hostOrigins, type HostOrigins } from "../shared/hosts";
import { hasSignedInHint, SIGNED_IN_STATUS_PATH } from "../shared/signed-in-hint";
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

const SITE_SESSION_CHECKED = "gitflare:site-session-checked";
const SITE_SESSION_EVENT = "gitflare:site-session";
let siteSessionCheck: Promise<boolean> | null = null;
let confirmedSignedIn = false;

export function siteSignedInHint(origins: HostOrigins | null = pageHostOrigins()): boolean {
  return !!origins && typeof document !== "undefined" && window.location.origin === origins.site && (confirmedSignedIn || hasSignedInHint(document.cookie));
}

function checkedThisVisit(): boolean {
  try { return sessionStorage.getItem(SITE_SESSION_CHECKED) === "1"; } catch { return false; }
}

export function confirmSiteSession(origins: HostOrigins | null = pageHostOrigins()): Promise<boolean> {
  if (!origins || !anonymousSiteVisit(origins)) return Promise.resolve(siteSignedInHint(origins));
  if (siteSessionCheck) return siteSessionCheck;
  if (checkedThisVisit()) return Promise.resolve(false);
  siteSessionCheck = fetch(`${origins.app}${SIGNED_IN_STATUS_PATH}`, { credentials: "include", cache: "no-store" })
    .then(response => response.ok ? response.json() as Promise<{ signedIn?: unknown }> : { signedIn: false })
    .then(body => {
      try { sessionStorage.setItem(SITE_SESSION_CHECKED, "1"); } catch {}
      if (body.signedIn !== true) return false;
      confirmedSignedIn = true;
      window.dispatchEvent(new Event(SITE_SESSION_EVENT));
      return true;
    }, () => false);
  return siteSessionCheck;
}

export function useSiteSignedInHint(): boolean {
  const [signedIn, setSignedIn] = useState(() => siteSignedInHint());
  useEffect(() => {
    const update = () => setSignedIn(siteSignedInHint());
    window.addEventListener(SITE_SESSION_EVENT, update);
    if (!anonymousSiteVisit()) return () => window.removeEventListener(SITE_SESSION_EVENT, update);
    const run = () => void confirmSiteSession();
    const idle = typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(run, { timeout: 4000 }) : null;
    const timer = idle === null ? setTimeout(run, 2000) : undefined;
    return () => {
      window.removeEventListener(SITE_SESSION_EVENT, update);
      if (idle !== null) window.cancelIdleCallback(idle);
      clearTimeout(timer);
    };
  }, []);
  return signedIn;
}

export function anonymousSiteVisit(origins: HostOrigins | null = pageHostOrigins()): boolean {
  return !!origins && typeof document !== "undefined" && window.location.origin === origins.site && !hasSignedInHint(document.cookie);
}
