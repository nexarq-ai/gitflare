import { RequestError } from "./api";

export const PAGE_DATA_ID = "gitflare-page-data";
export const ROUTE_EVENT = "gitflare:route";
const DATE_LOCALE = "en-US";

export interface PageRequest { origin: string; pathname: string; search: string; hash: string; cookie: string }
export interface SeedEntry { status: number; data?: unknown; error?: { code?: string; message?: string } }
export type PageSeed = Record<string, SeedEntry>;
export interface ServerPageContext { request: PageRequest; siteOrigin?: string; appOrigin?: string; seed: PageSeed }

let server: ServerPageContext | null = null;
let clientSeed: PageSeed | null = null;

export function renderOnServer<T>(context: ServerPageContext, render: () => T): T {
  const previous = server;
  server = context;
  try { return render(); } finally { server = previous; }
}

export function serverPageContext(): ServerPageContext | null {
  return server;
}

export function pageLocation(): Pick<PageRequest, "origin" | "pathname" | "search" | "hash"> {
  if (server) return server.request;
  return typeof window === "undefined" ? { origin: "", pathname: "/", search: "", hash: "" } : window.location;
}

export function pageCookie(): string {
  if (server) return server.request.cookie;
  return typeof document === "undefined" ? "" : document.cookie;
}

function dropPageSeed(): void {
  clientSeed = {};
}

function clientStore(): PageSeed {
  if (clientSeed) return clientSeed;
  const element = typeof document === "undefined" ? null : document.getElementById(PAGE_DATA_ID);
  try { clientSeed = element?.textContent ? JSON.parse(element.textContent) as PageSeed : {}; } catch { clientSeed = {}; }
  if (typeof window !== "undefined" && Object.keys(clientSeed).length) {
    window.addEventListener(ROUTE_EVENT, dropPageSeed, { once: true });
    window.addEventListener("popstate", dropPageSeed, { once: true });
  }
  return clientSeed;
}

export type Seeded<T> = { data: T; error?: undefined } | { data?: undefined; error: RequestError };

export function seeded<T>(url: string | null): Seeded<T> | undefined {
  if (!url) return undefined;
  const entry = (server?.seed ?? clientStore())[url];
  if (!entry) return undefined;
  if (entry.status === 200) return { data: entry.data as T };
  return { error: new RequestError(entry.error?.message || "This could not be loaded. Try again.", entry.status, entry.error?.code) };
}

export function formatDate(value: string | number | Date, options: Intl.DateTimeFormatOptions = { dateStyle: "medium" }): string {
  return new Intl.DateTimeFormat(DATE_LOCALE, { timeZone: "UTC", ...options }).format(new Date(value));
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(DATE_LOCALE, options).format(value);
}
