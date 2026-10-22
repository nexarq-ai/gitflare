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
