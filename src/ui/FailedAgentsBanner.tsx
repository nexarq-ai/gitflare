import { Button } from "@cloudflare/kumo/components/button";
import { WarningCircleIcon } from "@phosphor-icons/react";
import type { AgentRetryOverride, AgentRun, Mission, ModelConnection } from "../shared/types";
import AgentRetry from "./AgentRetry";
import "./failed-agents-banner.css";

export function failedAgents(mission: Pick<Mission, "status" | "runs">): AgentRun[] {
  if (mission.status !== "failed" && mission.status !== "cancelled") return [];
  return mission.runs.filter((run) => run.status === "failed");
}

export default function FailedAgentsBanner({ mission, canExecute, canRetry, canDrop, busy, models, onRetry, onDrop }: {
  mission: Pick<Mission, "status" | "runs">;
  canExecute: boolean;
  canRetry: boolean;
  canDrop: boolean;
  busy: string;
  models: ModelConnection[] | null;
  onRetry: (runId: string, override?: AgentRetryOverride) => void;
  onDrop: () => void;
}) {
  const failed = failedAgents(mission);
  if (!failed.length) return null;
  return (
    <section className="alert error failed-agents" role="alert" aria-label="Failed agents">
      <WarningCircleIcon size={17} />
      <div className="alert-text">
        <strong>{failed.length === 1 ? `${failed[0]!.name} failed` : `${failed.length} agents failed`}, so this attempt has no combined candidate.</strong>
        <ul className="failed-agents-list">
          {failed.map((run) => (
            <li key={run.id}>
              <span className="failed-agents-name">{run.name}</span>
              <span className="failed-agents-reason">{run.error ?? "No reason was recorded."}</span>
              {canRetry && (
                <AgentRetry
                  run={run}
                  status={mission.status}
                  canExecute={canExecute}
                  busy={!!busy}
                  loading={busy === `retry-agent:${run.id}`}
                  models={models}
                  onRetry={(override) => onRetry(run.id, override)}
                />
              )}
            </li>
          ))}
        </ul>
        {canDrop && (
          <Button variant="secondary" size="sm" loading={busy === "drop-failed-agents"} disabled={!!busy || !canExecute} onClick={onDrop}>
            {failed.length === 1 ? `Continue without ${failed[0]!.name}` : "Continue without failed agents"}
          </Button>
        )}
      </div>
    </section>
  );
}
