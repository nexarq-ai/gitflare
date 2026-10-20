import type { AccountSnapshot } from "../shared/types";

export type AccountSection = "profile" | "security" | "sessions" | "clients" | "notifications";
type Session = AccountSnapshot["sessions"][number];

export const accountSections: { id: AccountSection; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "security", label: "Security" },
  { id: "sessions", label: "Sessions" },
  { id: "notifications", label: "Notifications" },
  { id: "clients", label: "AI clients" },
];

export function accountSection(route: string): AccountSection {
  const section = route.split("/")[1];
  return accountSections.some(item => item.id === section) ? section as AccountSection : "profile";
}

export function browserSessions(data: AccountSnapshot): Session[] {
  const list = data.sessions.filter(session => !session.client && session.kind !== "token");
  return [...list].sort((a, b) => (a.id === data.currentSessionId ? -1 : b.id === data.currentSessionId ? 1 : (b.authenticatedAt ?? 0) - (a.authenticatedAt ?? 0)));
}
export function clientSessions(data: AccountSnapshot): Session[] { return data.sessions.filter(session => !!session.client); }
export function tokenSessions(data: AccountSnapshot): Session[] { return data.sessions.filter(session => session.kind === "token"); }

export function relativeTime(at: number, now = Date.now()): string {
  const minutes = Math.round((now - at) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export function countryName(code: string | undefined): string | undefined {
  if (!code) return undefined;
  try { return new Intl.DisplayNames(undefined, { type: "region" }).of(code) ?? code; } catch { return code; }
}

const METHOD_LABELS: Record<string, string> = { cloudflare: "Cloudflare", password: "Email", authenticator: "Email + authenticator", "owner-token": "Owner token" };

export function signInMethodLabel(method: string | undefined): string | undefined {
  return method ? METHOD_LABELS[method] : undefined;
}

export function describeSession(session: Session, now = Date.now(), fallbackMethod?: string) {
  const activeAt = session.lastActiveAt ?? session.authenticatedAt;
  return {
    title: session.device ?? "Browser",
    method: signInMethodLabel(session.method ?? fallbackMethod),
    location: countryName(session.country),
    workspace: "workspaceName" in session ? session.workspaceName : undefined,
    signedIn: session.authenticatedAt ? `Signed in ${relativeTime(session.authenticatedAt, now)}` : `Expires ${new Date(session.expiresAt).toLocaleDateString()}`,
    lastActive: activeAt ? `Active ${relativeTime(activeAt, now)}` : undefined,
  };
}
