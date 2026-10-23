import { exploreParams, exploreStateFrom, type ExploreState } from "../shared/explore";
import { publicProfileLocation, publicRepositoryLocation, routeFromLocation, type PublicRepositoryLocation } from "./router";

export interface PublicRepositoryRequests {
  summary: string;
  tree: string | null;
  file: string | null;
  readme: string | null;
  history: string | null;
  branches: string | null;
  releases: string | null;
  activity: string | null;
}

export function apiQuery(values: Record<string, string>): string {
  const params = new URLSearchParams(Object.entries(values).filter(([, value]) => value)).toString();
  return params ? `?${params}` : "";
}

export function publicRepositoryRequests(location: PublicRepositoryLocation, ref: string): PublicRepositoryRequests {
  const base = `/api/public/repos/${encodeURIComponent(location.handle)}/${encodeURIComponent(location.repository)}`;
  const { view, path } = location;
  return {
    summary: base,
    tree: view === "code" || view === "tree" ? `${base}/tree${apiQuery({ ref, path })}` : null,
    file: view === "blob" ? `${base}/file${apiQuery({ ref, path })}` : null,
    readme: view === "code" ? `${base}/readme${apiQuery({ ref })}` : null,
    history: view === "commits" ? `${base}/history${apiQuery({ ref, limit: "50" })}` : null,
    branches: view === "branches" ? `${base}/branches` : null,
    releases: view === "releases" ? `${base}/releases` : null,
    activity: view === "code" && !path && !ref ? `${base}/activity` : null,
  };
}

export function publicProfileRequests(handle: string): { profile: string; activity: string } {
  const profile = `/api/public/profiles/${encodeURIComponent(handle)}`;
  return { profile, activity: `${profile}/activity` };
}

export function exploreRequest(state: ExploreState, cursor: number | null = null): string {
  return `/api/public/explore?${exploreParams(state, { cursor: cursor ?? undefined })}`;
}

export function publicPageRequests(pathname: string, search: string): string[] {
  const route = routeFromLocation(pathname, "");
  if (route === "explore") return [exploreRequest(exploreStateFrom(new URLSearchParams(search)))];
  const repository = publicRepositoryLocation(route);
  if (repository) return Object.values(publicRepositoryRequests(repository, new URLSearchParams(search).get("ref") ?? "")).filter((url): url is string => !!url);
  const profile = publicProfileLocation(route);
  return profile ? Object.values(publicProfileRequests(profile.handle)) : [];
}

export function issueListRequest(api: string, state: "open" | "closed" = "open", offset = 0, label = "", query = ""): string {
  const params = new URLSearchParams({ state, offset: String(offset) });
  if (label) params.set("label", label);
  if (query) params.set("q", query);
  return `${api}/issues?${params}`;
}

export function fixRequestsRequest(api: string, query: string): string {
  return `${api}/fix-requests?${query}`;
}

function repositoryViewRequests(location: PublicRepositoryLocation, base: string): string[] {
  const { view, path } = location;
  if (view === "issues") {
    const shared = [`${base}/issue-viewer`, `${base}/issue-labels`];
    if (!path) return [...shared, issueListRequest(base)];
    if (path === "new") return shared;
    return [...shared, `${base}/issues/${path}`, fixRequestsRequest(base, `issue=${path}&quote=1`)];
  }
  if (view === "agents") return [fixRequestsRequest(base, "")];
  if (view === "security") return path && path !== "new" ? [] : [`${base}/security`];
  return [];
}

export function publicSeedRequests(pathname: string, search: string): string[] {
  const repository = publicRepositoryLocation(routeFromLocation(pathname, ""));
  const pages = publicPageRequests(pathname, search);
  return repository ? [...pages, ...repositoryViewRequests(repository, pages[0]!)] : pages;
}
