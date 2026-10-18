import type { AiKeysSnapshot, ModelConnection, ModelConnectionsSnapshot } from "../shared/types";

export type ModelStatus = "ready" | "needs-key" | "unverified" | "failed" | "unavailable";

export const STATUS_LABELS: Record<ModelStatus, string> = {
  ready: "Ready",
  "needs-key": "Needs a key",
  unverified: "Not verified",
  failed: "Check failed",
  unavailable: "Unavailable",
};

export function modelProvider(id: string): string { return id.split("/")[0]; }

export function modelStatus(model: ModelConnection, keys: AiKeysSnapshot | null, models: Pick<ModelConnectionsSnapshot, "workersAI">): ModelStatus {
  if (model.source === "workers-ai") return models.workersAI.enabled ? "ready" : "unavailable";
  if (model.verification?.status === "failed") return "failed";
  if (model.verification?.status === "verified") return "ready";
  if (!keys) return "unverified";
  if (keys.operatorAccess) return "ready";
  const key = keys.keys.find(entry => entry.provider === modelProvider(model.id));
  if (key) return key.verifiedModel === model.id ? "ready" : "unverified";
  return keys.gateway ? "unverified" : "needs-key";
}

export function inferenceRoute(keys: AiKeysSnapshot | null): { tone: "ok" | "warn"; text: string } | null {
  if (!keys) return null;
  if (keys.gateway) return { tone: "ok", text: `Inference goes through your AI Gateway, ${keys.gateway.gatewayId}.` };
  if (keys.operatorAccess) return { tone: "ok", text: "Inference goes through Gitflare's AI Gateway. No key needed." };
  if (keys.keys.length) {
    const names = keys.keys.map(entry => keys.providers.find(item => item.id === entry.provider)?.label ?? entry.provider);
    return { tone: "ok", text: `Inference uses your ${names.join(" and ")} ${names.length === 1 ? "key" : "keys"} through Gitflare's AI Gateway.` };
  }
  return { tone: "warn", text: "Add a provider key or use your own AI Gateway before agents can run." };
}
