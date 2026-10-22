import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import { ArrowLeftIcon, ArrowCounterClockwiseIcon, ChatCircleIcon, LockSimpleIcon, PencilSimpleIcon, PlusIcon, ProhibitIcon, RocketLaunchIcon, ShieldWarningIcon, TrashIcon, UserPlusIcon, XIcon } from "@phosphor-icons/react";
import { ADVISORY_CLOSE_REASONS, ADVISORY_SEVERITIES, ADVISORY_STATES, type AdvisoryCloseReason, type AdvisoryDetail, type AdvisoryList, type AdvisoryState, type ReleaseList, type Repository } from "../shared/types";
import { request, RequestError } from "./api";
import { useConfirm } from "./ConfirmDialog";
import InfoTip from "./InfoTip";
import { navigate } from "./router";
import { PageLoading } from "./WorkspaceLoader";
import { ADVISORY_DESCRIPTION_MAX, ADVISORY_LIST_MAX, ADVISORY_TITLE_MAX, CLOSE_REASON_LABELS, draftErrors, draftFrom, draftPayload, publishBlockers, SEVERITY_LABELS, STATE_LABELS, type AdvisoryDraft } from "./advisory-data";
import { AdvisoryCommentBox, AffectedEditor, AdvisoryFacts, AdvisoryMarkdown, AdvisoryStateBadge, AdvisoryThread, AdvisoryTime, EmptyAdvisories, personName, SeverityPill } from "./advisory-ui";
import "./advisories.css";

type Props = { repository: Repository; advisoryId?: string; canLand: boolean; demo?: boolean; onNotify: (message: string) => void };

function failure(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function Advisories({ repository, advisoryId, canLand, demo = false, onNotify }: Props) {
  const base = `repository/${repository.id}/security`;
  const writable = canLand && !demo;
  if (advisoryId === "new") return writable ? <AdvisoryEditor repository={repository} onCancel={() => navigate(base)} onSaved={saved => { onNotify("Draft advisory saved."); navigate(`${base}/${saved.id}`); }} /> : <div className="error-notice" role="alert">{demo ? "Security advisories are read-only in the shared demo." : "Drafting advisories requires permission to land changes."}</div>;
  if (advisoryId) return <AdvisoryPage key={advisoryId} repository={repository} advisoryId={advisoryId} writable={writable} onNotify={onNotify} />;
  return <AdvisoryIndex repository={repository} writable={writable} />;
}

function AdvisoryIndex({ repository, writable }: { repository: Repository; writable: boolean }) {
  const [list, setList] = useState<AdvisoryList | null>(null);
  const [error, setError] = useState("");
  const [state, setState] = useState<AdvisoryState>("draft");
  const [chosen, setChosen] = useState(false);
  const base = `repository/${repository.id}/security`;

  const load = useCallback(async () => {
    try { setList(await request<AdvisoryList>(`/api/repositories/${repository.id}/advisories`)); setError(""); }
    catch (cause) { setError(failure(cause, "Advisories could not be loaded.")); }
  }, [repository.id]);
  useEffect(() => { void load(); }, [load]);

  const effective = chosen || !list ? state : list.counts.draft ? "draft" : list.counts.published ? "published" : "draft";
  const items = list?.items.filter(item => item.state === effective) ?? [];

  return <section className="advisories">
    <div className="repository-work-heading">
      <div><h2>Security advisories<InfoTip label="security advisories">Drafts and private reports are visible to maintainers and the people they invite. Publishing makes an advisory public on public repositories; the private discussion stays private.</InfoTip></h2><p>Private vulnerability reports and published advisories.</p></div>
      {list?.maintainer && <Button variant="primary" size="base" icon={PlusIcon} disabled={!writable} title={writable ? undefined : "Requires permission to land changes."} onClick={() => navigate(`${base}/new`)}>New draft</Button>}
    </div>
    {error && <div className="error-notice" role="alert">{error} <button type="button" className="text-link" onClick={() => void load()}>Try again</button></div>}
    {!list ? !error && <PageLoading /> : <>
      <div className="repository-work-toolbar">
        <div className="issue-state-toggle" role="group" aria-label="Advisory state">
          {ADVISORY_STATES.map(value => <button key={value} type="button" aria-pressed={effective === value} onClick={() => { setState(value); setChosen(true); }}>{STATE_LABELS[value]} <span className="advisory-count">{list.counts[value] ?? 0}</span></button>)}
        </div>
      </div>
      <section className="panel advisory-list-panel">
        {items.length ? <ul className="advisory-list">{items.map(item => <li key={item.id}>
          <ShieldWarningIcon size={18} className={`advisory-list-icon is-${item.state}`} aria-hidden="true" />
          <div>
            <div className="advisory-list-title"><a href={`/${base}/${item.id}`}>{item.title || "Untitled report"}</a><SeverityPill severity={item.severity} /></div>
            <small>{item.source === "report" ? "Reported" : "Drafted"} <AdvisoryTime value={item.createdAt} />{item.cveId && <> · <code>{item.cveId}</code></>}{item.publishedAt && <> · published <AdvisoryTime value={item.publishedAt} /></>}</small>
          </div>
          {item.commentCount > 0 && <span className="issue-comment-count" title={`${item.commentCount} private ${item.commentCount === 1 ? "message" : "messages"}`}><ChatCircleIcon size={14} aria-hidden="true" />{item.commentCount}</span>}
        </li>)}</ul> : <EmptyAdvisories>{effective === "draft" ? "No drafts or open reports." : effective === "published" ? "No published advisories." : "No closed reports."}</EmptyAdvisories>}
      </section>
    </>}
  </section>;
}

function AdvisoryPage({ repository, advisoryId, writable, onNotify }: { repository: Repository; advisoryId: string; writable: boolean; onNotify: (message: string) => void }) {
  const [advisory, setAdvisory] = useState<AdvisoryDetail | null>(null);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [closing, setClosing] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const base = `repository/${repository.id}/security`;
  const api = `/api/repositories/${repository.id}/advisories/${advisoryId}`;

  const load = useCallback(async () => {
    try { setAdvisory(await request<AdvisoryDetail>(api)); setError(""); }
    catch (cause) { if (cause instanceof RequestError && cause.status === 404) setMissing(true); else setError(failure(cause, "This advisory could not be loaded.")); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const back = <a className="header-back release-back" href={`/${base}`}><ArrowLeftIcon size={13} />All advisories</a>;
  if (missing) return <>{back}<div className="error-notice" role="alert">This advisory doesn't exist, or you don't have access to it.</div></>;
  if (!advisory) return <>{back}{error ? <div className="error-notice" role="alert">{error} <button type="button" className="text-link" onClick={() => void load()}>Try again</button></div> : <PageLoading />}</>;
  if (editing) return <AdvisoryEditor repository={repository} advisory={advisory} onCancel={() => setEditing(false)} onSaved={saved => { setAdvisory(saved); setEditing(false); onNotify("Advisory saved."); }} />;

  const manage = advisory.viewer.maintainer && writable;
  const blockers = publishBlockers(advisory);

  async function act(path: string, body: Record<string, unknown>, done: string) {
    setBusy(path); setActionError("");
    try { setAdvisory(await request<AdvisoryDetail>(`${api}/${path}`, body)); onNotify(done); }
    catch (cause) { setActionError(failure(cause, "The advisory could not be changed.")); }
    finally { setBusy(""); }
  }

  async function publish() {
    if (!advisory) return;
    const ok = await confirm({
      title: "Publish this advisory?",
      description: repository.visibility === "public" ? "The advisory becomes public on the repository's Security page. Publishing can't be undone. The private discussion stays private." : "The advisory becomes visible to everyone who can read this repository. Publishing can't be undone. The private discussion stays private.",
      facts: [{ label: "Title", value: advisory.title }, { label: "Severity", value: advisory.severity ? SEVERITY_LABELS[advisory.severity] : "Unrated" }, ...(advisory.cveId ? [{ label: "CVE", value: advisory.cveId, code: true }] : [])],
      confirmLabel: "Publish advisory",
    });
    if (ok) await act("publish", {}, "Advisory published.");
  }

  const releaseLink = advisory.release ? <a href={`/repository/${repository.id}/releases/${advisory.release.id}`}>{advisory.release.name || advisory.release.tag} <code>{advisory.release.tag}</code></a> : null;

  return <>
    {back}
    <div className="advisory-layout">
      <div className="advisory-main">
        <header className="advisory-header">
          <h2>{advisory.title || "Untitled report"}</h2>
          <div className="advisory-header-meta">
            <AdvisoryStateBadge state={advisory.state} reason={advisory.closeReason} />
            <SeverityPill severity={advisory.severity} />
            <span>{advisory.source === "report" ? <>Reported by <strong>{personName(advisory.reporterId, advisory.people)}</strong></> : <>Drafted by <strong>{personName(advisory.createdBy, advisory.people)}</strong></>} <AdvisoryTime value={advisory.createdAt} /></span>
          </div>
          {manage && <div className="advisory-actions">
            {advisory.state !== "closed" && <Button variant="secondary" size="sm" icon={PencilSimpleIcon} disabled={!!busy} onClick={() => setEditing(true)}>Edit</Button>}
            {advisory.state === "draft" && <>
              <span className="advisory-inline"><Button variant="primary" size="sm" icon={RocketLaunchIcon} loading={busy === "publish"} disabled={!!busy || blockers.length > 0} title={blockers.length ? `Add ${blockers.join(", ")} first.` : undefined} onClick={() => void publish()}>Publish</Button><InfoTip label="publishing">Publishing needs a title, description and severity. On public repositories the advisory appears on the public Security page. The private discussion and collaborators stay private.</InfoTip></span>
              <Button variant="secondary" size="sm" icon={ProhibitIcon} disabled={!!busy} onClick={() => setClosing(true)}>Close</Button>
            </>}
            {advisory.state === "closed" && <Button variant="secondary" size="sm" icon={ArrowCounterClockwiseIcon} loading={busy === "reopen"} disabled={!!busy} onClick={() => void act("reopen", {}, "Advisory reopened.")}>Reopen</Button>}
          </div>}
          {actionError && <div className="error-notice" role="alert">{actionError}</div>}
        </header>
        <section className="panel advisory-body">
          <div className="panel-body">{advisory.description.trim() ? <AdvisoryMarkdown>{advisory.description}</AdvisoryMarkdown> : <p className="advisory-muted">No description.</p>}</div>
          <div className="panel-body advisory-facts-body"><AdvisoryFacts advisory={advisory} release={releaseLink} /></div>
        </section>
        <section className="panel advisory-discussion" aria-labelledby="advisory-discussion-title">
          <div className="panel-header"><h2 id="advisory-discussion-title"><LockSimpleIcon size={15} aria-hidden="true" />Private discussion<InfoTip label="the private discussion">Only maintainers, the reporter and invited collaborators can read this, even after the advisory is published.</InfoTip></h2></div>
          <div className="panel-body">
            <AdvisoryThread comments={advisory.comments} people={advisory.people} reporterId={advisory.reporterId} />
            {advisory.viewer.canComment && advisory.state !== "closed" && <AdvisoryCommentBox onSubmit={async (body, key) => { setAdvisory(await request<AdvisoryDetail>(`${api}/comment`, { body }, key)); }} />}
          </div>
        </section>
      </div>
      <aside className="advisory-sidebar">
        <Collaborators advisory={advisory} api={api} manage={manage && advisory.state !== "closed"} onChanged={setAdvisory} />
        {advisory.publishedAt && <section><h3>Published</h3><p><AdvisoryTime value={advisory.publishedAt} /></p></section>}
        {advisory.closedAt && <section><h3>Closed</h3><p><AdvisoryTime value={advisory.closedAt} />{advisory.closeReason && ` · ${CLOSE_REASON_LABELS[advisory.closeReason]}`}</p></section>}
      </aside>
    </div>
    <CloseDialog open={closing} onClose={() => setClosing(false)} onConfirm={reason => { setClosing(false); void act("close", { reason }, "Advisory closed."); }} />
    {confirmDialog}
  </>;
}

function CloseDialog({ open, onClose, onConfirm }: { open: boolean; onClose: () => void; onConfirm: (reason: AdvisoryCloseReason) => void }) {
  const [reason, setReason] = useState<AdvisoryCloseReason>("not_a_vulnerability");
  return <Dialog.Root open={open} onOpenChange={value => { if (!value) onClose(); }}>
    <Dialog size="sm" className="dialog-content confirm-dialog">
      <Dialog.Title className="dialog-title">Close this report?</Dialog.Title>
      <Dialog.Description className="dialog-description">The reporter is told the reason. You can reopen it later.</Dialog.Description>
      <div className="form-field"><label htmlFor="advisory-close-reason">Reason</label>
        <select id="advisory-close-reason" value={reason} onChange={event => setReason(event.target.value as AdvisoryCloseReason)}>{ADVISORY_CLOSE_REASONS.map(value => <option key={value} value={value}>{CLOSE_REASON_LABELS[value]}</option>)}</select>
      </div>
      <div className="dialog-actions">
        <Button variant="secondary" size="base" type="button" onClick={onClose}>Cancel</Button>
        <Button variant="destructive" size="base" type="button" onClick={() => onConfirm(reason)}>Close report</Button>
      </div>
    </Dialog>
  </Dialog.Root>;
}

function Collaborators({ advisory, api, manage, onChanged }: { advisory: AdvisoryDetail; api: string; manage: boolean; onChanged: (advisory: AdvisoryDetail) => void }) {
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirm, confirmDialog] = useConfirm();

  async function change(body: { action: "add" | "remove"; handle?: string; userId?: string }, marker: string) {
    setBusy(marker); setError("");
    try { onChanged(await request<AdvisoryDetail>(`${api}/collaborators`, body)); if (body.action === "add") setHandle(""); }
    catch (cause) { setError(failure(cause, "Collaborators could not be changed.")); }
    finally { setBusy(""); }
  }

  async function remove(userId: string) {
    const name = personName(userId, advisory.people);
    if (await confirm({ title: `Remove ${name}?`, description: "They lose access to this draft and its private discussion.", confirmLabel: "Remove", tone: "danger" })) await change({ action: "remove", userId }, userId);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = handle.trim().replace(/^@/, "");
    if (value) void change({ action: "add", handle: value }, "add");
  }

  return <section>
    <h3>Collaborators<InfoTip label="advisory collaborators">Invited accounts can read this draft and join the private discussion. They get no other access to the repository.</InfoTip></h3>
    {advisory.collaborators.length ? <ul className="advisory-people">{advisory.collaborators.map(id => <li key={id}><span>{personName(id, advisory.people)}</span>{manage && <button type="button" className="advisory-icon-button" aria-label={`Remove ${personName(id, advisory.people)}`} title="Remove" disabled={!!busy} onClick={() => void remove(id)}><XIcon size={13} /></button>}</li>)}</ul> : <p>None</p>}
    {manage && <form className="advisory-invite" onSubmit={submit}>
      <Input aria-label="Handle to invite" placeholder="@handle" value={handle} maxLength={40} disabled={!!busy} onChange={event => setHandle(event.target.value)} />
      <Button type="submit" variant="secondary" size="sm" icon={UserPlusIcon} loading={busy === "add"} disabled={!!busy || !handle.trim().replace(/^@/, "")}>Invite</Button>
    </form>}
    {error && <p className="release-inline-error" role="alert">{error}</p>}
    {confirmDialog}
  </section>;
}

function ListEditor({ id, label, values, placeholder, onChange, disabled, type = "text" }: { id: string; label: string; values: string[]; placeholder: string; onChange: (values: string[]) => void; disabled: boolean; type?: string }) {
  const rows = values.length ? values : [""];
  return <div className="advisory-list-editor">
    {rows.map((value, index) => <div key={index} className="advisory-list-row">
      <Input id={index === 0 ? id : undefined} aria-label={`${label} ${index + 1}`} type={type} value={value} placeholder={placeholder} maxLength={500} disabled={disabled} onChange={event => onChange(rows.map((item, at) => at === index ? event.target.value : item))} />
      {rows.length > 1 && <button type="button" className="advisory-icon-button" aria-label={`Remove ${label.toLowerCase()} ${index + 1}`} disabled={disabled} onClick={() => onChange(rows.filter((_, at) => at !== index))}><TrashIcon size={14} /></button>}
    </div>)}
    {rows.length < ADVISORY_LIST_MAX && <button type="button" className="text-link" disabled={disabled} onClick={() => onChange([...rows, ""])}>Add another</button>}
  </div>;
}

function AdvisoryEditor({ repository, advisory, onCancel, onSaved }: { repository: Repository; advisory?: AdvisoryDetail; onCancel: () => void; onSaved: (advisory: AdvisoryDetail) => void }) {
  const [draft, setDraft] = useState<AdvisoryDraft>(() => draftFrom(advisory));
  const [releases, setReleases] = useState<ReleaseList["releases"]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [touched, setTouched] = useState(false);
  const key = useRef(crypto.randomUUID());
  const [confirm, confirmDialog] = useConfirm();
  const errors = draftErrors(draft);
  const valid = !Object.keys(errors).length;
  const initial = useRef(JSON.stringify(draftFrom(advisory)));

  useEffect(() => {
    let active = true;
    request<ReleaseList>(`/api/repositories/${repository.id}/releases`).then(list => { if (active) setReleases(list.releases); }, () => {});
    return () => { active = false; };
  }, [repository.id]);

  const set = <K extends keyof AdvisoryDraft>(field: K, value: AdvisoryDraft[K]) => { setDraft(current => ({ ...current, [field]: value })); key.current = crypto.randomUUID(); };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!valid) return;
    setBusy(true); setError("");
    try {
      const path = advisory ? `/api/repositories/${repository.id}/advisories/${advisory.id}/update` : `/api/repositories/${repository.id}/advisories`;
      onSaved(await request<AdvisoryDetail>(path, draftPayload(draft), key.current));
    } catch (cause) { setError(failure(cause, "The advisory could not be saved.")); }
    finally { setBusy(false); }
  }

  async function cancel() {
    if (JSON.stringify(draft) === initial.current || await confirm({ title: "Discard your changes?", description: "What you wrote is not saved.", confirmLabel: "Discard", tone: "danger" })) onCancel();
  }

  const show = (field: keyof typeof errors) => touched || field !== "title" && field !== "description" ? errors[field] : undefined;
  const fieldError = (field: keyof typeof errors) => show(field) ? <small className="release-inline-error" role="alert">{show(field)}</small> : null;

  return <section className="panel advisory-editor" aria-labelledby="advisory-editor-title">
    <div className="panel-header"><h2 id="advisory-editor-title">{advisory ? "Edit advisory" : "New draft advisory"}</h2><InfoTip label="draft advisories">Drafts are private to maintainers and invited collaborators until you publish.</InfoTip></div>
    <form className="panel-body" onSubmit={event => void submit(event)} noValidate>
      <div className="form-field"><label htmlFor="advisory-title">Title</label><Input id="advisory-title" maxLength={ADVISORY_TITLE_MAX} disabled={busy} value={draft.title} placeholder="Path traversal in archive extraction" onChange={event => set("title", event.target.value)} />{fieldError("title")}</div>
      <div className="form-field"><label htmlFor="advisory-description">Description <span className="proposal-optional">(Markdown)</span></label><textarea id="advisory-description" rows={10} maxLength={ADVISORY_DESCRIPTION_MAX} disabled={busy} value={draft.description} placeholder="Impact, affected configurations, how to reproduce, and workarounds." onChange={event => set("description", event.target.value)} />{fieldError("description")}</div>
      <div className="advisory-form-grid">
        <div className="form-field"><label htmlFor="advisory-severity">Severity</label>
          <select id="advisory-severity" disabled={busy} value={draft.severity} onChange={event => set("severity", event.target.value as AdvisoryDraft["severity"])}><option value="">Not rated yet</option>{ADVISORY_SEVERITIES.map(value => <option key={value} value={value}>{SEVERITY_LABELS[value]}</option>)}</select>
        </div>
        <div className="form-field"><label htmlFor="advisory-release">Fixed in <span className="proposal-optional">(optional)</span></label>
          <select id="advisory-release" disabled={busy} value={draft.releaseId} onChange={event => set("releaseId", event.target.value)}><option value="">No checkpoint</option>{releases.map(release => <option key={release.id} value={release.id}>{release.tag}{release.draft ? " (draft)" : ""}</option>)}{draft.releaseId && !releases.some(release => release.id === draft.releaseId) && <option value={draft.releaseId}>{advisory?.release?.tag ?? "Linked checkpoint"}</option>}</select>
        </div>
        <div className="form-field"><label htmlFor="advisory-cve">CVE ID <span className="proposal-optional">(optional)</span></label><Input id="advisory-cve" disabled={busy} value={draft.cveId} placeholder="CVE-2026-12345" maxLength={30} onChange={event => set("cveId", event.target.value)} />{fieldError("cveId")}</div>
        <div className="form-field"><label htmlFor="advisory-cwe">CWE IDs <span className="proposal-optional">(comma-separated)</span></label><Input id="advisory-cwe" disabled={busy} value={draft.cweIds} placeholder="CWE-22, CWE-79" maxLength={200} onChange={event => set("cweIds", event.target.value)} />{fieldError("cweIds")}</div>
      </div>
      <div className="form-field"><label htmlFor="advisory-cvss">CVSS vector <span className="proposal-optional">(optional)</span><InfoTip label="CVSS vectors">Paste a CVSS 3.1 or 4.0 vector string. Gitflare stores it as written and does not compute a score.</InfoTip></label><Input id="advisory-cvss" disabled={busy} value={draft.cvssVector} placeholder="CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" maxLength={200} onChange={event => set("cvssVector", event.target.value)} />{fieldError("cvssVector")}</div>
      <AffectedEditor rows={draft.affected} disabled={busy} onChange={rows => set("affected", rows)} />
      {fieldError("affected")}
      <div className="form-field"><label htmlFor="advisory-reference">References <span className="proposal-optional">(https links)</span></label><ListEditor id="advisory-reference" label="Reference" type="url" values={draft.references} placeholder="https://" disabled={busy} onChange={values => set("references", values)} />{fieldError("references")}</div>
      <div className="form-field"><label htmlFor="advisory-credit">Credits <span className="proposal-optional">(names)</span></label><ListEditor id="advisory-credit" label="Credit" values={draft.credits} placeholder="Name of the finder" disabled={busy} onChange={values => set("credits", values)} />{fieldError("credits")}</div>
      {error && <div className="error-notice" role="alert">{error}</div>}
      <div className="release-form-footer">
        <Button type="button" variant="secondary" size="base" disabled={busy} onClick={() => void cancel()}>Cancel</Button>
        <Button type="submit" variant="primary" size="base" loading={busy} disabled={busy || (touched && !valid)}>{advisory ? "Save changes" : "Save draft"}</Button>
      </div>
    </form>
    {confirmDialog}
  </section>;
}
