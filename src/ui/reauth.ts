import { request, RequestError } from "./api";

const RETURN_ROUTE_KEY = "gitflare:return-route";

export function needsRecentSignIn(failure: unknown): boolean {
  return failure instanceof RequestError && failure.code === "RECENT_AUTH_REQUIRED";
}

export async function signInAgain(returnRoute = window.location.pathname.replace(/^\/+/, "")) {
  try { sessionStorage.setItem(RETURN_ROUTE_KEY, returnRoute || "overview"); } catch {}
  await request("/api/session/logout", {}).catch(() => {});
  window.location.assign("/signin");
}
