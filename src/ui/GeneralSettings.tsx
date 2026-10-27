import { useState, type FormEvent } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import type { AccessSnapshot, Workspace } from "../shared/types";
import { request } from "./api";
import AiSettingsPanel from "./AiSettingsPanel";
import { InstallationCredentialPrompt } from "./InstallationCredential";
import { ROLE_HELP } from "./people-data";
import { needsRecentSignIn, signInAgain } from "./reauth";
import { demoOf } from "./DemoFeaturePanel";
import InfoTip from "./InfoTip";
import CheckChips, { CHECKS_TIP, requiredCheckLabel } from "./CheckChips";
import type { RequirableCheck } from "../shared/checks";
import { WorkspaceHandleCard } from "./HandleSettings";
import ProfileSettingsCard from "./ProfileSettings";
import { approvalWarning, eligibleApprovers, offeredChecks, selfApprovalNote } from "./approvals";
import "./people-settings.css";

type Props = { workspace: Workspace; data: AccessSnapshot; selfHosted: boolean; onChanged: () => Promise<void>; onLeft: (remaining: { id: string }[]) => Promise<void>; onOpenInstallation: () => void };

export default function GeneralSettings({ workspace, data, selfHosted, onChanged, onLeft, onOpenInstallation }: Props) {
  const owner = !demoOf(data) && data.role === "Owner";
  const accountSession = "email" in data.user;
  const owners = data.members.filter(item => item.role === "Owner");
  const canLeave = accountSession && !selfHosted && (!owner || owners.length > 1) && data.workspaces.length > 1;
  return <>
    <div className="page-heading"><div><h1>Workspace</h1><p>Name, defaults and ownership for {workspace.name}.</p></div></div>
    {selfHosted && owner && <InstallationCredentialPrompt onOpen={onOpenInstallation} />}
    <NameCard name={workspace.name} role={data.role} owner={owner} onChanged={onChanged} />
    {!selfHosted && !demoOf(data) && <><WorkspaceHandleCard key={data.workspace?.id} onChanged={onChanged} /><ProfileSettingsCard key={`profile-${data.workspace?.id}`} scope="workspace" /></>}
    <AiSettingsPanel settings={workspace.ai} canManage={owner} onChanged={onChanged} />
    <ProtectionCard key={JSON.stringify(data.protection)} protection={data.protection} owner={owner} approvers={eligibleApprovers(data.members)} offered={offeredChecks(workspace.missions)} onChanged={onChanged} />
    {owner && <OwnershipCard data={data} onChanged={onChanged} />}
    {canLeave && <LeaveCard name={workspace.name} onLeft={onLeft} />}
  </>;
}

function NameCard({ name, role, owner, onChanged }: { name: string; role: string; owner: boolean; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await request("/api/access/workspace-rename", { name: value.trim() }); await onChanged(); setEditing(false); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The name could not be changed."); }
    finally { setBusy(false); }
  }
  return <section className="panel">
    <div className="panel-header"><h2>Name</h2><span className="people-role-text" title={ROLE_HELP[role]}>You are {role}</span></div>
    <div className="panel-body">
      {editing ? <form className="general-inline-form" onSubmit={event => void save(event)}>
        <label className="sr-only" htmlFor="workspace-name">Workspace name</label>
        <input id="workspace-name" required maxLength={100} value={value} autoFocus onFocus={event => event.currentTarget.select()} onChange={event => setValue(event.target.value)} />
        <Button type="submit" variant="primary" size="base" loading={busy} disabled={!value.trim() || value.trim() === name}>Save</Button>
        <Button type="button" variant="ghost" size="base" disabled={busy} onClick={() => { setEditing(false); setValue(name); setError(""); }}>Cancel</Button>
      </form> : <div className="general-row"><strong className="general-name">{name}</strong>{owner && <Button variant="secondary" size="base" onClick={() => { setValue(name); setEditing(true); }}>Rename</Button>}</div>}
      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
  </section>;
}

function ProtectionCard({ protection, owner, approvers, offered, onChanged }: { protection: AccessSnapshot["protection"]; owner: boolean; approvers: number; offered: RequirableCheck[]; onChanged: () => Promise<void> }) {
  const [required, setRequired] = useState(protection.requiredApprovals);
  const [checks, setChecks] = useState(protection.requiredChecks);
  const [preventSelf, setPreventSelf] = useState(protection.preventSelfApproval);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const warning = approvalWarning(required, approvers, preventSelf);
  const blocked = !!warning?.blocking && !confirmed;
  async function save(event: FormEvent) {
    event.preventDefault(); if (blocked) return;
    setBusy(true); setError(""); setSaved(false);
    try { await request("/api/access/protection", { requiredApprovals: required, requiredChecks: checks, preventSelfApproval: preventSelf }); setSaved(true); setConfirmed(false); await onChanged(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The rules could not be saved."); }
    finally { setBusy(false); }
  }
  return <section className="panel">
    <div className="panel-header"><h2>Before a change lands</h2></div>
    <div className="panel-body">
      <p className="people-muted">Defaults for every repository. A repository's Streams settings can be stricter.</p>
      {owner ? <form className="general-protection" onSubmit={event => void save(event)}>
        <div className="people-field"><span className="field-label"><label htmlFor="required-approvals">Approvals needed</label><InfoTip label="Approvals needed">How many people must approve the exact revision before it lands. 1 means one reviewer; higher numbers need more reviewers. {approvers === 1 ? "1 person" : `${approvers} people`} can approve in this workspace today.</InfoTip></span>
          <input id="required-approvals" type="number" min={1} max={10} value={required} required onChange={event => { setRequired(Number(event.target.value)); setConfirmed(false); }} />
          <small>{approvers === 1 ? "1 person" : `${approvers} people`} can approve here (Reviewers, Maintainers and Owners).</small>
          {warning && <p className={`approval-warning${warning.blocking ? " approval-warning-blocking" : ""}`} role="status">{warning.text}</p>}
          {warning?.blocking && <label className="people-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Save anyway, I will invite reviewers</label>}
        </div>
        <div className="people-field"><span className="field-label">Checks that must pass<InfoTip label="Checks that must pass">{CHECKS_TIP}</InfoTip></span>
          <CheckChips label="Checks that must pass" offered={offered} selected={checks} onChange={setChecks} />
        </div>
        <div><label className="people-check"><input type="checkbox" checked={preventSelf} onChange={event => setPreventSelf(event.target.checked)} />Authors cannot approve their own changes<InfoTip label="Authors cannot approve their own changes">{selfApprovalNote(approvers)}</InfoTip></label></div>
        <div className="gf-form-footer">{saved && <span className="people-muted" role="status">Saved.</span>}<Button type="submit" variant="primary" size="base" loading={busy} disabled={blocked}>Save rules</Button></div>
        {error && <div className="form-error" role="alert">{error}</div>}
      </form> : <dl className="general-facts">
        <dt>Approvals needed</dt><dd>{protection.requiredApprovals}</dd>
        <dt>Checks that must pass</dt><dd>{protection.requiredChecks.length ? protection.requiredChecks.map(requiredCheckLabel).join(", ") : "None"}</dd>
        <dt>Self-approval</dt><dd>{protection.preventSelfApproval ? "Authors cannot approve their own changes" : "Allowed"}</dd>
      </dl>}
    </div>
  </section>;
}

function OwnershipCard({ data, onChanged }: { data: AccessSnapshot; onChanged: () => Promise<void> }) {
  const candidates = data.members.filter(item => item.userId !== data.user.id && item.role !== "Owner" && item.user);
  const [target, setTarget] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reauth, setReauth] = useState(false);
  async function transfer(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setReauth(false);
    try { await request("/api/access/transfer", { userId: target }); await onChanged(); }
    catch (failure) { if (needsRecentSignIn(failure)) setReauth(true); else setError(failure instanceof Error ? failure.message : "Ownership could not be transferred."); }
    finally { setBusy(false); }
  }
  return <section className="panel">
    <div className="panel-header"><h2>Ownership</h2></div>
    <div className="panel-body">
      {!candidates.length ? <p className="people-muted">To transfer ownership, first invite the person who should own this workspace. You become a Maintainer after the transfer.</p> : <form className="general-protection" onSubmit={event => void transfer(event)}>
        <p className="people-muted">The person you choose becomes the Owner. You become a Maintainer. This needs a sign-in from the last five minutes.</p>
        <label className="people-field"><span>New owner</span><select required value={target} onChange={event => setTarget(event.target.value)}><option value="">Select the new owner</option>{candidates.map(item => <option key={item.userId} value={item.userId}>{item.user?.name} · {item.user?.email}</option>)}</select></label>
        <label className="people-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I understand I will no longer be an Owner</label>
        <div className="gf-form-footer"><Button type="submit" variant="destructive" size="base" loading={busy} disabled={!target || !confirmed}>Transfer ownership</Button></div>
        {reauth && <div className="people-reauth" role="alert"><p>Sign in again to continue.</p><Button variant="primary" size="sm" onClick={() => void signInAgain("settings")}>Sign in again</Button></div>}
        {error && <div className="form-error" role="alert">{error}</div>}
      </form>}
    </div>
  </section>;
}

function LeaveCard({ name, onLeft }: { name: string; onLeft: (remaining: { id: string }[]) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function leave() {
    setBusy(true); setError("");
    try { const result = await request<{ workspaces: { id: string }[] }>("/api/access/leave", {}); await onLeft(result.workspaces); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "You could not leave this workspace."); setBusy(false); }
  }
  return <section className="panel">
    <div className="panel-header"><h2>Leave workspace</h2></div>
    <div className="panel-body">
      <p className="people-muted">You lose access to {name} and its repositories. An Owner can invite you again.</p>
      <div className="general-row">{confirming ? <><Button variant="destructive" size="base" loading={busy} onClick={() => void leave()}>Leave {name}</Button><Button variant="ghost" size="base" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button></> : <Button variant="secondary" size="base" onClick={() => setConfirming(true)}>Leave workspace</Button>}</div>
      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
  </section>;
}
