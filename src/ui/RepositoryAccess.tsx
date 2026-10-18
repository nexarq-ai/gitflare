import { useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { PlusIcon } from "@phosphor-icons/react";
import type { AccessSnapshot, Repository } from "../shared/types";
import { repositoryLabel } from "../shared/repository-names";
import { request } from "./api";
import InviteDialog from "./InviteDialog";
import { ROLE_HELP } from "./people-data";
import { demoOf } from "./DemoFeaturePanel";
import "./people-settings.css";

export function repositoryMembers(data: AccessSnapshot, repositoryId: string) {
  return data.members.filter(member => member.role === "Owner" || !member.repositoryIds || member.repositoryIds.includes(repositoryId));
}

export default function RepositoryAccess({ data, repository, repositories, workspaceName, onChanged }: { data: AccessSnapshot; repository: Repository; repositories: Repository[]; workspaceName: string; onChanged: () => Promise<void> }) {
  const [inviting, setInviting] = useState(false);
  const [candidate, setCandidate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const owner = !demoOf(data) && data.role === "Owner";
  const name = repositoryLabel(repository);
  const members = repositoryMembers(data, repository.id);
  const candidates = data.members.filter(member => member.role !== "Owner" && member.repositoryIds && !member.repositoryIds.includes(repository.id));

  async function give() {
    const member = candidates.find(item => item.userId === candidate); if (!member) return;
    setBusy(true); setError(""); setNotice("");
    try { await request("/api/access/membership", { userId: member.userId, repositoryIds: [...(member.repositoryIds ?? []), repository.id] }); setCandidate(""); setNotice(`${member.user?.name ?? "They"} can now see ${name}.`); await onChanged(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Access could not be given."); }
    finally { setBusy(false); }
  }

  return <>
    <div className="page-heading"><div><h1>Access</h1><p>Who can see {name}.</p></div>{owner && <div className="heading-actions"><Button variant="primary" size="base" icon={PlusIcon} onClick={() => setInviting(true)}>Invite to this repository</Button></div>}</div>
    {error && <div className="form-error" role="alert">{error}</div>}
    {notice && <p className="people-notice" role="status">{notice}</p>}
    <section className="panel">
      <div className="panel-header"><h2>People with access</h2><span className="number-tag">{members.length}</span></div>
      <ul className="people-list">{members.map(member => <li key={member.userId}>
        <div><strong>{member.user?.name || member.user?.email || "Workspace member"}{member.userId === data.user.id && <span className="people-tag">You</span>}</strong><small>{member.user?.email ?? ""}</small></div>
        <span className="people-muted">{member.repositoryIds && member.role !== "Owner" ? "Selected repositories" : "Whole workspace"}</span>
        <span className="people-role-text" title={ROLE_HELP[member.role]}>{member.role}</span>
      </li>)}</ul>
      {owner && candidates.length > 0 && <div className="panel-body repository-give">
        <label className="people-field"><span>Give access to someone already in {workspaceName}</span>
          <div className="general-row"><select value={candidate} onChange={event => setCandidate(event.target.value)}><option value="">Select someone</option>{candidates.map(member => <option key={member.userId} value={member.userId}>{member.user?.name ?? member.user?.email} · {member.role}</option>)}</select><Button variant="secondary" size="base" loading={busy} disabled={!candidate} onClick={() => void give()}>Give access</Button></div>
        </label>
      </div>}
      {!owner && <div className="panel-body"><p className="people-muted">Only Owners can change who sees this repository.</p></div>}
    </section>
    {owner && <InviteDialog open={inviting} onClose={() => setInviting(false)} onInvited={onChanged} repositories={repositories} workspaceName={workspaceName} allowOrganization={false} lockedRepositoryId={repository.id} />}
  </>;
}
