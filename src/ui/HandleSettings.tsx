import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { HandleAvailability, HandleStatus } from "../shared/types";
import { HANDLE_MAX, HANDLE_REDIRECT_DAYS, handleProblem, normalizeHandle } from "../shared/handles";
import { request } from "./api";
import InfoTip from "./InfoTip";
import "./public-settings.css";

type Availability = { state: "idle" | "checking" | "available" | "unavailable"; message: string };

export function originHost(origin: string): string {
  try { return new URL(origin).host; } catch { return origin.replace(/^https?:\/\//, ""); }
}

function useHandleStatus() {
  const [status, setStatus] = useState<HandleStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    request<HandleStatus>("/api/handles").then(data => { if (active) setStatus(data); }, (failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "Handles could not be loaded."); });
    return () => { active = false; };
  }, []);
  return { status, setStatus, error };
}

function useAvailability(value: string, current: string | null, scope: "user" | "workspace"): Availability {
  const [result, setResult] = useState<Availability & { handle: string }>({ handle: "", state: "idle", message: "" });
  const problem = !value || value === current ? null : handleProblem(value);
  const local = problem?.code === "INVALID_HANDLE" ? problem : null;
  const pending = !!value && value !== current && !local;
  useEffect(() => {
    if (!pending) return;
    let active = true;
    const timer = setTimeout(() => {
      request<HandleAvailability>(`/api/handles/check?${new URLSearchParams({ handle: value, scope })}`).then(
        data => { if (active) setResult({ handle: value, state: data.available ? "available" : "unavailable", message: data.available ? "Available" : data.message ?? "Not available." }); },
        (failure: unknown) => { if (active) setResult({ handle: value, state: "unavailable", message: failure instanceof Error ? failure.message : "Availability could not be checked." }); },
      );
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [value, pending, scope]);
  if (local) return { state: "unavailable", message: local.message };
  if (!pending) return { state: "idle", message: "" };
  return result.handle === value ? result : { state: "checking", message: "Checking…" };
}

function HandleAddress({ host, handle }: { host: string; handle: string }) {
  return <code className="handle-address"><span>{host}/</span><strong>{handle}</strong></code>;
}

function HandleEditor({ scope, current, suggested, host, onSaved }: { scope: "user" | "workspace"; current: string | null; suggested: string; host: string; onSaved: (status: HandleStatus) => Promise<void> | void }) {
  const [editing, setEditing] = useState(!current);
  const [value, setValue] = useState(current ?? suggested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const availability = useAvailability(value, current, scope);
  const unchanged = value === current;
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const status = await request<HandleStatus>("/api/handles", { scope, handle: value });
      await onSaved(status);
      setEditing(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The handle could not be saved."); }
    finally { setBusy(false); }
  }
  if (!editing && current) return <div className="general-row handle-row"><HandleAddress host={host} handle={current} /><Button variant="secondary" size="base" onClick={() => { setValue(current); setEditing(true); setError(""); requestAnimationFrame(() => input.current?.select()); }}>Change</Button></div>;
  return <>
    <form className="handle-form" onSubmit={event => void save(event)}>
      <label className="sr-only" htmlFor={id}>Handle</label>
      <div className="handle-input"><span aria-hidden="true">{host}/</span><input ref={input} id={id} value={value} required maxLength={HANDLE_MAX} autoComplete="off" autoCapitalize="none" spellCheck={false} aria-describedby={`${id}-status`} aria-invalid={availability.state === "unavailable"} onChange={event => { setValue(normalizeHandle(event.target.value)); setError(""); }} /></div>
      <div className="handle-actions">
        <Button type="submit" variant="primary" size="base" loading={busy} disabled={!value || unchanged || availability.state !== "available"}>Save</Button>
        {current && <Button type="button" variant="ghost" size="base" disabled={busy} onClick={() => { setEditing(false); setValue(current); setError(""); }}>Cancel</Button>}
      </div>
    </form>
    <p id={`${id}-status`} className={`handle-status handle-status-${availability.state}`} role="status">{availability.state === "available" ? <CheckCircleIcon size={14} weight="fill" aria-hidden="true" /> : availability.state === "unavailable" ? <WarningCircleIcon size={14} weight="fill" aria-hidden="true" /> : null}{availability.message}</p>
    {error && <div className="form-error" role="alert">{error}</div>}
  </>;
}

function HandlePanel({ tip, children }: { tip: ReactNode; children: ReactNode }) {
  return <section className="panel">
    <div className="panel-header"><h2 className="field-label">Handle<InfoTip label="Handle">{tip}</InfoTip></h2></div>
    <div className="panel-body">{children}</div>
  </section>;
}

export function UserHandleCard({ onChanged }: { onChanged: () => Promise<void> }) {
  const { status, setStatus, error } = useHandleStatus();
  return <HandlePanel tip={`Your public address. Setting it creates your personal workspace. After a rename the old address redirects for ${HANDLE_REDIRECT_DAYS} days.`}>
    {error ? <div className="form-error" role="alert">{error}</div>
      : !status ? <p className="people-muted" role="status">Loading handle…</p>
      : <>
        {!status.user.handle && <p className="people-muted handle-lead">Choose your public address.</p>}
        <HandleEditor key={status.user.handle ?? ""} scope="user" current={status.user.handle} suggested={status.user.suggested} host={originHost(status.origin)} onSaved={async next => { setStatus(next); await onChanged(); }} />
      </>}
  </HandlePanel>;
}

export function WorkspaceHandleCard({ onChanged }: { onChanged: () => Promise<void> }) {
  const { status, setStatus, error } = useHandleStatus();
  const workspace = status?.workspace;
  const host = status ? originHost(status.origin) : "";
  return <HandlePanel tip={`The public address of this workspace's public repositories. After a rename the old address redirects for ${HANDLE_REDIRECT_DAYS} days.`}>
    {error ? <div className="form-error" role="alert">{error}</div>
      : !workspace ? <p className="people-muted" role="status">Loading handle…</p>
      : workspace.personal ? <>
        {workspace.handle && <div className="general-row handle-row"><HandleAddress host={host} handle={workspace.handle} /></div>}
        <p className="people-muted handle-note">Uses your account handle. <a href="/account/profile">Change it in your profile</a></p>
      </>
      : workspace.canChange ? <HandleEditor key={workspace.handle ?? ""} scope="workspace" current={workspace.handle} suggested={workspace.suggested} host={host} onSaved={async next => { setStatus(next); await onChanged(); }} />
      : workspace.handle ? <div className="general-row handle-row"><HandleAddress host={host} handle={workspace.handle} /></div>
      : <p className="people-muted">No handle yet. An Owner can set one.</p>}
  </HandlePanel>;
}
