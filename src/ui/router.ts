import { HANDLE_PATTERN, OPERATOR_HANDLES, PUBLIC_ISSUE_PATH, RESERVED_HANDLES, type PublicRepositoryView } from "../shared/handles";

const ROUTE_EVENT = "gitflare:route";
// Bearer tokens travel in the fragment so they never reach server logs or Referer headers
const TOKEN_ROUTES: Record<string, (fragment: string) => string> = {
  invite: (fragment) => `invite?${fragment}`,
  "verify-email": (fragment) => `verify-email/${fragment}`,
  "reset-password": (fragment) => `reset-password/${fragment}`,
};
const ROUTE_ALIASES: [RegExp, string][] = [
  [/^login$/, "signin"],
  [/^access$/, "settings/people"],
  [/^(repository\/[^/]+)\/(?:streams|settings\/(?:streams|checks))$/, "$1/settings/branches"],
  [/^(repository\/[^/]+)\/settings\/(?:mirror|github-mirror)$/, "$1/settings"],
  [/^(repository\/[^/]+)\/(?:deployments|settings\/(?:deployments|environments))$/, "$1/settings/deploys"],
  [/^(repository\/[^/]+)\/cloudflare$/, "$1/settings/cloudflare"],
  [/^(repository\/[^/]+)\/checkpoints(\/|$)/, "$1/releases$2"],
];
const SERVER_PATH = /^\/(api|mcp|oauth|\.well-known|llms\.txt|assets|social|git|source\/gitflare\.git)(\/|$)|\.[a-z0-9]+$/i;

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

export function routeFromLocation(pathname: string, hash: string): string {
  let path: string;
  try { path = trimSlashes(decodeURIComponent(pathname)); } catch { return "not-found"; }
  const fragment = hash.slice(1);
  if (!path) return fragment || "home";
  const tokenRoute = TOKEN_ROUTES[path];
  if (tokenRoute) return fragment ? tokenRoute(fragment) : path;
  return ROUTE_ALIASES.reduce((route, [pattern, target]) => route.replace(pattern, target), path);
}

export function routeUrl(route: string): string {
  if (!route || route === "home") return "/";
  const query = route.indexOf("?");
  if (query > 0 && !route.startsWith("invite?")) return `${routeUrl(route.slice(0, query))}${route.slice(query)}`;
  if (route.startsWith("invite?")) return `/invite#${route.slice("invite?".length)}`;
  const [head, ...rest] = route.split("/");
  if (head in TOKEN_ROUTES && rest.length) return `/${head}#${rest.join("/")}`;
  return `/${route}`;
}

export function currentRoute(): string {
  return routeFromLocation(window.location.pathname, window.location.hash);
}

export function navigate(route: string, replace = false): void {
  const url = routeUrl(route);
  if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history[replace ? "replaceState" : "pushState"](null, "", url);
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

export function canonicalizeLegacyHash(): void {
  const { pathname, hash } = window.location;
  if (trimSlashes(pathname) || hash.length < 2) return;
  window.history.replaceState(null, "", routeUrl(hash.slice(1)));
}

export function publicSourceLocation(route: string): { path: string; kind: "file" | "directory" } | null {
  if (route === "source/gitflare") return { path: "", kind: "directory" };
  const match = /^source\/gitflare\/(tree|blob)\/(.+)$/.exec(route);
  if (!match || match[2].split("/").some(segment => !segment || segment === "." || segment === ".." || /[\\\u0000-\u001f]/.test(segment))) return null;
  return { path: match[2], kind: match[1] === "blob" ? "file" : "directory" };
}

const PUBLIC_REPOSITORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SINGLE_PUBLIC_VIEWS = ["commits", "branches", "releases"] as const;

export type PublicRepositoryLocation = { handle: string; repository: string; view: PublicRepositoryView; path: string };

function unsafeSegment(segment: string): boolean {
  return !segment || segment === "." || segment === ".." || /[\\\u0000-\u001f]/.test(segment);
}

export function publicRepositoryLocation(route: string): PublicRepositoryLocation | null {
  const [handle, repository, view, ...rest] = route.split("/");
  if (!handle || !repository || !HANDLE_PATTERN.test(handle)) return null;
  if (RESERVED_HANDLES.has(handle) && !(OPERATOR_HANDLES as readonly string[]).includes(handle)) return null;
  if (!PUBLIC_REPOSITORY_NAME.test(repository) || /\.git$/i.test(repository)) return null;
  if (view === undefined) return { handle, repository, view: "code", path: "" };
  if ((SINGLE_PUBLIC_VIEWS as readonly string[]).includes(view)) return rest.length ? null : { handle, repository, view: view as PublicRepositoryView, path: "" };
  if (view === "issues") {
    if (!rest.length) return { handle, repository, view, path: "" };
    return rest.length === 1 && PUBLIC_ISSUE_PATH.test(rest[0]!) ? { handle, repository, view, path: rest[0]! } : null;
  }
  if (view !== "tree" && view !== "blob") return null;
  if (!rest.length) return view === "tree" ? { handle, repository, view: "code", path: "" } : null;
  if (rest.some(unsafeSegment)) return null;
  return { handle, repository, view, path: rest.join("/") };
}

export function publicProfileLocation(route: string): { handle: string } | null {
  if (!HANDLE_PATTERN.test(route)) return null;
  if (RESERVED_HANDLES.has(route) && !(OPERATOR_HANDLES as readonly string[]).includes(route)) return null;
  return { handle: route };
}

export function isPublicDiscoveryRoute(route: string): boolean {
  return route === "explore" || route === "search" || !!publicProfileLocation(route);
}

export function publicSearchRoute(query: string): string {
  return `search?${new URLSearchParams({ q: query })}`;
}

export function followsSavedTheme(route: string): boolean {
  return !!publicRepositoryLocation(route) || isPublicDiscoveryRoute(route);
}

export function publicSourceUrl(path = "", kind: "file" | "directory" = "file"): string {
  return path ? `/source/gitflare/${kind === "file" ? "blob" : "tree"}/${path.split("/").map(encodeURIComponent).join("/")}` : "/source/gitflare";
}

export function isAppPath(pathname: string): boolean {
  const route = routeFromLocation(pathname, "");
  return !!publicSourceLocation(route) || !!publicRepositoryLocation(route) || !SERVER_PATH.test(pathname);
}

export function onRouteChange(listener: () => void): () => void {
  const legacy = () => {
    canonicalizeLegacyHash();
    listener();
  };
  const click = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin || !isAppPath(url.pathname)) return;
    const samePage = url.pathname === window.location.pathname && url.search === window.location.search;
    if (samePage && url.hash && !(trimSlashes(url.pathname) in TOKEN_ROUTES)) return;
    event.preventDefault();
    const target = `${url.pathname}${url.search}${url.hash}`;
    if (target !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.pushState(null, "", target);
    window.scrollTo(0, 0);
    listener();
  };
  window.addEventListener("popstate", listener);
  window.addEventListener(ROUTE_EVENT, listener);
  window.addEventListener("hashchange", legacy);
  document.addEventListener("click", click);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(ROUTE_EVENT, listener);
    window.removeEventListener("hashchange", legacy);
    document.removeEventListener("click", click);
  };
}

export const PUBLIC_DOC_IDS = ["overview", "install", "admin", "cloudflare-permissions", "repositories", "github-mirror", "mcp", "agents"];
export const POLICY_ROUTES = ["terms", "privacy", "acceptable-use", "cookies", "security", "support"];
export const PUBLIC_PRODUCT_ROUTES = ["product", "ai-clients", "open-source", "repositories", "connectors", "connect", "demo"];
export const SIGNED_IN_PRODUCT_ROUTES = ["repositories", "connect"];
const USE_CASE_ROUTE = /^use-cases(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

export function isPublicProductRoute(route: string): boolean {
  return PUBLIC_PRODUCT_ROUTES.includes(route) || USE_CASE_ROUTE.test(route);
}

export function isPublicDocumentationRoute(route: string): boolean {
  return route === "docs" || PUBLIC_DOC_IDS.some(id => route === `docs/${id}`);
}

export function isKnownAppRoute(route: string): boolean {
  return !!publicSourceLocation(route) || ["home", "signin", "signup", "source/gitflare", "deploy", "overview", "missions", "activity", "admin", "inbox", "account/profile", "account/security", "account/sessions", "account/clients", "account/notifications", "proposals/new", ...POLICY_ROUTES].includes(route) || isPublicProductRoute(route)
    || /^settings(?:\/(?:people|cloudflare|models|audit))?$/.test(route)
    || /^docs(?:\/[^/]+)?$/.test(route)
    || /^mission\/[^/]+(?:\/(?:overview|changes|checks|discussion|activity|attempts)|\/agents(?:\/[^/]+)?)?$/.test(route)
    || /^repository\/[^/]+(?:\/(?:code|overview|agents|checks|skills|import)|\/settings(?:\/(?:branches|deploys|previews|agents|secrets|cloudflare|access))?|\/(?:pulls|proposals)(?:\/new)?|\/(?:issues|releases)(?:\/[^/]+)?)?$/.test(route)
    || /^(?:forgot-password|reset-password|verify-email)(?:\/[^/]+)?$/.test(route)
    || route === "invite" || route.startsWith("invite?");
}

export const WORKSPACE_SETTINGS_PAGES = [
  { route: "settings", label: "General" },
  { route: "settings/people", label: "People" },
  { route: "settings/cloudflare", label: "Cloudflare" },
  { route: "settings/models", label: "AI models", ai: true },
  { route: "settings/audit", label: "Audit log" },
] as const;

export const REPOSITORY_SETTINGS_PAGES = [
  { path: "", label: "General" },
  { path: "branches", label: "Streams" },
  { path: "deploys", label: "Deploys" },
  { path: "previews", label: "Previews" },
  { path: "agents", label: "Agents" },
  { path: "issues", label: "Issues" },
  { path: "secrets", label: "Secrets" },
  { path: "cloudflare", label: "Resources" },
  { path: "access", label: "Access" },
] as const;

export function keepsRouteAcrossWorkspaces(route: string): boolean {
  return /^(?:settings(?:\/|$)|account\/|docs(?:\/|$)|admin$)/.test(route) || ["overview", "repositories", "missions", "activity", "inbox"].includes(route);
}

export function isSiteRoute(route: string): boolean {
  return ["home", "deploy", ...POLICY_ROUTES].includes(route) || isPublicProductRoute(route) || !!publicSourceLocation(route) || /^docs(?:\/|$)/.test(route) || !isKnownAppRoute(route);
}
