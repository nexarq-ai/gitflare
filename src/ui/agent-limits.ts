import type { AgentLimits, AgentOverrides, AgentRetryOverride, AgentRun, MissionStatus } from "../shared/types";

const RUN_SECONDS_MAX = 1800;
const MODEL_ANSWER_SECONDS_MAX = 600;
const EDIT_SCOPE_MAX_ENTRIES = 20;
const DEFAULT_LIMITS: AgentLimits = { modelAnswerSeconds: null, modelRetries: 2, maxSteps: 32, runSeconds: 600, autoRetry: true };

export interface LimitFields { editScope: string; runTime: string; maxSteps: string }
export const emptyLimitFields = (): LimitFields => ({ editScope: "", runTime: "", maxSteps: "" });

export function parseEditScope(text: string): string[] {
  return [...new Set(text.split(/[,\n]/).map(entry => entry.trim()).filter(Boolean))];
}

export function parseDuration(text: string): number | null | undefined {
  const value = text.trim().toLowerCase();
  if (!value) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?)?$/.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  const seconds = match[2]?.startsWith("s") ? amount : amount * 60;
  return Number.isInteger(seconds) ? seconds : Math.round(seconds);
}

export function formatDuration(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

export function durationField(seconds: number): string {
  return seconds % 60 === 0 ? String(seconds / 60) : `${seconds}s`;
}

export function limitFieldsProblem(fields: LimitFields): { field: keyof LimitFields; message: string } | null {
  const scope = parseEditScope(fields.editScope);
  if (scope.length > EDIT_SCOPE_MAX_ENTRIES) return { field: "editScope", message: `List at most ${EDIT_SCOPE_MAX_ENTRIES} files or patterns an agent may edit.` };
  if (scope.some(entry => entry.startsWith("/") || entry.split("/").includes(".."))) return { field: "editScope", message: "Use repository-relative paths, such as public/render3d.mjs or public/pose*.mjs." };
  const runSeconds = parseDuration(fields.runTime);
  if (runSeconds === null || (runSeconds !== undefined && (runSeconds < 120 || runSeconds > RUN_SECONDS_MAX))) return { field: "runTime", message: "Set the agent time limit between 2 and 30 minutes, for example 15 or 900s." };
  if (fields.maxSteps.trim()) {
    const steps = Number(fields.maxSteps);
    if (!Number.isInteger(steps) || steps < 1 || steps > 32) return { field: "maxSteps", message: "Set max steps between 1 and 32." };
  }
  return null;
}

export function limitOverrides(fields: LimitFields): (AgentOverrides & { editScope?: string[] }) | undefined {
  const editScope = parseEditScope(fields.editScope);
  const runSeconds = parseDuration(fields.runTime);
  const result = {
    ...(editScope.length ? { editScope } : {}),
    ...(typeof runSeconds === "number" ? { runSeconds } : {}),
    ...(fields.maxSteps.trim() ? { maxSteps: Number(fields.maxSteps) } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

export function taskLimits(fields: LimitFields | undefined): { editScope?: string[]; overrides?: AgentOverrides } {
  const { editScope, ...overrides } = (fields && limitOverrides(fields)) ?? {};
  return { ...(editScope ? { editScope } : {}), ...(Object.keys(overrides).length ? { overrides } : {}) };
}

export function describeLimits(limits: AgentLimits): string {
  const answer = limits.modelAnswerSeconds === null ? "automatic" : `${limits.modelAnswerSeconds} s`;
  return `${formatDuration(limits.runSeconds)}, ${limits.maxSteps} ${limits.maxSteps === 1 ? "step" : "steps"}, model answer ${answer}, ${limits.modelRetries} ${limits.modelRetries === 1 ? "retry" : "retries"}`;
}

export function moreTimeOverride(run: Pick<AgentRun, "limits">): AgentRetryOverride {
  return {
    runSeconds: Math.min(RUN_SECONDS_MAX, 2 * (run.limits?.runSeconds ?? DEFAULT_LIMITS.runSeconds)),
    modelAnswerSeconds: Math.min(MODEL_ANSWER_SECONDS_MAX, 2 * (run.limits?.modelAnswerSeconds ?? 300)),
  };
}

export function retryAgentBody(runId: string, override?: AgentRetryOverride): { runIds: string[]; overrides?: Record<string, AgentRetryOverride> } {
  return { runIds: [runId], ...(override && Object.keys(override).length ? { overrides: { [runId]: override } } : {}) };
}

export const RETRY_WAIT_TITLE = "Wait for this attempt to finish. Agents can be retried once the attempt has failed or been cancelled.";
export const RETRY_PERMISSION_TITLE = "You need permission to run agents in this repository to retry them.";

export function agentRetryBlocked(status: MissionStatus, canExecute: boolean): string | null {
  if (!canExecute) return RETRY_PERMISSION_TITLE;
  if (status !== "failed" && status !== "cancelled") return RETRY_WAIT_TITLE;
  return null;
}
