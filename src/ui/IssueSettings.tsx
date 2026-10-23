import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { PencilSimpleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { IssueLabelDefinition, Repository, RepositoryBlock } from "../shared/types";
import { request } from "./api";
import { relativeTime } from "./components";
import { useConfirm } from "./ConfirmDialog";
import InfoTip from "./InfoTip";
import { LABEL_SWATCHES, LabelChip } from "./IssueLabels";
import { PageLoading } from "./WorkspaceLoader";
import "./issues.css";

type Draft = { original: string | null; name: string; color: string; description: string };

function Swatches({ value, onChange, disabled }: { value: string; onChange: (color: string) => void; disabled?: boolean }) {
  return <div className="issue-swatches" role="group" aria-label="Colour">
    {LABEL_SWATCHES.map(color => <button key={color} type="button" aria-label={color} aria-pressed={value.toLowerCase() === color} disabled={disabled} style={{ "--swatch": color } as CSSProperties} onClick={() => onChange(color)} />)}
    <input aria-label="Hex colour" maxLength={7} disabled={disabled} value={value} onChange={event => onChange(event.target.value)} />
  </div>;
}

export default function IssueSettings({ repository, canTriage, publicRepositories, onNotify }: { repository: Repository; canTriage: boolean; publicRepositories: boolean; onNotify: (message: string) => void }) {
  const [labels, setLabels] = useState<IssueLabelDefinition[] | null>(null);
  const [blocks, setBlocks] = useState<RepositoryBlock[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirm, confirmDialog] = useConfirm();
  const key = useRef(crypto.randomUUID());
  const base = `/api/repositories/${encodeURIComponent(repository.id)}`;
  const showBlocks = publicRepositories && canTriage && repository.visibility === "public";
  useEffect(() => {
    let active = true;
    request<{ labels: IssueLabelDefinition[] }>(`${base}/issue-labels`).then(value => { if (active) setLabels(value.labels); }).catch(failure => { if (active) { setLabels([]); setError(failure instanceof Error ? failure.message : "Labels could not be loaded."); } });
    if (showBlocks) request<{ blocks: RepositoryBlock[] }>(`${base}/issue-blocks`).then(value => { if (active) setBlocks(value.blocks); }).catch(() => { if (active) setBlocks([]); });
    return () => { active = false; };
  }, [base, showBlocks]);

  async function change(name: string, body: Record<string, unknown>, done?: () => void) {
    setBusy(name); setError("");
    try { setLabels((await request<{ labels: IssueLabelDefinition[] }>(`${base}/issue-labels`, body, key.current)).labels); key.current = crypto.randomUUID(); done?.(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The label could not be saved."); key.current = crypto.randomUUID(); }
    finally { setBusy(""); }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const body = draft.original === null
      ? { action: "create", name: draft.name, color: draft.color.toLowerCase(), description: draft.description }
      : { action: "update", name: draft.original, ...(draft.name !== draft.original ? { newName: draft.name } : {}), color: draft.color.toLowerCase(), description: draft.description };
    void change("save", body, () => { onNotify(draft.original === null ? "Label created." : "Label saved."); setDraft(null); });
  }
  async function remove(label: IssueLabelDefinition) {
    if (!await confirm({ title: `Delete ${label.name}?`, description: "It is removed from every issue that has it.", confirmLabel: "Delete label", tone: "danger" })) return;
    await change(`delete-${label.name}`, { action: "delete", name: label.name }, () => onNotify("Label deleted."));
  }
  async function unblock(block: RepositoryBlock) {
    const who = block.person?.handle ? `@${block.person.handle}` : block.person?.name ?? "this person";
    if (!await confirm({ title: `Unblock ${who}?`, description: "They can read this repository's issues, open issues and comment again.", confirmLabel: "Unblock" })) return;
    setBusy(`unblock-${block.userId}`); setError("");
    try { setBlocks((await request<{ blocks: RepositoryBlock[] }>(`${base}/issue-blocks`, { action: "unblock", userId: block.userId })).blocks); onNotify("Unblocked."); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "This person could not be unblocked."); }
    finally { setBusy(""); }
  }

  if (!labels) return <PageLoading />;
  const validColor = draft ? /^#[0-9a-f]{6}$/i.test(draft.color) : false;
  return <>
    <section className="panel">
      <div className="panel-header"><h2>Labels</h2><InfoTip label="labels">Only people who triage can set labels. Templates add their own labels when someone opens an issue.</InfoTip></div>
      {error && <div className="panel-body"><div className="error-notice" role="alert">{error}</div></div>}
      {labels.length ? <ul className="issue-settings-labels">
        {labels.map(label => draft?.original === label.name ? null : <li key={label.name}>
          <LabelChip name={label.name} definitions={labels} />
          <p>{label.description || " "}</p>
          {canTriage && <div>
            <Button variant="ghost" size="sm" shape="square" icon={PencilSimpleIcon} aria-label={`Edit ${label.name}`} disabled={!!busy} onClick={() => setDraft({ original: label.name, name: label.name, color: label.color, description: label.description })} />
            <Button variant="ghost" size="sm" shape="square" icon={TrashIcon} aria-label={`Delete ${label.name}`} loading={busy === `delete-${label.name}`} disabled={!!busy} onClick={() => void remove(label)} />
          </div>}
        </li>)}
      </ul> : !draft && <div className="panel-body"><p className="issue-muted">No labels yet.</p></div>}
      {draft ? <form className="issue-label-form" onSubmit={save}>
        <div className="form-field"><label htmlFor="label-name">Name</label><Input id="label-name" required maxLength={40} disabled={busy === "save"} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="bug" /></div>
        <div className="form-field"><span className="field-label"><label htmlFor="label-description">Description</label><span className="gf-field-optional">Optional</span></span><Input id="label-description" maxLength={100} disabled={busy === "save"} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} placeholder="Something is broken" /></div>
        <div className="issue-actions"><Button type="button" variant="secondary" disabled={busy === "save"} onClick={() => setDraft(null)}>Cancel</Button><Button type="submit" variant="primary" loading={busy === "save"} disabled={!!busy || !draft.name.trim() || !validColor}>{draft.original === null ? "Create" : "Save"}</Button></div>
        <Swatches value={draft.color} disabled={busy === "save"} onChange={color => setDraft({ ...draft, color })} />
        {draft.name.trim() && validColor && <LabelChip name={draft.name.trim()} definitions={[{ name: draft.name.trim(), color: draft.color, description: "" }]} />}
      </form> : canTriage && <div className="panel-body"><Button variant="secondary" size="base" icon={PlusIcon} disabled={!!busy || labels.length >= 100} onClick={() => setDraft({ original: null, name: "", color: LABEL_SWATCHES[labels.length % LABEL_SWATCHES.length]!, description: "" })}>New label</Button></div>}
    </section>
    {showBlocks && <section className="panel">
      <div className="panel-header"><h2>Blocked people</h2><InfoTip label="blocked people">Blocked accounts see this repository's issues as not found and cannot open issues or comment. Block someone from their issue or comment.</InfoTip></div>
      {!blocks ? <PageLoading /> : blocks.length ? <ul className="issue-blocks">{blocks.map(block => <li key={block.userId}>
        <span><strong>{block.person?.handle ? `@${block.person.handle}` : block.person?.name ?? "Deleted account"}</strong>{block.reason ? `${block.reason} · ` : ""}{relativeTime(block.blockedAt)}</span>
        <Button variant="secondary" size="sm" loading={busy === `unblock-${block.userId}`} disabled={!!busy} onClick={() => void unblock(block)}>Unblock</Button>
      </li>)}</ul> : <div className="panel-body"><p className="issue-muted">No one is blocked.</p></div>}
    </section>}
    {confirmDialog}
  </>;
}
