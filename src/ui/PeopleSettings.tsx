import { useState, type FormEvent, type ReactNode } from "react";
import InfoTip from "./InfoTip";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { CopyIcon, KeyIcon, PlusIcon, UserPlusIcon, UsersThreeIcon, XIcon } from "@phosphor-icons/react";
import type { AccessSnapshot, Repository } from "../shared/types";
import { repositoryLabel } from "../shared/repository-names";
import { request } from "./api";
import InviteDialog from "./InviteDialog";
import RepositoryAccessPopover from "./RepositoryAccessPopover";
import { expiresIn, invitationAccess, INVITE_ROLES, memberAccess, pendingInvitations, repositoryName, ROLE_HELP } from "./people-data";
import DemoFeaturePanel, { demoOf } from "./DemoFeaturePanel";
import type { DemoMarked } from "../shared/demo-features";
import "./people-settings.css";

type Props = { data: AccessSnapshot; repositories: Repository[]; workspaceName: string; selfHosted: boolean; onChanged: () => Promise<void> };

export default function PeopleSettings({ data, repositories, workspaceName, selfHosted, onChanged }: Props) {
  const [inviting, setInviting] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmRemove, setConfirmRemove] = useState("");
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const demo = demoOf(data);
  const owner = !demo && data.role === "Owner";
  const accountSession = "email" in data.user;
  const invitations = owner ? pendingInvitations(data) : [];
  const organization = owner ? data.organization?.members ?? [] : [];
  const organizationIds = new Set(organization.map(item => item.userId));
  const others = data.members.filter(item => item.userId !== data.user.id);
  const alone = others.length === 0 && invitations.length === 0;
  const members = [...data.members].sort((a, b) => (a.userId === data.user.id ? -1 : b.userId === data.user.id ? 1 : 0) || (a.role === "Owner" ? -1 : 0) - (b.role === "Owner" ? -1 : 0) || (a.user?.name ?? "").localeCompare(b.user?.name ?? ""));

  async function act(key: string, action: string, body: Record<string, unknown>, done: string): Promise<boolean> {
    setBusy(key); setError(""); setNotice("");
    try {
      const result = await request<{ token?: string; delivery?: { status: string; message?: string } }>(`/api/access/${action}`, body);
      if (action === "invite-resend" && result.token && result.delivery?.status !== "sent") setSecret({ label: "New invitation link", value: `${window.location.origin}/invite#token=${result.token}` });
      if (action === "credential-create" && result.token) setSecret({ label: "Agent task credential", value: result.token });
      setNotice(action === "invite-resend" && result.delivery?.status !== "sent" ? result.delivery?.message ?? "A new link is ready. Share it privately." : done);
      await onChanged();
      return true;
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The change could not be saved."); return false; }
    finally { setBusy(""); }
  }

  return <>
    <div className="page-heading"><div><h1>People</h1><p>Who can work in {workspaceName} and what they may do.</p></div>
      {owner && <div className="heading-actions">
        {selfHosted && <Button variant="secondary" size="base" icon={UserPlusIcon} onClick={() => setCreatingUser(true)}>Create a user</Button>}
        {!alone && <Button variant="primary" size="base" icon={PlusIcon} onClick={() => setInviting(true)}>Invite people</Button>}
      </div>}
    </div>
    {demo && <DemoFeaturePanel demo={demo} examples={(data as DemoMarked).examples} headingLevel={3} />}
    {error && <div className="form-error" role="alert">{error}</div>}
    {notice && <p className="people-notice" role="status">{notice}</p>}
    {secret && <Secret label={secret.label} value={secret.value} onDismiss={() => setSecret(null)} />}

    {alone && owner ? <section className="panel people-empty">
      <UsersThreeIcon size={28} aria-hidden="true" />
      <div><h2>You are the only member.</h2><p>Invite people to review, land or deploy with you.</p></div>
      <Button variant="primary" size="base" icon={PlusIcon} onClick={() => setInviting(true)}>Invite people</Button>
    </section> : <section className="panel">
      <div className="panel-header"><h2>Members</h2><span className="number-tag">{data.members.length}</span></div>
      <div className="people-table-wrap"><table className="people-table">
        <thead><tr><th scope="col">Person</th><th scope="col">Role<InfoTip label="roles">Viewer reads. Contributor proposes and runs agents. Reviewer approves. Maintainer also lands. Deployer deploys. Owner manages everything.</InfoTip></th><th scope="col">Access<InfoTip label="repository access">All repositories, or only the ones you pick. Someone limited to billing-api does not see the other repositories at all.</InfoTip></th>{owner && <th scope="col"><span className="sr-only">Actions</span></th>}</tr></thead>
        <tbody>{members.map(member => {
          const self = member.userId === data.user.id;
          const name = member.user?.name || member.user?.email || "Workspace member";
          const fromOrganization = organizationIds.has(member.userId);
          const grants = data.grants.filter(grant => grant.subjectType === "user" && grant.subjectId === member.userId);
          const editable = owner && !self && member.role !== "Owner";
          return <tr key={member.userId}>
            <td><div className="people-person"><span className="people-avatar" aria-hidden="true">{initials(name)}</span><div><strong>{name}{self && <span className="people-tag">You</span>}{fromOrganization && <span className="people-tag">All your workspaces</span>}</strong><small>{member.user?.email ?? ""}</small>
              {grants.length > 0 && <small className="people-grants">Also: {grants.map(grant => `${grant.actions.join(", ")} on ${grant.resourceType === "repository" ? repositoryName(repositories, grant.resourceId) : `${grant.resourceType} ${grant.resourceId}`}`).join("; ")}</small>}
            </div></div></td>
            <td>{editable ? <select className="people-role" aria-label={`Role for ${name}`} value={member.role} disabled={!!busy} onChange={event => void act(`role:${member.userId}`, "membership", { userId: member.userId, role: event.target.value }, `${name} is now ${event.target.value}.`)}>{INVITE_ROLES.map(role => <option key={role} value={role}>{role}</option>)}</select> : <span className="people-role-text" title={ROLE_HELP[member.role]}>{member.role}</span>}</td>
            <td>{editable && repositories.length > 0 ? <RepositoryAccessPopover label={memberAccess(member, repositories)} memberName={name} repositoryIds={member.repositoryIds} repositories={repositories} disabled={!!busy} onSave={ids => act(`access:${member.userId}`, "membership", { userId: member.userId, repositoryIds: ids }, `Repository access for ${name} saved.`)} /> : <span className="people-muted">{memberAccess(member, repositories)}</span>}</td>
            {owner && <td className="people-actions">{editable && (confirmRemove === member.userId
              ? <><Button variant="destructive" size="sm" loading={busy === `remove:${member.userId}`} onClick={() => void (fromOrganization ? act(`remove:${member.userId}`, "organization-remove", { userId: member.userId }, `${name} was removed from all your workspaces.`) : act(`remove:${member.userId}`, "membership", { userId: member.userId, role: null }, `${name} was removed.`)).then(() => setConfirmRemove(""))}>{fromOrganization ? "Remove everywhere" : "Remove"}</Button><Button variant="ghost" size="sm" onClick={() => setConfirmRemove("")}>Cancel</Button></>
              : <Button variant="ghost" size="sm" disabled={!!busy} aria-label={`Remove ${name}`} onClick={() => setConfirmRemove(member.userId)}>{fromOrganization ? "Remove everywhere" : "Remove"}</Button>)}</td>}
          </tr>;
        })}</tbody>
      </table></div>
    </section>}

    {invitations.length > 0 && <section className="panel">
      <div className="panel-header"><h2>Waiting to accept</h2><span className="number-tag">{invitations.length}</span></div>
      <div className="people-table-wrap"><table className="people-table">
        <thead><tr><th scope="col">Email</th><th scope="col">Access</th><th scope="col">Role</th><th scope="col">Expires<InfoTip label="invitation expiry">Invitations work once and expire after 24 hours. Resend makes a new link and restarts the 24 hours.</InfoTip></th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{invitations.map(invitation => <tr key={invitation.id}>
          <td><strong className="people-email">{invitation.email}</strong></td>
          <td>{invitationAccess(invitation, repositories)}</td>
          <td>{invitation.role}</td>
          <td><span className="people-muted" title={new Date(invitation.expiresAt).toLocaleString()}>{expiresIn(invitation.expiresAt)}</span></td>
          <td className="people-actions"><Button variant="ghost" size="sm" loading={busy === `resend:${invitation.id}`} disabled={!!busy} onClick={() => void act(`resend:${invitation.id}`, "invite-resend", { id: invitation.id }, `Invitation sent again to ${invitation.email}.`)}>Resend</Button><Button variant="ghost" size="sm" loading={busy === `revoke:${invitation.id}`} disabled={!!busy} onClick={() => void act(`revoke:${invitation.id}`, "invite-revoke", { id: invitation.id }, `Invitation for ${invitation.email} withdrawn.`)}>Revoke</Button></td>
        </tr>)}</tbody>
      </table></div>
    </section>}

    {organization.length > 0 && <section className="panel">
      <div className="panel-header"><h2>In all your workspaces</h2><span className="number-tag">{organization.length}</span></div>
      <div className="panel-body"><p className="people-muted">They join every workspace you own, including new ones, with the role shown.</p></div>
      <ul className="people-list">{organization.map(item => {
        const name = item.user?.name || item.user?.email || "A former member";
        return <li key={item.userId}><div><strong>{name}</strong><small>{item.user?.email ?? ""}</small></div><span className="people-role-text">{item.role}</span><Button variant="ghost" size="sm" loading={busy === `org:${item.userId}`} disabled={!!busy} onClick={() => void act(`org:${item.userId}`, "organization-remove", { userId: item.userId }, `${name} was removed from all your workspaces.`)}>Remove from all</Button></li>;
      })}</ul>
    </section>}

    <TaskCredentials data={data} repositories={repositories} canCreate={owner && accountSession} busy={busy} act={act} />

    <InviteDialog open={inviting} onClose={() => setInviting(false)} onInvited={onChanged} repositories={repositories} workspaceName={workspaceName} allowOrganization={!selfHosted && accountSession} />
    {selfHosted && <CreateUserDialog open={creatingUser} onClose={() => setCreatingUser(false)} onCreated={async message => { setCreatingUser(false); setNotice(message); await onChanged(); }} />}
  </>;
}

function initials(name: string) { return name.split(/\s+/).map(word => word[0]).slice(0, 2).join("").toUpperCase() || "?"; }

function Secret({ label, value, onDismiss }: { label: string; value: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return <div className="people-secret" role="region" aria-label={label}><strong>{label}</strong><p>Copy it now. It is shown once.</p><code>{value}</code><div><Button variant="secondary" size="sm" icon={CopyIcon} onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true)).catch(() => {})}>{copied ? "Copied" : "Copy"}</Button><Button variant="ghost" size="sm" onClick={onDismiss}>Dismiss</Button></div></div>;
}

function TaskCredentials({ data, repositories, canCreate, busy, act }: { data: AccessSnapshot; repositories: Repository[]; canCreate: boolean; busy: string; act: (key: string, action: string, body: Record<string, unknown>, done: string) => Promise<boolean> }) {
  const now = Date.now();
  const credentials = data.credentials.filter(item => !item.revoked && item.expiresAt > now);
  if (!credentials.length && !(canCreate && repositories.length)) return null;
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form);
    const ok = await act("credential", "credential-create", { name: fields.get("name"), repositoryId: fields.get("repositoryId"), actions: fields.getAll("actions"), expiresInSeconds: Number(fields.get("expiresInSeconds")) * 60, maxRequests: Number(fields.get("maxRequests")), maxExecutions: Number(fields.get("maxExecutions")) }, "Credential created.");
    if (ok) form.reset();
  }
  return <details className="panel people-details">
    <summary><KeyIcon size={17} aria-hidden="true" /><span><strong>Agent task credentials</strong><small>Bounded tokens for coding agents. They never carry your permissions.</small></span><span className="number-tag">{credentials.length}</span></summary>
    <div className="panel-body">
      {credentials.length > 0 && <div className="people-table-wrap"><table className="people-table">
        <thead><tr><th scope="col">Name</th><th scope="col">Repository</th><th scope="col">Allows</th><th scope="col">Used</th><th scope="col">Expires</th>{canCreate && <th scope="col"><span className="sr-only">Actions</span></th>}</tr></thead>
        <tbody>{credentials.map(item => <tr key={item.id}><td><strong>{item.name}</strong></td><td>{item.repositoryId ? repositoryName(repositories, item.repositoryId) : "Workspace (read)"}</td><td>{item.actions.join(", ")}</td><td>{item.requests}/{item.maxRequests} requests · {item.executions}/{item.maxExecutions} runs</td><td><span className="people-muted">{expiresIn(item.expiresAt)}</span></td>{canCreate && <td className="people-actions"><Button variant="ghost" size="sm" loading={busy === `cred:${item.id}`} disabled={!!busy} onClick={() => void act(`cred:${item.id}`, "credential-revoke", { id: item.id }, "Credential revoked.")}>Revoke</Button></td>}</tr>)}</tbody>
      </table></div>}
      {canCreate && repositories.length > 0 && <form className="people-credential-form" onSubmit={event => void create(event)}>
        <h3>Create a credential</h3>
        <div className="people-form-grid">
          <Field label="Name"><input name="name" required maxLength={100} /></Field>
          <Field label="Repository"><select name="repositoryId" required>{repositories.map(repo => <option key={repo.id} value={repo.id}>{repositoryLabel(repo)}</option>)}</select></Field>
          <Field label="Expires after (minutes)" tip="The credential stops working after this many minutes, at most 1440 (one day)."><input name="expiresInSeconds" type="number" min="1" max="1440" defaultValue="60" required /></Field>
          <Field label="Request budget" tip="The most API requests the agent can make with it. 100 is enough for most single tasks."><input name="maxRequests" type="number" min="1" max="1000" defaultValue="100" required /></Field>
          <Field label="Agent run budget" tip="How many agent runs it may start. 1 means a single run."><input name="maxExecutions" type="number" min="1" max="10" defaultValue="1" required /></Field>
        </div>
        <fieldset className="people-checks"><legend>Allows<InfoTip label="credential actions">Read lets the agent look at code. Propose changes lets it push a proposal. Run agents lets it start further agent runs.</InfoTip></legend>{[["read", "Read"], ["contribute", "Propose changes"], ["execute", "Run agents"]].map(([value, label]) => <label key={value}><input type="checkbox" name="actions" value={value} defaultChecked={value === "read"} />{label}</label>)}</fieldset>
        <Button type="submit" variant="secondary" size="base" loading={busy === "credential"} disabled={!!busy}>Create credential</Button>
      </form>}
    </div>
  </details>;
}

function Field({ label, tip, children }: { label: string; tip?: string; children: ReactNode }) { return <label className="people-field"><span className="field-label">{label}{tip && <InfoTip label={label}>{tip}</InfoTip>}</span>{children}</label>; }

function CreateUserDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (message: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const fields = new FormData(event.currentTarget); setBusy(true); setError("");
    try { await request("/api/users/create", { name: fields.get("name"), email: fields.get("email"), password: fields.get("password"), role: fields.get("role") }); await onCreated("User created. They set up their authenticator the first time they sign in."); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The user could not be created."); }
    finally { setBusy(false); }
  }
  return <Dialog.Root open={open} onOpenChange={value => { if (!value && !busy) onClose(); }}>
    <Dialog size="lg" className="dialog-content">
      <div className="dialog-title-row"><Dialog.Title className="dialog-title">Create a user</Dialog.Title><Button variant="ghost" size="base" shape="square" icon={XIcon} aria-label="Close dialog" disabled={busy} onClick={onClose} /></div>
      <Dialog.Description className="dialog-description">Share the initial password privately. They enroll their own authenticator at first sign-in.</Dialog.Description>
      <form onSubmit={event => void submit(event)}>
        <div className="people-form-grid">
          <Field label="Name"><input name="name" required maxLength={120} /></Field>
          <Field label="Email"><input name="email" type="email" required /></Field>
          <Field label="Initial password"><input name="password" type="password" required minLength={12} autoComplete="new-password" /></Field>
          <Field label="Role"><select name="role" defaultValue="Contributor">{INVITE_ROLES.map(role => <option key={role}>{role}</option>)}</select></Field>
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="dialog-actions"><Button variant="secondary" size="base" type="button" disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" size="base" type="submit" loading={busy}>Create user</Button></div>
      </form>
    </Dialog>
  </Dialog.Root>;
}
