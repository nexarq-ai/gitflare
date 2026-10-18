import type { MouseEvent } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { ArrowCounterClockwiseIcon, CaretDownIcon } from "@phosphor-icons/react";
import type { AgentRetryOverride, AgentRun, MissionStatus, ModelConnection } from "../shared/types";
import { agentRetryBlocked, describeLimits, formatDuration, moreTimeOverride } from "./agent-limits";
import "./agent-retry.css";

export function AgentLimitsDetails({ run }: { run: Pick<AgentRun, "limits" | "editScope" | "autoRetried"> }) {
  if (!run.limits && !run.editScope?.length && !run.autoRetried) return null;
  return <>
    {run.limits && <><dt>Limits</dt><dd>{describeLimits(run.limits)}</dd></>}
    {run.editScope?.length ? <><dt>May edit</dt><dd className="agent-edit-scope">{run.editScope.map(entry => <code key={entry}>{entry}</code>)}</dd></> : null}
    {run.autoRetried && <><dt>Retried</dt><dd>Automatically, once</dd></>}
  </>;
}

export default function AgentRetry({ run, status, canExecute, busy, loading, models, onRetry }: {
  run: Pick<AgentRun, "id" | "name" | "model" | "limits">;
  status: MissionStatus;
  canExecute: boolean;
  busy: boolean;
  loading: boolean;
  models: ModelConnection[] | null;
  onRetry: (override?: AgentRetryOverride) => void;
}) {
  const blocked = agentRetryBlocked(status, canExecute);
  const more = moreTimeOverride(run);
  const others = (models ?? []).filter(model => model.id !== run.model);
  const choose = (event: MouseEvent<HTMLButtonElement>, override: AgentRetryOverride) => {
    event.currentTarget.closest("details")?.removeAttribute("open");
    onRetry(override);
  };
  return (
    <div className="agent-retry">
      <Button variant="secondary" size="sm" icon={ArrowCounterClockwiseIcon} loading={loading} disabled={busy || !!blocked} title={blocked ?? `Retry ${run.name} with the same limits and model`} onClick={() => onRetry()}>Retry</Button>
      {!blocked && <details className="agent-retry-menu">
        <summary aria-label={`More ways to retry ${run.name}`}><CaretDownIcon size={12} aria-hidden="true" /></summary>
        <div className="agent-retry-options">
          <button type="button" disabled={busy} onClick={event => choose(event, more)}>Retry with more time<small>{formatDuration(more.runSeconds!)} per run, {more.modelAnswerSeconds} s per model answer</small></button>
          <span className="agent-retry-heading">Retry with another model</span>
          {models === null ? <small>Loading models…</small> : others.length ? others.map(model => <button type="button" key={model.id} disabled={busy} onClick={event => choose(event, { model: model.id })}>{model.label}</button>) : <small>No other enabled models.</small>}
        </div>
      </details>}
    </div>
  );
}
