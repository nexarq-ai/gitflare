import type { ProjectResource } from "./types";

export interface GitflareDeployment { worker: string; previews?: string; relay?: string; container: string; workflow: string }

// Mirrors the environments in wrangler.jsonc and wrangler.preview.jsonc
export const GITFLARE_DEPLOYMENTS: GitflareDeployment[] = [
  { worker: "gitflare-staging", previews: "gitflare-staging-previews", relay: "gitflare-preview-staging", container: "gitflare-staging-runner", workflow: "gitflare-staging-missions" },
  { worker: "gitflare", previews: "gitflare-previews", relay: "gitflare-preview", container: "gitflare-runner", workflow: "gitflare-missions" },
  { worker: "gitflare-demo", container: "gitflare-demo-runner", workflow: "gitflare-demo-missions" },
];

export interface GitflareInfrastructure { workers: Set<string>; containers: Set<string>; workflows: Set<string> }

export function gitflareInfrastructure(primaryWorker?: string, previewsWorker?: string): GitflareInfrastructure {
  const deployments = [...GITFLARE_DEPLOYMENTS];
  if (primaryWorker && !deployments.some((item) => item.worker === primaryWorker)) deployments.push({ worker: primaryWorker, previews: previewsWorker ?? `${primaryWorker}-previews`, relay: `${primaryWorker}-preview`, container: `${primaryWorker}-runner`, workflow: `${primaryWorker}-missions` });
  const workers = new Set(deployments.flatMap((item) => [item.worker, item.previews, item.relay].filter((name): name is string => !!name)));
  if (previewsWorker) workers.add(previewsWorker);
  return { workers, containers: new Set(deployments.map((item) => item.container)), workflows: new Set(deployments.map((item) => item.workflow)) };
}

export type CatalogItem = Pick<ProjectResource, "type" | "id" | "name"> & { script?: string };

export function isGitflareResource(item: CatalogItem, infrastructure: GitflareInfrastructure): boolean {
  if (item.type === "worker") return infrastructure.workers.has(item.id) || infrastructure.workers.has(item.name);
  if (item.type === "durable_object") return !!item.script && infrastructure.workers.has(item.script);
  if (item.type === "container") return infrastructure.containers.has(item.name);
  if (item.type === "workflow") return infrastructure.workflows.has(item.id) || infrastructure.workflows.has(item.name);
  return false;
}
