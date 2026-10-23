export type DeployStatus = "awaiting_confirmation" | "queued" | "building" | "deploying" | "rolling_out" | "succeeded" | "uploaded" | "failed" | "superseded" | "skipped";
export type DeployTrigger = "land" | "manual" | "rollback" | "promote";

export interface DeploymentSummary {
  id: string;
  workerName: string;
  environment: string;
  mode?: "deploy" | "upload-only";
  commitSha: string | null;
  trigger: DeployTrigger;
  status: DeployStatus;
  createdAt: string;
  error?: string;
  targets?: { workerName: string; urls?: string[] }[];
}

export const ACTIVE_STATUSES: DeployStatus[] = ["queued", "building", "deploying", "rolling_out"];
export const isActive = (deployment: Pick<DeploymentSummary, "status">) => ACTIVE_STATUSES.includes(deployment.status);
export const environmentLabel = (environment: string) => { const words = environment.replace(/[-_]+/g, " ").trim(); return words ? words[0].toUpperCase() + words.slice(1) : environment; };
export const shortSha = (sha: string | null | undefined) => sha ? sha.slice(0, 7) : "";

const DEPLOY_STAGES = ["Queued", "Build", "Deploy", "Rollout", "Live"];
const UPLOAD_STAGES = ["Queued", "Build", "Upload", "Uploaded"];
const STAGE_INDEX: Partial<Record<DeployStatus, number>> = { queued: 0, building: 1, deploying: 2, rolling_out: 3, succeeded: 4, uploaded: 3 };

export function deployStages(deployment: Pick<DeploymentSummary, "mode" | "status">): { stages: string[]; stage: number | undefined } {
  return { stages: deployment.mode === "upload-only" ? UPLOAD_STAGES : DEPLOY_STAGES, stage: STAGE_INDEX[deployment.status] };
}

export function currentStep(deployment: Pick<DeploymentSummary, "mode" | "status">): string {
  if (deployment.status === "failed") return "Failed";
  const { stages, stage } = deployStages(deployment);
  return stage === undefined ? "Waiting" : stages[stage];
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

export const liveUrl = (deployment: DeploymentSummary) => deployment.targets?.flatMap((target) => target.urls ?? [])[0];

export type ProgressPhase = "active" | "succeeded" | "failed";
export interface ProgressItem { deployment: DeploymentSummary; phase: ProgressPhase }

export function progressItems(deployments: DeploymentSummary[], watched: ReadonlySet<string>, dismissed: ReadonlySet<string>): ProgressItem[] {
  return deployments.flatMap((deployment): ProgressItem[] => {
    if (isActive(deployment)) return [{ deployment, phase: "active" }];
    if (!watched.has(deployment.id) || dismissed.has(deployment.id)) return [];
    if (deployment.status === "succeeded" || deployment.status === "uploaded") return [{ deployment, phase: "succeeded" }];
    if (deployment.status === "failed") return [{ deployment, phase: "failed" }];
    return [];
  });
}

export interface ConfirmFact { label: string; value: string; title?: string; code?: boolean }
export interface ConfirmPrompt { title: string; description: string; facts?: ConfirmFact[]; confirmLabel: string; tone?: "primary" | "danger" }

export function productionPrompt(input: { action: "deploy" | "promote" | "rollback" | "confirm"; commitSha?: string | null; commitMessage?: string; workers: string[]; account?: string | null; from?: string }): ConfirmPrompt {
  const facts: ConfirmFact[] = [];
  if (input.commitSha) facts.push({ label: "Commit", value: `${shortSha(input.commitSha)}${input.commitMessage ? ` ${input.commitMessage.split("\n")[0]}` : ""}`, title: input.commitSha });
  if (input.from) facts.push({ label: "From", value: environmentLabel(input.from) });
  if (input.workers.length) facts.push({ label: input.workers.length === 1 ? "Worker" : "Workers", value: input.workers.join(", "), code: true });
  facts.push({ label: "Cloudflare account", value: input.account || "The repository's deploy account" });
  if (input.action === "rollback") return { title: "Roll back production?", description: "Production traffic moves back to the previous deployment as soon as you confirm. Visitors see the older version.", facts, confirmLabel: "Roll back production", tone: "danger" };
  const title = input.action === "promote" ? "Promote to production?" : "Deploy to production?";
  return { title, description: "These Workers are built and rolled out, and live traffic moves to the new version. Anyone using production sees the change.", facts, confirmLabel: input.action === "promote" ? "Promote to production" : "Deploy to production", tone: "primary" };
}

type Snapshot = { deployments: DeploymentSummary[]; at: number };
const snapshots = new Map<string, Snapshot>();
const watchedIds = new Map<string, Set<string>>();
const dismissedIds = new Set<string>();
const listeners = new Set<() => void>();

export function publishDeployments(repositoryId: string, deployments: DeploymentSummary[]) {
  snapshots.set(repositoryId, { deployments, at: Date.now() });
  const watched = watchedIds.get(repositoryId) ?? new Set<string>();
  for (const deployment of deployments) if (isActive(deployment)) watched.add(deployment.id);
  watchedIds.set(repositoryId, watched);
  for (const listener of listeners) listener();
}

export const deploySnapshot = (repositoryId: string) => snapshots.get(repositoryId);
export const watchedDeployments = (repositoryId: string): ReadonlySet<string> => watchedIds.get(repositoryId) ?? new Set();
export const dismissedDeployments = (): ReadonlySet<string> => dismissedIds;

export function dismissDeployment(id: string) {
  dismissedIds.add(id);
  for (const listener of listeners) listener();
}

export function subscribeDeployments(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
