export type SessionStatus = "signed-in" | "signed-out" | "unreachable";

export const SESSION_CHECK_EVENT = "gitflare:session-check";
const SESSION_TIMEOUT_MS = 15_000;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;
export const INITIAL_LOAD_ATTEMPTS = 6;

export function transientFailure(failure: unknown): boolean {
  const status = (failure as { status?: unknown } | null)?.status;
  if (typeof status !== "number") return failure instanceof TypeError;
  return status === 0 || status === 401 || status === 408 || status === 425 || status === 429 || status >= 500;
}

export function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt));
}

export async function sessionStatus(fetcher: typeof fetch = fetch): Promise<SessionStatus> {
  try {
    const response = await fetcher("/api/session", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(SESSION_TIMEOUT_MS) });
    if (response.ok) return "signed-in";
    if (response.status !== 401) return "unreachable";
    const body = (await response.json().catch(() => null)) as { error?: { code?: unknown } } | null;
    return body?.error?.code === "AUTH_REQUIRED" ? "signed-out" : "unreachable";
  } catch {
    return "unreachable";
  }
}

let pending: Promise<SessionStatus> | null = null;
export function confirmSession(fetcher?: typeof fetch): Promise<SessionStatus> {
  pending ??= sessionStatus(fetcher).finally(() => { pending = null; });
  return pending;
}
