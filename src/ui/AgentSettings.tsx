import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import type { AgentSettingsBounds, RepositoryAgentSettings } from "../shared/types";
import InfoTip from "./InfoTip";
import { request } from "./api";
import { ErrorNotice } from "./components";
import { durationField, formatDuration, parseDuration } from "./agent-limits";
import "./check-settings.css";

export interface AgentSettingsForm { modelAnswer: string; modelRetries: string; maxSteps: string; runTime: string; autoRetry: boolean }

export function agentSettingsForm(current: RepositoryAgentSettings): AgentSettingsForm {
  const { effective } = current;
  return {
    modelAnswer: effective.modelAnswerSeconds === null ? "" : String(effective.modelAnswerSeconds),
    modelRetries: String(effective.modelRetries),
    maxSteps: String(effective.maxSteps),
    runTime: durationField(effective.runSeconds),
    autoRetry: effective.autoRetry,
  };
}

const within = (value: number | null | undefined, range: { min: number; max: number }) => typeof value === "number" && Number.isInteger(value) && value >= range.min && value <= range.max;

export function agentSettingsProblems(form: AgentSettingsForm, bounds: AgentSettingsBounds): Partial<Record<keyof AgentSettingsForm, true>> {
  const problems: Partial<Record<keyof AgentSettingsForm, true>> = {};
  if (form.modelAnswer.trim() && !within(Number(form.modelAnswer), bounds.modelAnswerSeconds)) problems.modelAnswer = true;
  if (!form.modelRetries.trim() || !within(Number(form.modelRetries), bounds.modelRetries)) problems.modelRetries = true;
  if (!form.maxSteps.trim() || !within(Number(form.maxSteps), bounds.maxSteps)) problems.maxSteps = true;
  if (!within(parseDuration(form.runTime), bounds.runSeconds)) problems.runTime = true;
  return problems;
}

export function agentSettingsBody(form: AgentSettingsForm) {
  return {
    modelAnswerSeconds: form.modelAnswer.trim() ? Number(form.modelAnswer) : null,
    modelRetries: Number(form.modelRetries),
    maxSteps: Number(form.maxSteps),
    runSeconds: parseDuration(form.runTime) as number,
    autoRetry: form.autoRetry,
  };
}

const digits = (value: string) => value.replace(/[^0-9]/g, "");

export default function AgentSettings({ repositoryId, canChange, onNotify }: { repositoryId: string; canChange: boolean; onNotify: (message: string) => void }) {
  const path = `/api/repositories/${encodeURIComponent(repositoryId)}/agent-settings`;
  const [settings, setSettings] = useState<RepositoryAgentSettings | null>(null);
  const [form, setForm] = useState<AgentSettingsForm | null>(null);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mutation = useRef<{ signature: string; key: string } | null>(null);

  function show(current: RepositoryAgentSettings) {
    setSettings(current);
    setForm(agentSettingsForm(current));
  }

  useEffect(() => {
    let active = true;
    setLoadError("");
    request<RepositoryAgentSettings>(path)
      .then(current => { if (active) show(current); })
      .catch(failure => { if (active) setLoadError(failure instanceof Error ? failure.message : "Agent settings could not be loaded."); });
    return () => { active = false; };
  }, [path, attempt]);

  if (loadError) return <ErrorNotice message={loadError} onRetry={() => setAttempt(value => value + 1)} />;
  if (!settings || !form) return null;
  const { bounds, defaults } = settings;
  const problems = agentSettingsProblems(form, bounds);
  const invalid = Object.keys(problems).length > 0;
  const update = (patch: Partial<AgentSettingsForm>) => setForm(current => current && { ...current, ...patch });

  async function save() {
    if (busy || invalid || !form) return;
    const body = agentSettingsBody(form);
    const signature = JSON.stringify(body);
    if (mutation.current?.signature !== signature) mutation.current = { signature, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const saved = await request<RepositoryAgentSettings>(path, body, mutation.current.key);
      mutation.current = null;
      show(saved);
      onNotify("Agent settings saved. New agent runs use them.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Agent settings could not be saved.");
    } finally { setBusy(false); }
  }

  return (
    <section className="panel check-settings agent-settings">
      <div className="panel-header"><h2>Agents</h2></div>
      <div className="panel-body">
        <p className="branch-rule-note">Applies to agent runs that start after you save. Each run keeps the limits it started with. A mission can set a shorter or longer time limit and step count per agent.</p>
        {!canChange && <p className="branch-rule-note">Only Owners and Maintainers can change agent settings.</p>}
        <fieldset className="check-settings-fields" disabled={!canChange || busy}>
          <div className="form-field"><span className="field-label"><label htmlFor="agent-model-answer">Time per model answer (s)</label><InfoTip label="Time per model answer">How long one model reply may take. Automatic streams Claude Fable and Opus 5.x answers for up to 600 s and stops one that sends nothing for 120 s; other models get up to 180 s, scaled to the expected output size.</InfoTip></span><Input id="agent-model-answer" inputMode="numeric" value={form.modelAnswer} placeholder="Automatic" aria-invalid={!!problems.modelAnswer} onChange={event => update({ modelAnswer: digits(event.target.value) })} /><small>{bounds.modelAnswerSeconds.min}–{bounds.modelAnswerSeconds.max} s. Leave empty for automatic.</small></div>
          <div className="form-field"><span className="field-label"><label htmlFor="agent-model-retries">Model answer retries</label><InfoTip label="Model answer retries">How often Gitflare asks the same model again after a timeout or overload before the agent fails.</InfoTip></span><Input id="agent-model-retries" inputMode="numeric" value={form.modelRetries} aria-invalid={!!problems.modelRetries} onChange={event => update({ modelRetries: digits(event.target.value) })} /><small>{bounds.modelRetries.min}–{bounds.modelRetries.max}. Default {defaults.modelRetries}.</small></div>
          <div className="form-field"><span className="field-label"><label htmlFor="agent-max-steps">Max steps per agent</label><InfoTip label="Max steps per agent">The most tool calls and edits one agent may make before it stops.</InfoTip></span><Input id="agent-max-steps" inputMode="numeric" value={form.maxSteps} aria-invalid={!!problems.maxSteps} onChange={event => update({ maxSteps: digits(event.target.value) })} /><small>{bounds.maxSteps.min}–{bounds.maxSteps.max}. Default {defaults.maxSteps}.</small></div>
          <div className="form-field"><span className="field-label"><label htmlFor="agent-run-time">Time limit per agent run</label><InfoTip label="Time limit per agent run">How long one agent may work before it is stopped and marked failed. Enter minutes, or add s for seconds.</InfoTip></span><Input id="agent-run-time" value={form.runTime} placeholder={durationField(defaults.runSeconds)} aria-invalid={!!problems.runTime} onChange={event => update({ runTime: event.target.value })} /><small>{formatDuration(bounds.runSeconds.min)}–{formatDuration(bounds.runSeconds.max)}. Minutes, or seconds with s (900s).</small></div>
          <label className="check-settings-toggle"><input type="checkbox" checked={form.autoRetry} onChange={event => update({ autoRetry: event.target.checked })} />Retry a failed agent once automatically<InfoTip label="Automatic agent retry">Retries an agent once when it failed on a model timeout or overload. Policy and approval failures are never retried.</InfoTip></label>
        </fieldset>
        {error && <div className="error-notice" role="alert">{error}</div>}
        {canChange && <div className="branch-rule-actions"><Button variant="primary" size="base" loading={busy} disabled={busy || invalid} onClick={() => void save()}>Save agent settings</Button></div>}
      </div>
    </section>
  );
}
