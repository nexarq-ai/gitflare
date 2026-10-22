import { useEffect, useRef, useState } from "react";
import DeployAccounts from "./AccountPicker";
import InfoTip from "./InfoTip";
import { Button } from "@cloudflare/kumo/components/button";
import type { Repository } from "../shared/types";
import { request } from "./api";
import { ErrorNotice, relativeTime } from "./components";
import { OperationTrack } from "./OperationMotion";
import { useConfirm } from "./ConfirmDialog";
import { DeployProgressPanel, Sha, useDeployProgress } from "./DeployProgress";
import { ACTIVE_STATUSES, environmentLabel, productionPrompt, publishDeployments, type ConfirmPrompt } from "./deploy-progress";
import { PageLoading } from "./WorkspaceLoader";
import DemoFeaturePanel, { demoOf } from "./DemoFeaturePanel";
import type { DemoMarked } from "../shared/demo-features";
import "./cloudflare-connection.css";

type Environment = string;
type Status = "awaiting_confirmation" | "queued" | "building" | "deploying" | "rolling_out" | "succeeded" | "uploaded" | "failed" | "superseded" | "skipped";
type Confirm = (prompt: ConfirmPrompt) => Promise<boolean>;
type TargetStatus = "pending" | "building" | "uploaded" | "deploying" | "rolling_out" | "succeeded" | "failed" | "skipped";
type Trigger = "land" | "manual" | "rollback" | "promote";
interface Target { workerName: string; configPath: string; buildCommand?: string; d1Migrations: boolean; watchPaths?: string[] }
interface TargetRun extends Target { status: TargetStatus; percentage: number; versionId?: string; urls?: string[]; migrations?: { databaseName: string; applied: string[]; pending: string[]; failed?: { name: string; error: string } }[]; durableObjectMigration?: { old_tag?: string; new_tag: string }; assets?: { uploaded: number; total: number }; notes?: string[]; error?: string }
interface Deployment { id: string; workerName: string; environment: Environment; mode?: "deploy" | "upload-only"; commitSha: string | null; trigger: Trigger; status: Status; percentage: number; versionId?: string; targets?: TargetRun[]; skippedTargets?: { workerName: string; reason: string }[]; promotedFrom?: string; targetsSource?: string; actorId: string; createdAt: string; error?: string; errorCode?: string }
interface Settings { enabled: boolean; workerName: string; rollout: "immediate" | "gradual"; trigger: "manual" | "auto"; mode: "deploy" | "upload-only"; targets: Target[] }
interface EnvironmentState {
  settings: Settings | null;
  current: { deploymentId: string; commitSha: string | null; trigger: Trigger; status: Status; updatedAt: string; workers: { workerName: string; versionId: string; percentage: number; urls?: string[] }[] } | null;
  lastChange: { deploymentId: string; commitSha: string | null; trigger: Trigger; status: Status; updatedAt: string; error?: string } | null;
  pending: string | null;
  running: boolean;
  promotable?: { deploymentId: string; commitSha: string } | null;
  canDeploy: boolean;
  deployBlockedReason?: string;
  canConfirm?: boolean;
  access?: AccessView;
  account?: { accountId: string; accountName: string | null } | null;
}
interface AccessView { status: "protected" | "unprotected" | "error"; reason?: string; appId?: string; hostnames: string[]; includes: { emails: string[]; domains: string[]; groupId?: string } | null; created: boolean; canChange: boolean; updatedAt?: string }
interface State extends DemoMarked { environmentOrder?: Environment[]; environments: Record<Environment, EnvironmentState>; deployments: Deployment[]; workers: { id: string; name: string; environment: string }[] }
interface DetectedResource { type: "d1" | "r2" | "queue"; name: string; status?: "exists" | "create" | "missing" | "unknown"; needsScope?: string }
interface DetectedTarget { workerName: string; configPath: string; buildCommand?: string; buildReasons: string[]; d1Migrations: boolean; watchPaths: string[]; dependsOn: string[]; resources: DetectedResource[]; customDomains: string[]; routes: string[]; workersDev: boolean; exists?: boolean | null; urls?: string[] }
interface SetupWarning { id: string; environment: Environment; configPath: string; message: string }
interface DetectedSetup { commitSha: string; fingerprint: string; packageManager: string | null; environments: Record<Environment, { targets: DetectedTarget[]; warnings: SetupWarning[] }>; errors: string[]; notes: string[]; account?: { connected: true; accountId: string; accountName?: string; source: string; subdomain: string | null; notes: string[] } | { connected: false; reason: string } }
interface Detection { setup: DetectedSetup; saved: { fingerprint: string; commitSha: string; appliedAt: string } | null; changed: { path: string; change: "added" | "removed" | "modified" }[]; blocking?: string[]; canApply: boolean; canAcknowledge: boolean }

const PRODUCTION = "production";
const resourceLabels: Record<DetectedResource["type"], string> = { d1: "D1", r2: "R2", queue: "Queue" };
const resourceStatus: Record<NonNullable<DetectedResource["status"]>, string> = { exists: "exists", create: "will create", missing: "missing in account", unknown: "not checked" };

function orderEnvironments(names: Environment[]): Environment[] {
  const unique = [...new Set(names)];
  return [PRODUCTION, ...(unique.includes("staging") ? ["staging"] : []), ...unique.filter((name) => name !== PRODUCTION && name !== "staging").sort()];
}
const labels: Record<Status, string> = { awaiting_confirmation: "Waiting for confirmation", queued: "Queued", building: "Building", deploying: "Deploying", rolling_out: "Rolling out", succeeded: "Live", uploaded: "Uploaded", failed: "Failed", superseded: "Superseded", skipped: "Nothing to deploy" };
const triggers: Record<Trigger, string> = { land: "on land", manual: "manual", rollback: "rollback", promote: "promoted from staging" };
const targetLabels: Record<TargetStatus, string> = { pending: "Pending", building: "Building", uploaded: "Uploaded", deploying: "Deploying", rolling_out: "Rolling out", succeeded: "Live", failed: "Failed", skipped: "Skipped" };
const ACTIVE: Status[] = ACTIVE_STATUSES;
const defaultTrigger = (): Settings["trigger"] => "manual";

function targetSummary(target: TargetRun): string {
  const parts = [targetLabels[target.status]];
  if (target.versionId) parts.push(`version ${target.versionId.slice(0, 8)}`);
  if (target.migrations?.length) parts.push(target.migrations.map((item) => item.failed ? `D1 ${item.databaseName}: ${item.failed.name} failed` : `D1 ${item.databaseName}: ${item.applied.length} applied`).join(", "));
  if (target.durableObjectMigration) parts.push(`DO migration ${target.durableObjectMigration.new_tag}`);
  if (target.assets) parts.push(`${target.assets.uploaded}/${target.assets.total} assets uploaded`);
  if (target.error) parts.push(target.error);
  return parts.join(" · ");
}

function draftFor(environment: Environment, state: State): Settings | null {
  const saved = state.environments[environment]?.settings;
  if (saved) return { ...saved, targets: saved.targets.map((target) => ({ ...target, configPath: target.configPath || "wrangler.jsonc" })) };
  const production = state.environments[PRODUCTION]?.settings;
  if (environment !== PRODUCTION && production) return { ...production, enabled: true, trigger: defaultTrigger(), targets: production.targets.map((target) => ({ ...target, workerName: state.workers.find((worker) => worker.id === `${target.workerName}-${environment}`)?.id ?? target.workerName })) };
  const worker = state.workers[0];
  return worker ? { enabled: environment !== PRODUCTION, workerName: worker.id, rollout: "immediate", trigger: defaultTrigger(), mode: "deploy", targets: [{ workerName: worker.id, configPath: "wrangler.jsonc", d1Migrations: false }] } : null;
}

function WorkerUrls({ urls }: { urls?: string[] }) {
  if (!urls?.length) return null;
  return <>{urls.map((url) => <span key={url}> · <a href={url} target="_blank" rel="noreferrer">{url.replace(/^https:\/\//, "")}</a></span>)}</>;
}

const accessLabels: Record<AccessView["status"], string> = { protected: "Protected by Cloudflare Access", unprotected: "Unprotected", error: "Access error" };
const listInput = (value: string) => value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);

function AccessProtection({ environment, access, busy, perform, confirm }: { environment: Environment; access: AccessView; busy: string; perform: (name: string, body: Record<string, unknown>, done: string) => Promise<void>; confirm: Confirm }) {
  const [emails, setEmails] = useState(access.includes?.emails.join("\n") ?? "");
  const [domains, setDomains] = useState(access.includes?.domains.join("\n") ?? "");
  const [groupId, setGroupId] = useState(access.includes?.groupId ?? "");
  const on = access.status !== "unprotected";
  const label = environmentLabel(environment);
  const empty = !listInput(emails).length && !listInput(domains).length && !groupId.trim();
  const submit = () => perform(`${environment}-access`, { action: "access", environment, enabled: true, emails: listInput(emails), domains: listInput(domains), ...(groupId.trim() ? { groupId: groupId.trim() } : {}) }, `${label} is behind Cloudflare Access.`);
  const remove = async () => await confirm({ title: `Remove Cloudflare Access from ${label}?`, description: `Anyone with a ${label} URL can open it again without signing in.`, facts: access.hostnames.length ? [{ label: access.hostnames.length === 1 ? "URL" : "URLs", value: access.hostnames.join(", ") }] : undefined, confirmLabel: "Remove protection", tone: "danger" }) && perform(`${environment}-access-remove`, { action: "access", environment, enabled: false }, `Cloudflare Access protection removed from ${label}.`);
  return (
    <div className="cf-access" aria-label={`${label} Cloudflare Access`}>
      <p className="cf-state"><strong>{accessLabels[access.status]}</strong>{access.hostnames.length ? ` · ${access.hostnames.join(", ")}` : ""}{access.appId ? ` · application ${access.appId.slice(0, 8)}${access.created ? "" : " (adopted)"}` : ""}</p>
      {access.status === "error" && access.reason && <ErrorNotice message={access.reason} />}
      {access.canChange ? (
        <details className="cf-environment-settings">
          <summary>{on ? "Change Cloudflare Access" : "Protect with Cloudflare Access"}</summary>
          <div className="cf-form-row">
            <label>Allowed emails (one per line)<InfoTip label="Allowed emails">Only these people can open the environment after signing in with Cloudflare Access.</InfoTip><textarea rows={3} value={emails} placeholder="alex@example.com" onChange={(event) => setEmails(event.target.value)} /></label>
            <label>Allowed email domains<InfoTip label="Allowed email domains">Everyone whose email ends in one of these domains can open the environment, for example example.com.</InfoTip><textarea rows={2} value={domains} placeholder="example.com" onChange={(event) => setDomains(event.target.value)} /></label>
            <label>Access group id (optional)<InfoTip label="Access group">An existing Cloudflare Zero Trust group to allow, instead of or as well as the lists above.</InfoTip><input value={groupId} placeholder="Existing Zero Trust group" onChange={(event) => setGroupId(event.target.value)} /></label>
          </div>
          <div className="cf-actions">
            <Button variant="primary" size="base" disabled={!!busy || empty} loading={busy === `${environment}-access`} onClick={() => void submit()}>{on ? "Update protection" : "Protect"}</Button>
            {on && <Button variant="secondary" size="base" disabled={!!busy} loading={busy === `${environment}-access-remove`} onClick={() => void remove()}>Remove protection</Button>}
            {empty && <span className="cf-muted">Add at least one email, domain or group.</span>}
          </div>
        </details>
      ) : <p className="cf-muted">Only an Owner can change Cloudflare Access protection.</p>}
    </div>
  );
}

export default function Deployments({ repository, canManage = false, onNotify }: { repository: Repository; canManage?: boolean; onNotify?: (message: string) => void }) {
  const [state, setState] = useState<State | null>(null);
  const [editing, setEditing] = useState<Environment>("staging");
  const [detection, setDetection] = useState<Detection | null>(null);
  const [detectError, setDetectError] = useState("");
  const [detectReload, setDetectReload] = useState(0);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [selection, setSelection] = useState<Record<Environment, string[] | null>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [reload, setReload] = useState(0);
  const [starting, setStarting] = useState("");
  const [scrollPending, setScrollPending] = useState(false);
  const [headMessage, setHeadMessage] = useState<{ sha: string; message: string } | null>(null);
  const keys = useRef(new Map<string, string>());
  const progressRef = useRef<HTMLDivElement>(null);
  const [confirm, confirmDialog] = useConfirm();
  const progress = useDeployProgress(repository.id);
  const path = `/api/repositories/${encodeURIComponent(repository.id)}/deployments`;

  useEffect(() => {
    let active = true;
    let timer = 0;
    const load = () => request<State>(path).then((value) => {
      if (!active) return;
      setState(value);
      if (demoOf(value)) return;
      publishDeployments(repository.id, value.deployments);
      setDraft((current) => current ?? draftFor(editing, value));
      if (value.deployments.some((item) => ACTIVE.includes(item.status))) timer = window.setTimeout(load, 5000);
    }).catch((failure) => { if (active) setError(failure instanceof Error ? failure.message : "Deployments could not be loaded."); });
    void load();
    return () => { active = false; window.clearTimeout(timer); };
  }, [path, reload]);

  useEffect(() => {
    if (!repository.headSha) return;
    let active = true;
    request<{ commitSha: string; commitMessage?: string }>(`/api/repositories/${encodeURIComponent(repository.id)}/proposal-base`).then((value) => { if (active && value.commitMessage) setHeadMessage({ sha: value.commitSha, message: value.commitMessage }); }).catch(() => {});
    return () => { active = false; };
  }, [repository.id, repository.headSha]);

  useEffect(() => {
    if (!scrollPending || !progressRef.current) return;
    progressRef.current.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    setScrollPending(false);
  }, [scrollPending, state, starting]);

  useEffect(() => {
    let active = true;
    setDetectError("");
    request<Detection>(`${path}/detect`).then((value) => { if (active) setDetection(value); }).catch((failure) => { if (active) setDetectError(failure instanceof Error ? failure.message : "The deploy setup could not be detected."); });
    return () => { active = false; };
  }, [path, detectReload]);

  async function perform(name: string, body: Record<string, unknown>, done: string, starts?: Environment) {
    const signature = JSON.stringify(body);
    if (!keys.current.has(signature)) keys.current.set(signature, crypto.randomUUID());
    setBusy(name);
    setError("");
    if (starts) { setStarting(starts); setScrollPending(true); }
    try {
      const result = await request<{ confirmationRequired?: string }>(path, body, keys.current.get(signature));
      keys.current.delete(signature);
      onNotify?.(result?.confirmationRequired ? "Waiting for an Owner to confirm the production deployment." : done);
      if (starts && !result?.confirmationRequired) setScrollPending(true);
      setReload((value) => value + 1);
      if (name === "apply-detected") setDetectReload((value) => value + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The deployment request failed.");
    } finally { setBusy(""); setStarting(""); }
  }

  if (!state) return error ? <ErrorNotice message={error} /> : <PageLoading />;
  const demo = demoOf(state);
  if (demo) return <DemoFeaturePanel demo={demo} examples={state.examples} />;
  const environmentNames = orderEnvironments([...(state.environmentOrder ?? Object.keys(state.environments)), ...Object.keys(detection?.setup.environments ?? {})]);
  const switchEditing = (environment: Environment) => { setEditing(environment); setDraft(draftFor(environment, state)); };
  const updateTarget = (index: number, patch: Partial<Target>) => draft && setDraft({ ...draft, targets: draft.targets.map((target, position) => position === index ? { ...target, ...patch } : target) });
  const moveTarget = (index: number, offset: number) => {
    if (!draft) return;
    const targets = draft.targets.slice();
    const [item] = targets.splice(index, 1);
    targets.splice(index + offset, 0, item);
    setDraft({ ...draft, targets });
  };
  const save = () => draft && perform("settings", { action: "settings", environment: editing, enabled: draft.enabled, rollout: draft.rollout, trigger: draft.trigger, mode: draft.mode, targets: draft.targets.map((target) => ({ workerName: target.workerName, configPath: target.configPath.trim(), ...(target.buildCommand?.trim() ? { buildCommand: target.buildCommand.trim() } : {}), d1Migrations: target.d1Migrations, ...(target.watchPaths?.length ? { watchPaths: target.watchPaths } : {}) })) }, `${environmentLabel(editing)} deployment settings saved.`);
  const productionAccount = () => { const account = state.environments[PRODUCTION]?.account; return account ? account.accountName ? `${account.accountName} (${account.accountId})` : account.accountId : null; };
  const messageFor = (sha: string | null | undefined) => sha && headMessage?.sha === sha ? headMessage.message : undefined;
  const confirmProduction = (action: "deploy" | "promote" | "rollback" | "confirm", commitSha: string | null | undefined, workers: string[], from?: string) => confirm(productionPrompt({ action, commitSha, commitMessage: messageFor(commitSha), workers, account: productionAccount(), from }));

  function detectedPanel() {
    if (detectError) return <ErrorNotice message={detectError} />;
    if (!detection) return <p className="cf-muted">Detecting the deploy setup from the Wrangler configs…</p>;
    const { setup, saved, changed } = detection;
    const environments = orderEnvironments(Object.keys(setup.environments)).filter((environment) => setup.environments[environment]);
    const warnings = environments.filter((environment) => environment !== PRODUCTION).flatMap((environment) => setup.environments[environment].warnings);
    const pending = warnings.filter((warning) => !acknowledged.includes(warning.id));
    const current = saved?.fingerprint === setup.fingerprint;
    const blocked = !detection.canApply || setup.errors.length > 0 || !setup.account?.connected || !environments.length || pending.length > 0;
    return (
      <section className="cf-detected" aria-label="Detected setup">
        <h3>Detected setup</h3>
        <p className="cf-state">From the Wrangler configs at <code>{setup.commitSha.slice(0, 12)}</code>{setup.packageManager ? ` · ${setup.packageManager}` : ""}{setup.account?.connected ? ` · account ${setup.account.accountName ? `${setup.account.accountName} ` : ""}${setup.account.accountId} (${setup.account.source} connection)${setup.account.subdomain ? ` · ${setup.account.subdomain}.workers.dev` : ""}` : ""}</p>
        {saved && changed.length > 0 && <p role="status">Setup changed in {changed.map((item) => item.path).join(", ")} since it was saved. Review the new plan and use it again.</p>}
        {saved && current && <p className="cf-state">This repository uses this detected setup (saved {relativeTime(saved.appliedAt)}).</p>}
        {setup.account && !setup.account.connected && <p className="cf-muted">{setup.account.reason}</p>}
        {setup.errors.map((item) => <ErrorNotice key={item} message={item} />)}
        {detection.blocking?.map((item) => <ErrorNotice key={item} message={item} />)}
        {!environments.length && !setup.errors.length && <p className="cf-muted">No Wrangler config was found at the default stream's latest revision.</p>}
        <div className="cf-environments">
          {environments.map((environment) => (
            <div key={environment} className="cf-environment">
              <h4>{environmentLabel(environment)}</h4>
              <p className="cf-state">{environment === PRODUCTION ? "Promote with Owner confirmation" : "Deploy on land waits for confirmation until an Owner turns on automatic deploys"}</p>
              <ol className="cf-target-runs">
                {setup.environments[environment].targets.map((target) => (
                  <li key={target.workerName}>
                    <strong>{target.workerName}</strong>{target.exists === false ? " · will be created" : target.exists ? " · exists" : ""} · <code>{target.configPath}</code>
                    <div className="cf-state">{target.buildCommand ? <>Build <code>{target.buildCommand}</code> ({target.buildReasons.join("; ")})</> : "No build step"}{target.d1Migrations ? " · D1 migrations" : ""}{target.dependsOn.length ? ` · after ${target.dependsOn.join(", ")}` : ""}</div>
                    {target.watchPaths.length > 0 && <div className="cf-state">Watch {target.watchPaths.join(", ")}</div>}
                    {target.resources.length > 0 && <div className="cf-state">{target.resources.map((resource) => `${resourceLabels[resource.type]} ${resource.name}${resource.status ? ` (${resourceStatus[resource.status]}${resource.needsScope ? `, needs ${resource.needsScope}` : ""})` : ""}`).join(" · ")}</div>}
                    <div className="cf-state">{target.urls?.length ? <WorkerUrls urls={target.urls} /> : target.workersDev ? "workers.dev URL after the account subdomain is read" : "No public URL (workers.dev off)"}</div>
                  </li>
                ))}
              </ol>
              {setup.environments[environment].warnings.map((warning) => (
                <label key={warning.id} className="cf-inline cf-warning"><input type="checkbox" disabled={!detection.canAcknowledge} checked={acknowledged.includes(warning.id)} onChange={(event) => setAcknowledged(event.target.checked ? [...acknowledged, warning.id] : acknowledged.filter((id) => id !== warning.id))} /> {warning.message}</label>
              ))}
            </div>
          ))}
        </div>
        {setup.notes.map((note) => <p key={note} className="cf-muted">{note}</p>)}
        <div className="cf-actions">
          <Button variant={current ? "secondary" : "primary"} size="base" disabled={!!busy || blocked} loading={busy === "apply-detected"} onClick={() => void perform("apply-detected", { action: "apply_detected", fingerprint: setup.fingerprint, acknowledge: acknowledged }, "Detected deploy setup saved and its Workers linked.")}>Use detected setup</Button>
          <Button variant="secondary" size="base" disabled={!!busy} onClick={() => setDetectReload((value) => value + 1)}>Re-detect</Button>
          {pending.length > 0 && <span className="cf-muted">{detection.canAcknowledge ? "Acknowledge every warning first." : "An Owner must acknowledge the warnings."}</span>}
          {!detection.canApply && <span className="cf-muted">Requires the Owner or Deployer role.</span>}
        </div>
      </section>
    );
  }

  function environmentCard(environment: Environment) {
    const view: EnvironmentState = state!.environments[environment] ?? { settings: null, current: null, lastChange: null, pending: null, running: false, canDeploy: false };
    const latest = state!.deployments.find(item => item.environment === environment && ACTIVE.includes(item.status)) ?? state!.deployments.find(item => item.id === view.lastChange?.deploymentId);
    const featured = !!latest && progress.some((item) => item.deployment.id === latest.id);
    const deploying = view.running || busy === `${environment}-deploy` || starting === environment;
    const stages = latest?.mode === "upload-only" ? ["Queued", "Build", "Upload", "Uploaded"] : ["Queued", "Build", "Deploy", "Rollout", "Live"];
    const stage = latest ? ({ queued: 0, building: 1, deploying: 2, rolling_out: 3, succeeded: 4, uploaded: 3 } as Partial<Record<Status, number>>)[latest.status] : undefined;
    const settings = view.settings;
    const targets = settings?.targets ?? [];
    const chosen = selection[environment] ?? targets.map((target) => target.workerName);
    const toggle = (workerName: string) => setSelection({ ...selection, [environment]: chosen.includes(workerName) ? chosen.filter((name) => name !== workerName) : targets.map((target) => target.workerName).filter((name) => name === workerName || chosen.includes(name)) });
    const production = environment === PRODUCTION;
    const confirmWithOwner = production && view.canConfirm && settings?.trigger !== "auto";
    const deployBody = { action: "deploy", environment, commitSha: repository.headSha, ...(chosen.length < targets.length ? { targets: chosen } : {}), ...(confirmWithOwner ? { confirm: true } : {}) };
    const promotions = production ? environmentNames.filter((name) => name !== PRODUCTION && state!.environments[name]?.promotable).map((name) => ({ from: name, ...state!.environments[name].promotable! })) : [];
    return (
      <section key={environment} className="cf-environment" aria-label={`${environmentLabel(environment)} environment`}>
        <h3>{environmentLabel(environment)}</h3>
        {latest && featured && <p className="cf-state">{labels[latest.status]} · <Sha sha={latest.commitSha} /> · progress is shown at the top of this page.</p>}
        {latest && !featured && <div className="operation-deployment"><div className="operation-deployment-heading"><strong>{labels[latest.status]}</strong><span>{latest.commitSha ? <Sha sha={latest.commitSha} /> : "Deployment"}</span></div><OperationTrack kind="deploy" active={ACTIVE.includes(latest.status)} step={stage ?? 0} steps={stages.length} failed={latest.status === "failed"} />{stage !== undefined && <ol className="operation-deployment-steps" aria-label="Deployment stages">{stages.map((label, index) => <li key={label} aria-current={index === stage ? "step" : undefined}>{label}</li>)}</ol>}</div>}
        {!settings ? <p className="cf-muted">Not configured.</p> : (
          <>
            <p className="cf-state">{settings.enabled ? (production ? (settings.trigger === "auto" ? "Deploys automatically after staging (Owner opt-in)" : "Promote or deploy with Owner confirmation") : settings.trigger === "auto" ? "Deploys automatically on land" : "Deploy on land waits for confirmation") : "Manual only"}{settings.mode === "upload-only" ? " · upload versions only" : ""}</p>
            <dl className="cf-environment-facts">
              <dt>Current revision</dt><dd>{view.current?.commitSha ? <Sha sha={view.current.commitSha} /> : "—"}{view.current ? ` · ${labels[view.current.status]}` : ""}</dd>
              <dt>Workers</dt><dd>{view.current?.workers.length ? <ul className="cf-target-runs">{view.current.workers.map((worker) => <li key={worker.workerName}><strong>{worker.workerName}</strong> · <code>{worker.versionId.slice(0, 8)}</code>{worker.percentage < 100 ? ` · ${worker.percentage}%` : ""}<WorkerUrls urls={worker.urls} /></li>)}</ul> : "—"}</dd>
              <dt>Last change</dt><dd>{view.lastChange ? <>{labels[view.lastChange.status]} · {triggers[view.lastChange.trigger]} · {relativeTime(view.lastChange.updatedAt)}{view.lastChange.error ? ` · ${view.lastChange.error}` : ""}</> : "—"}</dd>
            </dl>
            {view.deployBlockedReason && <ErrorNotice message={view.deployBlockedReason} />}
            {targets.length > 1 && (
              <fieldset className="cf-target-choice">
                <legend>Targets to deploy</legend>
                {targets.map((target) => <label key={target.workerName} className="cf-inline"><input type="checkbox" checked={chosen.includes(target.workerName)} onChange={() => toggle(target.workerName)} /> {target.workerName}</label>)}
              </fieldset>
            )}
            <div className="cf-actions">
              {view.pending && (!production || view.canConfirm) && <Button variant="primary" size="base" disabled={!!busy || view.running || !view.canDeploy} loading={busy === `${environment}-confirm`} onClick={async () => { const pending = state!.deployments.find((item) => item.id === view.pending); if (production && !await confirmProduction("confirm", pending?.commitSha, pending?.targets?.map((target) => target.workerName) ?? targets.map((target) => target.workerName))) return; void perform(`${environment}-confirm`, { action: "deploy", deploymentId: view.pending }, "Deployment started.", environment); }}>Confirm pending deploy</Button>}
              {view.pending && production && !view.canConfirm && <span className="cf-muted">Waiting for an Owner to confirm.</span>}
              {promotions.map((promotable) => <Button key={promotable.from} variant="primary" size="base" disabled={!!busy || view.running || !view.canDeploy} loading={busy === `promote-${promotable.from}`} onClick={async () => { if (confirmWithOwner && !await confirmProduction("promote", promotable.commitSha, targets.map((target) => target.workerName), promotable.from)) return; void perform(`promote-${promotable.from}`, { action: "promote", deploymentId: promotable.deploymentId, ...(confirmWithOwner ? { confirm: true } : {}) }, "Promotion to production started.", environment); }}>Promote <span title={promotable.commitSha}>{promotable.commitSha.slice(0, 7)}</span> from {environmentLabel(promotable.from)}</Button>)}
              {repository.headSha && (deploying
                ? <Button variant="primary" size="base" className="cf-deploying" disabled loading>Deploying…</Button>
                : <Button variant="secondary" size="base" disabled={!!busy || !view.canDeploy || !chosen.length} title={view.canDeploy ? repository.headSha : "Needs the Owner or Deployer role"} onClick={async () => { if (confirmWithOwner && !await confirmProduction("deploy", repository.headSha, chosen)) return; void perform(`${environment}-deploy`, deployBody, "Deployment started.", environment); }}>Deploy {repository.defaultBranch} ({repository.headSha.slice(0, 7)}){chosen.length < targets.length ? ` · ${chosen.length} of ${targets.length}` : ""}</Button>)}
              {view.current && <Button variant="secondary" size="base" disabled={!!busy || !view.canDeploy} loading={busy === `${environment}-rollback`} onClick={async () => { if (production && !await confirmProduction("rollback", null, view.current?.workers.map((worker) => worker.workerName) ?? [])) return; void perform(`${environment}-rollback`, { action: "rollback", environment }, "Rollback started.", environment); }}>Roll back</Button>}
            </div>
          </>
        )}
        {view.access && <AccessProtection key={`${environment}-${view.access.status}-${view.access.updatedAt ?? ""}`} environment={environment} access={view.access} busy={busy} perform={perform} confirm={confirm} />}
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-header"><h2>Deployments</h2></div>
      <div className="panel-body">
        <DeployProgressPanel ref={progressRef} items={progress} starting={starting} />
        <p>Deploy landed revisions to this repository's Workers.<InfoTip label="deployments">Each env.&lt;name&gt; in your Wrangler config is an environment. Staging deploys on land. Production is promoted from a successful deploy and needs an Owner.</InfoTip></p>
        <DeployAccounts repositoryId={repository.id} environments={environmentNames} canManage={canManage} />
        {detectedPanel()}
        <div className="cf-environments">{environmentNames.map(environmentCard)}</div>
        {error && <ErrorNotice message={error} />}
        {!state.workers.length ? <p className="cf-muted">Use the detected setup above, or link a Worker to this repository, to configure deployments by hand.</p> : draft && (
          <details className="cf-environment-settings">
            <summary>Settings</summary>
            <div className="cf-form-row">
              <label>Environment<InfoTip label="Environment">Which environment these settings change. Staging can deploy on land; production waits for an Owner.</InfoTip><select value={editing} onChange={(event) => switchEditing(event.target.value as Environment)}>{environmentNames.map((environment) => <option key={environment} value={environment}>{environmentLabel(environment)}</option>)}</select></label>
            </div>
            <div className="cf-targets">
              {draft.targets.map((target, index) => (
                <fieldset key={index} className="cf-target">
                  <legend>Target {index + 1}</legend>
                  <label>Worker<InfoTip label="Worker">The Worker this target deploys, as named in its Wrangler config.</InfoTip><select value={target.workerName} onChange={(event) => updateTarget(index, { workerName: event.target.value })}>{state.workers.map((worker) => <option key={worker.id} value={worker.id}>{worker.name}</option>)}</select></label>
                  <label>Wrangler config<InfoTip label="Wrangler config">Path to the wrangler.jsonc or wrangler.toml for this Worker, for example apps/api/wrangler.jsonc.</InfoTip><input value={target.configPath} placeholder="apps/api/wrangler.jsonc" onChange={(event) => updateTarget(index, { configPath: event.target.value })} /></label>
                  <label>Build command (optional)<InfoTip label="Build command">Runs before the deploy, for example pnpm build. Leave empty when Wrangler builds the Worker itself.</InfoTip><input value={target.buildCommand ?? ""} placeholder="pnpm --filter @app/web build" onChange={(event) => updateTarget(index, { buildCommand: event.target.value })} /></label>
                  <label>Watch paths (optional, one per line)<InfoTip label="Watch paths">A landed change deploys this target only if it touches these paths, for example apps/api/**. Leave empty to deploy on every change.</InfoTip><textarea rows={3} value={(target.watchPaths ?? []).join("\n")} placeholder={"apps/api/**\npackages/**\npnpm-lock.yaml"} onChange={(event) => updateTarget(index, { watchPaths: event.target.value.split("\n").map((line) => line.trim()).filter(Boolean) })} /></label>
                  <label className="cf-inline"><input type="checkbox" checked={target.d1Migrations} onChange={(event) => updateTarget(index, { d1Migrations: event.target.checked })} /> Apply D1 migrations first<InfoTip label="D1 migrations">Runs pending D1 migrations before the new version takes traffic. A failed migration stops the deploy.</InfoTip></label>
                  <div className="cf-target-actions">
                    <Button variant="secondary" size="sm" disabled={index === 0} onClick={() => moveTarget(index, -1)}>Move up</Button>
                    <Button variant="secondary" size="sm" disabled={index === draft.targets.length - 1} onClick={() => moveTarget(index, 1)}>Move down</Button>
                    <Button variant="secondary" size="sm" disabled={draft.targets.length === 1} onClick={() => setDraft({ ...draft, targets: draft.targets.filter((_, position) => position !== index) })}>Remove</Button>
                  </div>
                </fieldset>
              ))}
              {draft.targets.length < 5 && <Button variant="secondary" size="sm" onClick={() => setDraft({ ...draft, targets: [...draft.targets, { workerName: state.workers.find((worker) => !draft.targets.some((target) => target.workerName === worker.id))?.id ?? state.workers[0].id, configPath: "", d1Migrations: false }] })}>Add target</Button>}
            </div>
            <div className="cf-form-row">
              <label>Rollout<InfoTip label="Rollout">All traffic moves at once, or 10% first and the rest after 10 minutes so you can watch for errors.</InfoTip><select value={draft.rollout} onChange={(event) => setDraft({ ...draft, rollout: event.target.value as Settings["rollout"] })}><option value="immediate">100% at once</option><option value="gradual">10%, then 100% after 10 minutes</option></select></label>
              <label>Mode<InfoTip label="Mode">Deploy sends traffic to the new version. Upload only stores the version without traffic or migrations, for a later promote.</InfoTip><select value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: event.target.value as Settings["mode"] })}><option value="deploy">Deploy</option><option value="upload-only">Upload versions only (no traffic, no migrations)</option></select></label>
              <label>{editing === PRODUCTION ? "After a promotable deployment succeeds" : "After landing"}<select value={draft.trigger} onChange={(event) => setDraft({ ...draft, trigger: event.target.value as Settings["trigger"] })}><option value="manual">{editing === PRODUCTION ? "Wait for Owner confirmation" : "Wait for Deploy"}</option><option value="auto">{editing === PRODUCTION ? "Deploy automatically (Owner only)" : "Deploy automatically"}</option></select></label>
              <label className="cf-inline"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> Deploy on land<InfoTip label="Deploy on land">Deploys automatically when a change lands. Turn it off to deploy only by hand.</InfoTip></label>
              <Button variant="secondary" size="base" disabled={!!busy} loading={busy === "settings"} onClick={() => void save()}>Save {environmentLabel(editing).toLowerCase()}</Button>
            </div>
          </details>
        )}
        {confirmDialog}
        {state.deployments.length > 0 && (
          <table className="cf-deployments">
            <thead><tr><th>Environment</th><th>Status</th><th>Revision</th><th>Workers</th><th>Traffic</th><th>When</th></tr></thead>
            <tbody>{state.deployments.map((item) => (
              <tr key={item.id} title={item.error}>
                <td>{environmentLabel(item.environment)}</td>
                <td>{labels[item.status]} · {triggers[item.trigger]}{item.mode === "upload-only" ? " · upload only" : ""}{item.error ? ` · ${item.error}` : ""}</td>
                <td><Sha sha={item.commitSha} /></td>
                <td>
                  {item.targets?.length ? <ul className="cf-target-runs">{item.targets.map((target) => <li key={target.workerName} title={target.notes?.join("\n")}><strong>{target.workerName}</strong> · {targetSummary(target)}<WorkerUrls urls={target.urls} /></li>)}</ul> : !item.skippedTargets?.length ? <>{item.workerName} · <code>{item.versionId?.slice(0, 8) ?? "—"}</code></> : null}
                  {item.skippedTargets?.length ? <ul className="cf-target-runs">{item.skippedTargets.map((target) => <li key={target.workerName} className="cf-muted">{target.workerName} · skipped: {target.reason}</li>)}</ul> : null}
                  {item.targetsSource === "gitflare.json" ? <span className="cf-state"> (targets from gitflare.json)</span> : null}
                </td>
                <td>{item.percentage}%</td>
                <td>{relativeTime(item.createdAt)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </section>
  );
}
