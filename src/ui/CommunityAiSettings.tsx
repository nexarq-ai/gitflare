import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import type { CommunityAiSettings as Settings } from "../shared/types";
import { request } from "./api";
import { relativeTime } from "./components";
import { useConfirm } from "./ConfirmDialog";
import InfoTip from "./InfoTip";
import { PageLoading } from "./WorkspaceLoader";
import "./fix-requests.css";

type Draft = { models: string[]; missionsPerDay: string; draftsPerDay: string; perUserPerDay: string };

function draftOf(settings: Settings): Draft {
  const pool = settings.pool;
  return { models: pool?.models ?? settings.eligibleModels.slice(0, 1).map(model => model.id), missionsPerDay: String(pool?.missionsPerDay ?? 10), draftsPerDay: String(pool?.draftsPerDay ?? 50), perUserPerDay: String(pool?.perUserPerDay ?? 2) };
}

export default function CommunityAiSettings({ repositoryId, onNotify }: { repositoryId: string; onNotify: (message: string) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirm, dialog] = useConfirm();
  const key = useRef(crypto.randomUUID());
  const path = `/api/repositories/${encodeURIComponent(repositoryId)}/community-ai`;

  useEffect(() => {
    let active = true;
    request<Settings>(path).then(value => { if (active) { setSettings(value); setDraft(draftOf(value)); } }, (failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "Community AI settings could not be loaded."); });
    return () => { active = false; };
  }, [path]);

  async function save(name: string, body: Record<string, unknown>, done: string) {
    setBusy(name); setError("");
    try { const next = await request<Settings>(path, body, key.current); setSettings(next); setDraft(draftOf(next)); onNotify(done); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The change could not be saved."); }
    finally { key.current = crypto.randomUUID(); setBusy(""); }
  }

  async function fund() {
    if (!settings || !draft) return;
    const labels = settings.eligibleModels.filter(model => draft.models.includes(model.id)).map(model => model.label).join(", ");
    const accepted = await confirm({ title: settings.pool ? "Update the community pool?" : "Fund a community pool?", description: "Anyone signed in can then request fixes here within these limits, paid with this workspace's own AI key or Gateway.", facts: [{ label: "Models", value: labels }, { label: "Agent runs a day", value: draft.missionsPerDay }, { label: "Agent answers a day", value: draft.draftsPerDay }, { label: "Requests per person a day", value: draft.perUserPerDay }], confirmLabel: settings.pool ? "Save pool" : "Fund pool" });
    if (accepted) await save("pool", { action: "set-pool", models: draft.models, missionsPerDay: Number(draft.missionsPerDay), draftsPerDay: Number(draft.draftsPerDay), perUserPerDay: Number(draft.perUserPerDay) }, "Community pool saved.");
  }

  async function stop() {
    if (await confirm({ title: "Stop the community pool?", description: "New fix requests, triage and reviews stop using this workspace's AI. Work already running keeps its funding until it finishes.", confirmLabel: "Stop pool", tone: "danger" })) await save("disable", { action: "disable-pool" }, "Community pool stopped.");
  }

  if (error && !settings) return <div className="error-notice" role="alert">{error}</div>;
  if (!settings || !draft) return <PageLoading />;
  const { pool, usage, assist, canManage } = settings;
  const number = (field: "missionsPerDay" | "draftsPerDay" | "perUserPerDay", label: string, min: number, max: number) => <div className="form-field">
    <label htmlFor={`pool-${field}`}>{label}</label>
    <Input id={`pool-${field}`} type="number" min={min} max={max} disabled={!canManage || !!busy} value={draft[field]} onChange={event => setDraft({ ...draft, [field]: event.target.value })} />
  </div>;
  return <>
    {!settings.public && <div className="alert info"><div className="alert-text">Community AI starts working once this repository is public.</div></div>}
    {error && <div className="error-notice" role="alert">{error}</div>}
    <section className="panel">
      <div className="panel-header"><h2>Community AI pool</h2><InfoTip label="the community pool">Pays for fixes anyone requests here, plus agent triage and reviews, with this workspace's own AI key or Gateway. Gitflare never pays. Without a pool, people use their own key.</InfoTip></div>
      {pool ? <dl className="general-facts">
        <dt>Today</dt><dd>{usage.missions} of {pool.missionsPerDay} agent runs · {usage.drafts} of {pool.draftsPerDay} agent answers</dd>
        <dt>Funded</dt><dd>{relativeTime(pool.grantedAt)}</dd>
      </dl> : <div className="panel-body"><p className="issue-muted">No pool. People who request fixes pay with their own AI key.</p></div>}
      {canManage && (settings.eligibleModels.length ? <div className="community-ai-form">
        <div className="community-ai-models" role="group" aria-label="Models the pool pays for">
          {settings.eligibleModels.map(model => <label key={model.id}><input type="checkbox" disabled={!!busy} checked={draft.models.includes(model.id)} onChange={event => setDraft({ ...draft, models: event.target.checked ? [...draft.models, model.id].slice(0, 5) : draft.models.filter(id => id !== model.id) })} />{model.label}</label>)}
        </div>
        {number("missionsPerDay", "Agent runs a day", 0, 200)}
        {number("draftsPerDay", "Agent answers a day", 0, 1000)}
        {number("perUserPerDay", "Requests per person a day", 1, 20)}
        <div className="community-ai-actions">
          {pool && <Button variant="secondary-destructive" size="base" loading={busy === "disable"} disabled={!!busy} onClick={() => void stop()}>Stop pool</Button>}
          <Button variant="primary" size="base" loading={busy === "pool"} disabled={!!busy || !draft.models.length} onClick={() => void fund()}>{pool ? "Save pool" : "Fund pool"}</Button>
        </div>
      </div> : <div className="panel-body"><p className="issue-muted">Add an AI key or Gateway and verify a model in Settings &gt; AI models to fund a pool.</p></div>)}
    </section>
    <section className="panel">
      <div className="panel-header"><h2>Agent help</h2><InfoTip label="agent help">Triage suggests labels, duplicates and a checklist on new issues for a triager to accept. Review comments on outside proposals after checks pass. Neither ever approves, and both use the pool{settings.operatorTriage ? "; triage here is also funded by Gitflare for featured projects" : ""}.</InfoTip></div>
      <div className="community-ai-switches">
        <label className="community-ai-switch"><input type="checkbox" disabled={!canManage || !!busy} checked={assist.triage} onChange={event => void save("assist", { action: "set-assist", triage: event.target.checked, review: assist.review }, event.target.checked ? "Agent triage on." : "Agent triage off.")} />Suggest triage for new issues</label>
        <label className="community-ai-switch"><input type="checkbox" disabled={!canManage || !!busy} checked={assist.review} onChange={event => void save("assist", { action: "set-assist", triage: assist.triage, review: event.target.checked }, event.target.checked ? "Agent review on." : "Agent review off.")} />Review outside proposals and requested fixes</label>
      </div>
    </section>
    {dialog}
  </>;
}
