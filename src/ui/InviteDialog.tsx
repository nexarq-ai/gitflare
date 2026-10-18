import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { CheckCircleIcon, CopyIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import type { Repository } from "../shared/types";
import { repositoryLabel } from "../shared/repository-names";
import { request } from "./api";
import { parseEmails, ROLE_HELP, rolesFor, type InviteScope } from "./people-data";
import "./people-settings.css";

const MAX_EMAILS = 20;
type Outcome = { email: string; sent: boolean; link?: string; message?: string; error?: string };

export default function InviteDialog({ open, onClose, onInvited, repositories, workspaceName, allowOrganization, lockedRepositoryId }: { open: boolean; onClose: () => void; onInvited: () => Promise<void> | void; repositories: Repository[]; workspaceName: string; allowOrganization: boolean; lockedRepositoryId?: string }) {
  const [emails, setEmails] = useState("");
  const [scope, setScope] = useState<InviteScope>("workspace");
  const [repositoryId, setRepositoryId] = useState("");
  const [role, setRole] = useState("Contributor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [copied, setCopied] = useState("");
  const locked = !!lockedRepositoryId;

  useEffect(() => {
    if (!open) return;
    setEmails(""); setError(""); setOutcomes([]); setCopied(""); setRole("Contributor");
    setScope(locked ? "repository" : "workspace");
    setRepositoryId(lockedRepositoryId ?? repositories[0]?.id ?? "");
  }, [open]);

  const roles = rolesFor(scope);
  useEffect(() => { if (!roles.includes(role)) setRole("Contributor"); }, [scope]);
  const list = parseEmails(emails);
  const lockedRepository = repositories.find(repo => repo.id === lockedRepositoryId);

  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    if (!list.length) { setError("Enter at least one email address."); return; }
    if (list.length > MAX_EMAILS) { setError(`Invite up to ${MAX_EMAILS} people at a time.`); return; }
    if (scope === "repository" && !repositoryId) { setError("Choose a repository."); return; }
    setBusy(true); setError("");
    const results: Outcome[] = [];
    for (const email of list) {
      try {
        const result = await request<{ token: string; delivery?: { status: string; message?: string } }>("/api/access/invite", { email, role, scope, ...(scope === "repository" ? { repositoryId } : {}) });
        const sent = result.delivery?.status === "sent";
        results.push({ email, sent, ...(sent ? {} : { link: `${window.location.origin}/invite#token=${result.token}`, message: result.delivery?.message }) });
      } catch (failure) {
        results.push({ email, sent: false, error: failure instanceof Error ? failure.message : "The invitation could not be created." });
      }
    }
    setOutcomes(results); setBusy(false);
    if (results.some(item => !item.error)) await onInvited();
  }

  function copy(link: string) {
    void navigator.clipboard.writeText(link).then(() => setCopied(link)).catch(() => setError("Copy is unavailable here. Select the link and copy it."));
  }

  const target = scope === "organization" ? "every workspace you own" : scope === "repository" ? repositoryLabel(repositories.find(repo => repo.id === repositoryId) ?? { name: "the repository" } as Repository) : workspaceName;

  return <Dialog.Root open={open} onOpenChange={value => { if (!value && !busy) onClose(); }}>
    <Dialog size="lg" className="dialog-content invite-dialog">
      <div className="dialog-title-row"><Dialog.Title className="dialog-title">{locked ? "Invite to this repository" : "Invite people"}</Dialog.Title><Button variant="ghost" size="base" shape="square" icon={XIcon} aria-label="Close dialog" disabled={busy} onClick={onClose} /></div>
      <Dialog.Description className="dialog-description">{locked ? `They see only ${lockedRepository ? repositoryLabel(lockedRepository) : "this repository"} in ${workspaceName}.` : `Each person gets a single-use link that expires in 24 hours.`}</Dialog.Description>
      {outcomes.length ? <div className="invite-outcomes">
        <ul>{outcomes.map(item => <li key={item.email} className={item.error ? "failed" : item.sent ? "sent" : "link"}>
          {item.error ? <WarningCircleIcon size={18} aria-hidden="true" /> : <CheckCircleIcon size={18} aria-hidden="true" />}
          <div><strong>{item.email}</strong>
            {item.error ? <span>{item.error}</span> : item.sent ? <span>Invitation email sent.</span> : <>
              <span>{item.message ?? "No email was sent."} Share this link with them privately. It is shown once.</span>
              <div className="invite-link"><code>{item.link}</code><Button variant="secondary" size="sm" icon={CopyIcon} onClick={() => copy(item.link!)}>{copied === item.link ? "Copied" : "Copy"}</Button></div>
            </>}
          </div>
        </li>)}</ul>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="dialog-actions"><Button variant="secondary" size="base" type="button" onClick={() => { setOutcomes([]); setEmails(""); }}>Invite more</Button><Button variant="primary" size="base" type="button" onClick={onClose}>Done</Button></div>
      </div> : <form onSubmit={event => void submit(event)}>
        <div className="form-field">
          <label htmlFor="invite-emails">Email addresses</label>
          <textarea id="invite-emails" rows={3} required autoFocus value={emails} placeholder="name@example.com, another@example.com" onChange={event => setEmails(event.target.value)} />
          <small>{list.length > 1 ? `${list.length} people. ` : ""}Separate several addresses with commas or new lines, up to {MAX_EMAILS}.</small>
        </div>
        {!locked && <fieldset className="invite-scope">
          <legend>Access</legend>
          {allowOrganization && <label><input type="radio" name="invite-scope" value="organization" checked={scope === "organization"} onChange={() => setScope("organization")} /><span><strong>All my workspaces</strong><small>They join every workspace you own, including ones you create later.</small></span></label>}
          <label><input type="radio" name="invite-scope" value="workspace" checked={scope === "workspace"} onChange={() => setScope("workspace")} /><span><strong>This workspace</strong><small>They see every repository in {workspaceName}.</small></span></label>
          {repositories.length > 0 && <label><input type="radio" name="invite-scope" value="repository" checked={scope === "repository"} onChange={() => setScope("repository")} /><span><strong>One repository</strong><small>They see only this repository.</small></span></label>}
          {scope === "repository" && <select aria-label="Repository" value={repositoryId} onChange={event => setRepositoryId(event.target.value)}>{repositories.map(repo => <option key={repo.id} value={repo.id}>{repositoryLabel(repo)}</option>)}</select>}
        </fieldset>}
        <div className="form-field">
          <label htmlFor="invite-role">Role</label>
          <select id="invite-role" value={role} onChange={event => setRole(event.target.value)}>{roles.map(item => <option key={item} value={item}>{item}</option>)}</select>
          <small>{ROLE_HELP[role]}{scope === "repository" ? " Deployers act on environments, so they are invited to the whole workspace." : ""}</small>
        </div>
        <p className="invite-target">They will join {target} as {role}.</p>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="dialog-actions"><Button variant="secondary" size="base" type="button" disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" size="base" type="submit" loading={busy} disabled={!list.length}>{list.length > 1 ? `Send ${list.length} invitations` : "Send invitation"}</Button></div>
      </form>}
    </Dialog>
  </Dialog.Root>;
}
