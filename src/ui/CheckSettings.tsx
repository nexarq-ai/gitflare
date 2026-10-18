import { useEffect, useRef, useState } from "react";
import InfoTip from "./InfoTip";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { ArrowCounterClockwiseIcon, ArrowFatLinesUpIcon, CpuIcon, TimerIcon } from "@phosphor-icons/react";
import type { Check, CheckLimitSource, CheckPolicyOverride, Mission, RepositoryCheckSettings, RunnerSize, TestEvidence } from "../shared/types";
import { request } from "./api";
import { ErrorNotice } from "./components";
import DemoFeaturePanel, { demoOf } from "./DemoFeaturePanel";
import type { DemoMarked } from "../shared/demo-features";
import "./check-settings.css";

export const RUNNER_LABELS: Record<RunnerSize, string> = {
  "standard-1": "standard-1 · 1/2 vCPU, 4 GiB",
  "standard-2": "standard-2 · 1 vCPU, 6 GiB",
  "standard-3": "standard-3 · 2 vCPU, 8 GiB",
  "standard-4": "standard-4 · 4 vCPU, 12 GiB",
};
const RUNNERS = Object.keys(RUNNER_LABELS) as RunnerSize[];
const SOURCE_LABELS: Record<CheckLimitSource, string> = { owner: "Owner override", "gitflare.json": "set by gitflare.json", repository: "repository setting", learned: "learned from recent runs", auto: "automatically increased", default: "default" };
const seconds = (value: string) => value.trim() ? Number(value) : null;

export default function CheckSettings({ repositoryId, canChange, isOwner = false, onNotify }: { repositoryId: string; canChange: boolean; isOwner?: boolean; onNotify: (message: string) => void }) {
  const path = `/api/repositories/${encodeURIComponent(repositoryId)}/check-settings`;
  const [settings, setSettings] = useState<(RepositoryCheckSettings & DemoMarked) | null>(null);
  const [limit, setLimit] = useState("");
  const [runner, setRunner] = useState<RunnerSize | "">("");
  const [autoEnabled, setAutoEnabled] = useState(true);
  const [autoLimit, setAutoLimit] = useState("900");
  const [autoRunner, setAutoRunner] = useState<RunnerSize>("standard-3");
  const [overrideTest, setOverrideTest] = useState("");
  const [overrideEvidence, setOverrideEvidence] = useState<TestEvidence | "">("");
  const [overrideLimit, setOverrideLimit] = useState("");
  const [overrideRunner, setOverrideRunner] = useState<RunnerSize | "">("");
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mutation = useRef<{ signature: string; key: string } | null>(null);

  function show(current: RepositoryCheckSettings & DemoMarked) {
    setSettings(current);
    setLimit(current.testTimeoutSeconds?.toString() ?? "");
    setRunner(current.runner ?? "");
    setAutoEnabled(current.autoIncrease.enabled);
    setAutoLimit(String(current.autoIncrease.maxTimeoutSeconds));
    setAutoRunner(current.autoIncrease.maxRunner);
    setOverrideTest(current.policyOverride?.test ?? "");
    setOverrideEvidence(current.policyOverride?.evidence ?? "");
    setOverrideLimit(current.policyOverride?.testTimeoutSeconds?.toString() ?? "");
    setOverrideRunner(current.policyOverride?.runner ?? "");
  }

  useEffect(() => {
    let active = true;
    setLoadError("");
    request<RepositoryCheckSettings>(path)
      .then(current => { if (active) show(current); })
      .catch(failure => { if (active) setLoadError(failure instanceof Error ? failure.message : "Check settings could not be loaded."); });
    return () => { active = false; };
  }, [path, attempt]);

  async function save() {
    if (busy || !settings) return;
    const policyOverride: CheckPolicyOverride = { ...(overrideTest.trim() ? { test: overrideTest.trim() } : {}), ...(overrideEvidence ? { evidence: overrideEvidence } : {}), ...(overrideLimit.trim() ? { testTimeoutSeconds: Number(overrideLimit) } : {}), ...(overrideRunner ? { runner: overrideRunner } : {}) };
    const body = { testTimeoutSeconds: seconds(limit), runner: runner || null, autoIncrease: { enabled: autoEnabled, maxTimeoutSeconds: Number(autoLimit), maxRunner: autoRunner }, ...(isOwner ? { policyOverride: Object.keys(policyOverride).length ? policyOverride : null } : {}) };
    const signature = JSON.stringify(body);
    if (mutation.current?.signature !== signature) mutation.current = { signature, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const saved = await request<RepositoryCheckSettings>(path, body, mutation.current.key);
      mutation.current = null;
      show(saved);
      onNotify("Check settings saved. New attempts use them.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Check settings could not be saved.");
    } finally { setBusy(false); }
  }

  if (loadError) return <ErrorNotice message={loadError} onRetry={() => setAttempt(value => value + 1)} />;
  if (!settings) return null;
  const demo = demoOf(settings);
  if (demo) return <DemoFeaturePanel demo={demo} examples={settings.examples} />;
  const { minTimeoutSeconds, maxTimeoutSeconds } = settings.limits;
  const outOfRange = (value: string, optional: boolean) => {
    if (!value.trim()) return !optional;
    const number = Number(value);
    return !Number.isInteger(number) || number < minTimeoutSeconds || number > maxTimeoutSeconds;
  };
  const invalid = outOfRange(limit, true) || outOfRange(autoLimit, false) || outOfRange(overrideLimit, true) || overrideTest.length > 500;
  const { history } = settings;
  return (
    <section className="panel check-settings">
      <div className="panel-header"><h2>Checks</h2></div>
      <div className="panel-body">
        <p className="branch-rule-note">Applies to new attempts. An Owner override of gitflare.json takes precedence, then a <code>timeoutSeconds</code> or <code>runner</code> in <code>gitflare.json</code> at the base revision, then these settings, then the defaults: 600 s on standard-2 for package test scripts (<code>npm test</code>, <code>pnpm test</code>, <code>yarn test</code>), otherwise 120 s on standard-1. Larger runners cost more per second of check time.</p>
        {!canChange && <p className="branch-rule-note">Only Owners and Maintainers can change check settings.</p>}
        <fieldset className="check-settings-fields" disabled={!canChange || busy}>
          <div className="form-field"><span className="field-label"><label htmlFor="check-timeout">Check time limit (seconds)</label><InfoTip label="Check time limit">How long a check may run before it is stopped and marked failed. Raise it for slow test suites; 600 seconds is ten minutes.</InfoTip></span><Input id="check-timeout" inputMode="numeric" value={limit} placeholder="Default" aria-invalid={outOfRange(limit, true)} onChange={event => setLimit(event.target.value.replace(/[^0-9]/g, ""))} /><small>{minTimeoutSeconds}–{maxTimeoutSeconds} s. Leave empty for the default.</small></div>
          <div className="form-field"><span className="field-label"><label htmlFor="check-runner">Runner size</label><InfoTip label="Runner size">The container size that runs checks. Larger runners have more memory and CPU and cost more. Try a larger one if tests run out of memory.</InfoTip></span><select id="check-runner" value={runner} onChange={event => setRunner(event.target.value as RunnerSize | "")}><option value="">Default</option>{RUNNERS.map(size => <option key={size} value={size}>{RUNNER_LABELS[size]}</option>)}</select></div>
        </fieldset>
        <fieldset className="check-settings-fields" disabled={!canChange || busy}>
          <label className="check-settings-toggle"><input type="checkbox" checked={autoEnabled} onChange={event => setAutoEnabled(event.target.checked)} />Automatically retry a timed-out check once with double the time and the next runner size<InfoTip label="Automatic retry">When a check times out, Gitflare runs it once more with twice the time and a bigger runner, up to the limits below. Turn it off to keep failures as they are.</InfoTip></label>
          <div className="form-field"><span className="field-label"><label htmlFor="check-auto-limit">Auto-increase time up to (seconds)</label><InfoTip label="Auto-increase time limit">The longest time an automatic retry may use. Retries never go above this.</InfoTip></span><Input id="check-auto-limit" inputMode="numeric" value={autoLimit} disabled={!autoEnabled} aria-invalid={outOfRange(autoLimit, false)} onChange={event => setAutoLimit(event.target.value.replace(/[^0-9]/g, ""))} /></div>
          <div className="form-field"><span className="field-label"><label htmlFor="check-auto-runner">Auto-increase runner up to</label><InfoTip label="Auto-increase runner limit">The biggest runner an automatic retry may use.</InfoTip></span><select id="check-auto-runner" value={autoRunner} disabled={!autoEnabled} onChange={event => setAutoRunner(event.target.value as RunnerSize)}>{RUNNERS.map(size => <option key={size} value={size}>{RUNNER_LABELS[size]}</option>)}</select></div>
        </fieldset>
        <fieldset className="check-settings-fields" disabled={!canChange || !isOwner || busy}>
          <legend>gitflare.json override (Owner)</legend>
          <p className="branch-rule-note">gitflare.json is protected, so agents cannot change its checks. An Owner can override its test command, evidence, time limit and runner here; overrides take precedence over gitflare.json for new attempts and are logged. Evidence <code>tap</code> needs a TAP report (<code>node --test --test-reporter=tap</code>); <code>exit-code</code> passes on exit code 0. Without an evidence setting, package test scripts use the exit code and other commands expect TAP, falling back to a recognised node:test, Vitest, Jest or Mocha summary.</p>
          <div className="form-field"><span className="field-label"><label htmlFor="check-override-test">Test command</label><InfoTip label="Test command">Replaces the test command from gitflare.json for this repository, for example npm test. Leave empty to use the repository file.</InfoTip></span><Input id="check-override-test" value={overrideTest} placeholder="From gitflare.json" aria-invalid={overrideTest.length > 500} onChange={event => setOverrideTest(event.target.value)} /></div>
          <div className="form-field"><span className="field-label"><label htmlFor="check-override-evidence">Test evidence</label><InfoTip label="Test evidence">How Gitflare reads the test results, for example TAP output. Pick the format your test runner prints.</InfoTip></span><select id="check-override-evidence" value={overrideEvidence} onChange={event => setOverrideEvidence(event.target.value as TestEvidence | "")}><option value="">From gitflare.json</option><option value="tap">tap · TAP report</option><option value="exit-code">exit-code · exit code only</option></select></div>
          <div className="form-field"><span className="field-label"><label htmlFor="check-override-timeout">Time limit (seconds)</label><InfoTip label="Override time limit">The time limit to use instead of the one in gitflare.json.</InfoTip></span><Input id="check-override-timeout" inputMode="numeric" value={overrideLimit} placeholder="From gitflare.json" aria-invalid={outOfRange(overrideLimit, true)} onChange={event => setOverrideLimit(event.target.value.replace(/[^0-9]/g, ""))} /></div>
          <div className="form-field"><span className="field-label"><label htmlFor="check-override-runner">Runner size</label><InfoTip label="Override runner size">The runner size to use instead of the one in gitflare.json.</InfoTip></span><select id="check-override-runner" value={overrideRunner} onChange={event => setOverrideRunner(event.target.value as RunnerSize | "")}><option value="">From gitflare.json</option>{RUNNERS.map(size => <option key={size} value={size}>{RUNNER_LABELS[size]}</option>)}</select></div>
          {!isOwner && <small>Only an Owner can change the gitflare.json override.</small>}
        </fieldset>
        <p className="branch-rule-note">{history.p90Seconds !== undefined ? <>Recent passing checks: 90th percentile {history.p90Seconds} s over {history.samples} runs. {history.learnedTimeoutSeconds ? <>Without a set limit, checks start at the higher of the default and {history.learnedTimeoutSeconds} s (twice that, rounded up to a minute), within the auto-increase ceiling.</> : null}</> : <>Gitflare learns a starting limit after 3 passing checks ({history.samples} so far).</>}{settings.updatedBy === "gitflare:auto-increase" && <> The current values were saved automatically after a retried check passed.</>}</p>
        {error && <div className="error-notice" role="alert">{error}</div>}
        {canChange && <div className="branch-rule-actions"><Button variant="primary" size="base" loading={busy} disabled={busy || invalid} onClick={() => void save()}>Save check settings</Button></div>}
      </div>
    </section>
  );
}

export function nextRunner(runner: RunnerSize): RunnerSize | undefined {
  return RUNNERS[RUNNERS.indexOf(runner) + 1];
}

export function CheckEscalationNote({ check }: { check: Check }) {
  if (!check.escalatedFrom) return null;
  const from = check.escalatedFrom;
  return <p className="check-escalation"><ArrowFatLinesUpIcon size={14} />Timed out after {from.seconds} s on {from.runner}; Gitflare retried automatically with more time or a larger runner{check.status === "passed" ? " and saved the values that passed as the repository setting." : "."}</p>;
}

export function CheckTimeoutPanel({ mission, check, canRetry, busy, onRetry }: { mission: Mission; check: Check & { timeout: NonNullable<Check["timeout"]> }; canRetry: boolean; busy: boolean; onRetry: (adjustment: "timeout" | "runner") => void }) {
  const { seconds: limit, runner, timeoutSource, runnerSource } = check.timeout;
  const larger = nextRunner(runner);
  const retryable = ["failed", "cancelled", "needs_review"].includes(mission.status);
  const timeoutLocked = timeoutSource === "gitflare.json" || timeoutSource === "owner";
  const runnerLocked = runnerSource === "gitflare.json" || runnerSource === "owner";
  return (
    <div className="check-timeout" role="status">
      <p><TimerIcon size={16} /><strong>Timed out after {limit} s on {runner}</strong> <span>({SOURCE_LABELS[timeoutSource]} limit, {SOURCE_LABELS[runnerSource]} runner)</span></p>
      {canRetry ? (
        <div className="check-timeout-actions">
          <Button variant="primary" size="base" icon={ArrowCounterClockwiseIcon} loading={busy} disabled={busy || !retryable || limit >= 900} onClick={() => onRetry("timeout")}>{limit < 600 ? "Retry with 10 minutes" : "Retry with 15 minutes"}</Button>
          <Button variant="secondary" size="base" icon={CpuIcon} disabled={busy || !retryable || !larger} onClick={() => onRetry("runner")}>{larger ? `Retry on a larger runner (${larger})` : "Largest runner already used"}</Button>
          {(timeoutLocked || runnerLocked) && <small>gitflare.json at the base revision sets {timeoutLocked && runnerLocked ? "both values" : timeoutLocked ? "timeoutSeconds" : "runner"}. Only an Owner can retry past it; the override applies to this proposal only and is logged.</small>}
          {!retryable && <small>Wait for the current attempt to finish.</small>}
        </div>
      ) : <p className="check-timeout-note">Owners and Maintainers can retry this with more time or a larger runner.</p>}
    </div>
  );
}
