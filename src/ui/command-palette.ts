import { repositoryLabel } from "../shared/repository-names";
import type { Workspace } from "../shared/types";
import { PUBLIC_DOC_IDS, publicSearchRoute } from "./router";

export type PaletteSection = "pages" | "actions" | "repositories" | "proposals" | "docs";
export type PaletteAction = "new-mission" | "new-repository" | "invite" | "toggle-theme" | "copy-mcp-url" | "sign-out";
export type PaletteIcon = "home" | "page" | "inbox" | "repository" | "proposal" | "activity" | "explore" | "settings" | "account" | "security" | "ai" | "notifications" | "people" | "cloud" | "audit" | "admin" | "docs" | "plus" | "import" | "theme" | "switch" | "copy" | "signout" | "search" | "deploy" | "branch" | "checks" | "secret";

export type PaletteEntry = {
  id: string;
  section: PaletteSection;
  title: string;
  detail?: string;
  keywords?: readonly string[];
  icon: PaletteIcon;
  route?: string;
  action?: PaletteAction;
  workspaceId?: string;
};

export type PaletteContext = {
  edition: "hosted" | "self-hosted";
  permissions: readonly string[];
  role: string;
  aiEnabled: boolean;
  personalAccount: boolean;
  installationAdmin: boolean;
  connected: boolean;
  demo: boolean;
  theme: "light" | "dark";
  repository?: { id: string; name: string };
  workspaces?: readonly { id: string; name: string; role?: string | null }[];
  currentWorkspaceId?: string;
  canSwitchWorkspace?: boolean;
};

export const SECTION_ORDER: readonly PaletteSection[] = ["pages", "actions", "repositories", "proposals", "docs"];
export const SECTION_LABELS: Record<PaletteSection, string> = { pages: "Pages & settings", actions: "Actions", repositories: "Repositories", proposals: "Proposals", docs: "Docs" };

const AI_CLIENT_WORDS = ["mcp", "connector", "connectors", "claude", "chatgpt", "codex", "cursor", "token", "tokens", "oauth", "integration", "model context protocol"];

export const PUBLIC_DOCS: readonly { id: string; title: string; keywords: readonly string[] }[] = [
  { id: "overview", title: "How Gitflare works", keywords: ["introduction", "getting started", "missions", "review", "landing", "editions"] },
  { id: "install", title: "Install on Cloudflare", keywords: ["self-hosted", "setup", "deploy", "wrangler"] },
  { id: "admin", title: "Workspace administration", keywords: ["users", "roles", "mfa", "invite", "members", "team"] },
  { id: "cloudflare-permissions", title: "Cloudflare permissions", keywords: ["oauth", "scopes", "token", "api key"] },
  { id: "repositories", title: "Repositories and changes", keywords: ["proposals", "checks", "review", "land", "pull requests"] },
  { id: "github-mirror", title: "Mirror to GitHub", keywords: ["github", "sync", "push"] },
  { id: "mcp", title: "Connect through MCP", keywords: AI_CLIENT_WORDS },
  { id: "agents", title: "AI client and agent guide", keywords: ["agents", "claude", "chatgpt", "codex", "cursor", "rules"] },
];

const REPOSITORY_PAGES: readonly { path: string; title: string; keywords: readonly string[]; icon: PaletteIcon; ai?: boolean; hosted?: boolean }[] = [
  { path: "settings", title: "General", keywords: ["details", "clone", "visibility", "public", "private", "rename"], icon: "settings" },
  { path: "settings", title: "GitHub mirror", keywords: ["github", "mirror", "sync", "push", "import issues"], icon: "repository" },
  { path: "settings/branches", title: "Branch rules", keywords: ["streams", "branches", "protection", "required approvals", "codeowners", "required checks"], icon: "branch" },
  { path: "checks", title: "Checks", keywords: ["ci", "tests", "status", "builds"], icon: "checks" },
  { path: "settings/deploys", title: "Deploys", keywords: ["deploy", "deployments", "deployment", "production", "environments", "release", "wrangler"], icon: "deploy" },
  { path: "settings/previews", title: "Previews", keywords: ["preview", "staging", "worker previews"], icon: "deploy" },
  { path: "settings/agents", title: "Agents", keywords: ["ai", "agent", "limits", "models", "sandbox"], icon: "ai" },
  { path: "settings/issues", title: "Issues", keywords: ["labels", "templates", "triage", "bugs"], icon: "page" },
  { path: "settings/community", title: "Community AI", keywords: ["fix requests", "pool", "funding", "sponsor"], icon: "people", hosted: true },
  { path: "settings/secrets", title: "Secrets", keywords: ["env", "environment variables", "secrets store", "keys", "api key"], icon: "secret" },
  { path: "settings/cloudflare", title: "Resources", keywords: ["cloudflare", "bindings", "d1", "workers", "durable objects"], icon: "cloud" },
  { path: "settings/access", title: "Access", keywords: ["permissions", "members", "collaborators", "invite"], icon: "people" },
];

export function staticEntries(context: PaletteContext): PaletteEntry[] {
  const hosted = context.edition === "hosted";
  const can = (permission: string) => context.permissions.includes(permission);
  const page = (route: string, title: string, icon: PaletteIcon, keywords: readonly string[], detail?: string): PaletteEntry => ({ id: `page:${route}:${title}`, section: "pages", title, detail, keywords, icon, route });
  const pages: (PaletteEntry | false)[] = [
    page("overview", "Overview", "home", ["home", "dashboard", "start"]),
    context.personalAccount && page("inbox", "Inbox", "inbox", ["notifications", "unread", "todo", "work queue", "mentions"]),
    page("repositories", "Repositories", "repository", ["repos", "projects", "code", "workspace"], "Your workspace"),
    page("missions", "Proposals", "proposal", ["missions", "pull requests", "prs", "changes", "merge requests"]),
    page("activity", "Activity", "activity", ["history", "events", "timeline", "log"]),
    hosted && page("explore", "Explore", "explore", ["public", "discover", "open source", "browse", "stars", "repositories"], "Public repositories"),
    page("docs", "Documentation", "docs", ["help", "guides", "manual"]),
    page("account/profile", "Profile", "account", ["name", "avatar", "handle", "email", "username"], "Account"),
    page("account/security", "Security", "security", ["password", "mfa", "2fa", "two factor", "passkey", "authenticator"], "Account"),
    page("account/sessions", "Sessions", "security", ["devices", "signed in", "browsers", "revoke"], "Account"),
    context.aiEnabled && page("account/clients", "AI clients", "ai", AI_CLIENT_WORDS, "Account"),
    page("account/notifications", "Notifications", "notifications", ["email", "alerts", "subscriptions", "digest", "unsubscribe"], "Account"),
    page("settings", "General", "settings", ["workspace", "rename", "ai features", "leave", "delete"], "Workspace settings"),
    page("settings/people", "People", "people", ["invite", "members", "team", "users", "roles", "collaborators"], "Workspace settings"),
    page("settings/cloudflare", "Cloudflare", "cloud", ["account", "connect", "deploy", "previews", "workers", "api token"], "Workspace settings"),
    context.aiEnabled && page("settings/models", "AI models", "ai", ["api key", "model", "models", "gateway", "ai gateway", "openai", "anthropic", "provider", "byok", "llm", "workers ai"], "Workspace settings"),
    page("settings/audit", "Audit log", "audit", ["history", "events", "compliance", "log"], "Workspace settings"),
    context.installationAdmin && page("admin", "Installation admin", "admin", ["admin", "operator", "installation", "platform"]),
    ...(context.repository ? REPOSITORY_PAGES.filter(item => (!item.hosted || (hosted && !context.demo)) && (!item.ai || context.aiEnabled)).map(item => page(`repository/${context.repository!.id}/${item.path}`, item.title, item.icon, item.keywords, `Repository · ${context.repository!.name}`)) : []),
  ];
  const action = (id: PaletteAction, title: string, icon: PaletteIcon, keywords: readonly string[]): PaletteEntry => ({ id: `action:${id}`, section: "actions", title, keywords, icon, action: id });
  const actions: (PaletteEntry | false)[] = [
    context.aiEnabled && can("contribute") && action("new-mission", "New mission", "plus", ["create", "ask ai", "agents", "proposal", "task"]),
    can("contribute") && action("new-repository", "New repository", "plus", ["create", "repo", "project"]),
    hosted && can("manage") && { id: "action:import-github", section: "actions", title: "Import from GitHub", keywords: ["github", "organization", "migrate", "import"], icon: "import", route: "import/github" },
    context.role === "Owner" && !context.demo && action("invite", "Invite people", "people", ["invite", "members", "team", "add user", "collaborators"]),
    action("toggle-theme", context.theme === "dark" ? "Switch to light theme" : "Switch to dark theme", "theme", ["theme", "dark", "light", "mode", "appearance"]),
    ...(context.canSwitchWorkspace ? workspaceSwitchEntries(context.workspaces ?? [], context.currentWorkspaceId ?? "") : []),
    context.aiEnabled && action("copy-mcp-url", "Copy MCP server URL", "copy", AI_CLIENT_WORDS),
    context.connected && action("sign-out", "Sign out", "signout", ["logout", "log out", "sign off", "exit"]),
  ];
  const docs = PUBLIC_DOCS.filter(doc => PUBLIC_DOC_IDS.includes(doc.id)).map((doc): PaletteEntry => ({ id: `doc:${doc.id}`, section: "docs", title: doc.title, keywords: doc.keywords, icon: "docs", route: `docs/${doc.id}` }));
  return [...pages, ...actions, ...docs].filter((entry): entry is PaletteEntry => !!entry);
}

export function workspaceSwitchEntries(workspaces: readonly { id: string; name: string; role?: string | null }[], currentId: string): PaletteEntry[] {
  return workspaces.filter(item => item.id !== currentId).map(item => ({ id: `workspace:${item.id}`, section: "actions", title: `Switch to ${item.name}`, detail: item.role ?? "", keywords: ["workspace", "switch", "change workspace", "organization"], icon: "switch", workspaceId: item.id }));
}

export function workspaceEntries(workspace: Workspace): PaletteEntry[] {
  const names = new Map(workspace.repositories.map(repository => [repository.id, repository.name]));
  return [
    ...workspace.repositories.map((repository): PaletteEntry => ({ id: `repository/${repository.id}`, section: "repositories", title: repositoryLabel(repository), detail: repository.description, icon: "repository", route: `repository/${repository.id}` })),
    ...workspace.missions.map((mission): PaletteEntry => ({ id: `mission/${mission.id}`, section: "proposals", title: mission.title, detail: names.get(mission.repositoryId) ?? "", icon: "proposal", route: `mission/${mission.id}` })),
  ];
}

export function emptySuggestions(query: string, context: Pick<PaletteContext, "edition">): PaletteEntry[] {
  const term = query.trim();
  if (!term) return [];
  return [
    { id: "suggest:docs", section: "docs", title: `Search docs for “${term}”`, icon: "search", route: `docs?${new URLSearchParams({ q: term })}` },
    ...(context.edition === "hosted" ? [{ id: "suggest:explore", section: "repositories" as const, title: `Search public repositories for “${term}”`, icon: "explore" as const, route: publicSearchRoute(term) }] : []),
    { id: "suggest:docs-index", section: "docs", title: "Browse all documentation", icon: "docs", route: "docs" },
  ];
}

function normalize(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

function words(value: string): string[] {
  return normalize(value).split(/[^a-z0-9]+/).filter(Boolean);
}

function tokenScore(token: string, entry: PaletteEntry): number {
  const title = normalize(entry.title);
  if (title === token) return 100;
  if (title.startsWith(token)) return 85;
  let best = words(entry.title).some(word => word.startsWith(token)) ? 65 : title.includes(token) ? 40 : 0;
  for (const keyword of entry.keywords ?? []) {
    const value = normalize(keyword);
    if (value === token) best = Math.max(best, 70);
    else if (value.startsWith(token) || words(keyword).some(word => word.startsWith(token))) best = Math.max(best, 50);
    else if (token.length >= 3 && value.includes(token)) best = Math.max(best, 25);
  }
  if (!best && entry.detail && words(entry.detail).some(word => word.startsWith(token))) best = 15;
  if (!best && token.length >= 3 && entry.detail && normalize(entry.detail).includes(token)) best = 10;
  return best;
}

export function scoreEntry(entry: PaletteEntry, query: string): number {
  const tokens = words(query);
  if (!tokens.length) return 0;
  let total = 0;
  for (const token of tokens) {
    const score = tokenScore(token, entry);
    if (!score) return 0;
    total += score;
  }
  const phrase = normalize(query.trim());
  if (tokens.length > 1 && (entry.keywords ?? []).some(keyword => normalize(keyword) === phrase)) total += 40;
  if (tokens.length > 1 && normalize(entry.title).includes(phrase)) total += 30;
  return total;
}

export type PaletteGroup = { section: PaletteSection; label: string; entries: PaletteEntry[] };

const EMPTY_QUERY_SECTIONS: readonly PaletteSection[] = ["actions", "repositories", "proposals"];

export function searchPalette(entries: readonly PaletteEntry[], query: string, perSection = 6): PaletteGroup[] {
  const searching = words(query).length > 0;
  return SECTION_ORDER.flatMap(section => {
    const candidates = entries.filter(entry => entry.section === section);
    const matches = searching
      ? candidates.map((entry, index) => ({ entry, index, score: scoreEntry(entry, query) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).map(item => item.entry)
      : EMPTY_QUERY_SECTIONS.includes(section) ? candidates : [];
    return matches.length ? [{ section, label: SECTION_LABELS[section], entries: matches.slice(0, perSection) }] : [];
  });
}

export function paletteKey(key: string, selected: number, count: number): { selected: number; choose?: boolean } {
  if (!count) return { selected: 0 };
  if (key === "ArrowDown") return { selected: (selected + 1) % count };
  if (key === "ArrowUp") return { selected: (selected - 1 + count) % count };
  if (key === "Home") return { selected: 0 };
  if (key === "End") return { selected: count - 1 };
  if (key === "Enter") return { selected, choose: true };
  return { selected };
}

export function resultCountLabel(count: number): string {
  return `${count} ${count === 1 ? "result" : "results"}`;
}
