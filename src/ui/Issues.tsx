import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { ArrowLeftIcon, ChatCircleIcon, CheckCircleIcon, CircleIcon, EyeSlashIcon, FileTextIcon, GitBranchIcon, LockSimpleIcon, LockSimpleOpenIcon, PlusIcon, ProhibitIcon, SparkleIcon, UserMinusIcon } from "@phosphor-icons/react";
import { ISSUE_HIDE_REASONS, ISSUE_LOCK_REASONS, type AccessSnapshot, type IssueCloseReason, type IssueDetail, type IssueLabelDefinition, type IssueList, type IssuePerson, type IssueTemplate, type IssueTemplates, type MissionSummary, type Repository } from "../shared/types";
import { request, RequestError } from "./api";
import { BranchCreated, createBranch } from "./BranchProtection";
import { EmptyState, relativeTime } from "./components";
import { useConfirm } from "./ConfirmDialog";
import InfoTip from "./InfoTip";
import SubscribeButton from "./SubscribeButton";
import TriageSuggestionPanel from "./TriageSuggestion";
import { ImportedFrom, Labels, personLabel, ReasonDialog } from "./IssueLabels";
import { navigate } from "./router";
import { RouteProgress } from "./WorkspaceLoader";

interface Viewer { userId: string; permissions: string[]; names: Map<string, string> }

function SafeMarkdown({ children }: { children: string }) {
  return <div className="documentation-markdown issue-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span>{alt || "Image"}</span>, a: ({ href, children }) => href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span> }}>{children}</Markdown></div>;
}

function StateBadge({ state, reason }: { state: string; reason?: IssueCloseReason }) {
  const Icon = state === "open" ? CircleIcon : reason === "not_planned" ? ProhibitIcon : CheckCircleIcon;
  return <span className={`issue-state ${state === "open" ? "open" : reason === "not_planned" ? "not-planned" : "closed"}`}><Icon size={14} weight="bold" />{state === "open" ? "Open" : reason === "not_planned" ? "Closed as not planned" : "Closed"}</span>;
}

const reasonLabel = (value: string) => value.replace(/-/g, " ");
const issueBranchName = (number: number, title: string) => `issue-${number}${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "").replace(/^(.)/, "-$1")}`;
const splitLabels = (value: string) => value.split(",").map((label) => label.trim()).filter(Boolean);

export default function Issues({ repository, issueNumber, missions = [] }: { repository: Repository; issueNumber?: string; missions?: MissionSummary[] }) {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  useEffect(() => {
    let active = true;
    request<AccessSnapshot>("/api/access").then((access) => {
      if (active) setViewer({ userId: access.user.id, permissions: access.permissions, names: new Map([[access.user.id, access.user.name], ...access.members.map((member) => [member.userId, member.user?.name ?? member.userId.slice(0, 8)] as [string, string])]) });
    }).catch(() => { if (active) setViewer({ userId: "", permissions: ["read"], names: new Map() }); });
    return () => { active = false; };
  }, []);
  if (!viewer) return <RouteProgress />;
  const base = `repository/${repository.id}/issues`;
  if (issueNumber === "new") return <NewIssue repository={repository} viewer={viewer} base={base} />;
  if (issueNumber) return <IssueView key={issueNumber} repository={repository} number={issueNumber} viewer={viewer} base={base} missions={missions} />;
  return <IssueIndex repository={repository} viewer={viewer} base={base} />;
}

function IssueIndex({ repository, viewer, base }: { repository: Repository; viewer: Viewer; base: string }) {
  const [state, setState] = useState<"open" | "closed">("open");
  const [label, setLabel] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<IssueList | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  const load = useCallback(async (offset = 0) => {
    const params = new URLSearchParams({ state, offset: String(offset) });
    if (label) params.set("label", label);
    if (query) params.set("q", query);
    try {
      const page = await request<IssueList>(`/api/repositories/${encodeURIComponent(repository.id)}/issues?${params}`);
      setData((current) => offset && current ? { ...page, items: [...current.items, ...page.items], people: { ...current.people, ...page.people } } : page);
      setError("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Issues could not be loaded."); }
  }, [repository.id, state, label, query]);
  useEffect(() => { setData(null); void load(); }, [load]);
  const canCreate = viewer.permissions.includes("participate");
  const name = (id: string) => personLabel(id, data?.people, viewer.names, viewer.userId);
  return (
    <>
      <div className="repository-work-heading">
        <div><h2>Issues</h2><p>Track bugs, ideas and follow-up work for this repository.</p></div>
        <Button variant="primary" size="base" icon={PlusIcon} disabled={!canCreate} onClick={() => navigate(`${base}/new`)}>New issue</Button>
      </div>
      <div className="repository-work-toolbar issue-toolbar">
        <div className="issue-state-toggle" role="group" aria-label="Issue state">
          <button type="button" aria-pressed={state === "open"} onClick={() => setState("open")}><CircleIcon size={14} />{data ? `${data.openCount} open` : "Open"}</button>
          <button type="button" aria-pressed={state === "closed"} onClick={() => setState("closed")}><CheckCircleIcon size={14} />{data ? `${data.closedCount} closed` : "Closed"}</button>
        </div>
        <input aria-label="Search issues" placeholder="Search titles and descriptions…" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={200} />
        <select aria-label="Filter issues by label" value={label} onChange={(event) => setLabel(event.target.value)}>
          <option value="">All labels</option>
          {data?.labels.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </div>
      {error && <div className="error-notice" role="alert">{error}</div>}
      {!data ? <RouteProgress /> : (
        <section className="panel">
          {!data.items.length ? (
            <EmptyState icon={<ChatCircleIcon size={25} />} title={query || label ? "No matching issues" : state === "open" ? "No open issues" : "No closed issues"} description={query || label ? "Try another search or label." : "Issues record work to do. Open one to describe a bug or an idea."} action={query || label ? <Button onClick={() => { setSearch(""); setLabel(""); }}>Clear filters</Button> : canCreate ? <Button onClick={() => navigate(`${base}/new`)}>New issue</Button> : undefined} />
          ) : (
            <ul className="issue-list">
              {data.items.map((issue) => (
                <li key={issue.number}>
                  <StateIcon state={issue.state} reason={issue.closedReason} />
                  <div>
                    <a className="issue-title" href={`/${base}/${issue.number}`}>{issue.title}</a>
                    <Labels labels={issue.labels} definitions={data.labelDefinitions} />
                    {issue.locked && <LockSimpleIcon className="issue-locked-icon" size={13} aria-label="Locked" />}
                    <small>#{issue.number} opened {relativeTime(issue.createdAt)} by {name(issue.authorId)}{issue.assignees.length ? ` · Assigned to ${issue.assignees.map(name).join(", ")}` : ""}</small>
                  </div>
                  {issue.commentCount > 0 && <span className="issue-comment-count" aria-label={`${issue.commentCount} comments`}><ChatCircleIcon size={15} />{issue.commentCount}</span>}
                </li>
              ))}
            </ul>
          )}
          {data.nextOffset !== null && <div className="issue-more"><Button variant="secondary" onClick={() => void load(data.nextOffset ?? 0)}>Show more issues</Button></div>}
        </section>
      )}
    </>
  );
}

function StateIcon({ state, reason }: { state: string; reason?: IssueCloseReason }) {
  return <span className={`issue-state-icon ${state === "open" ? "open" : reason === "not_planned" ? "not-planned" : "closed"}`} aria-label={state === "open" ? "Open" : "Closed"}>{state === "open" ? <CircleIcon size={17} weight="bold" /> : reason === "not_planned" ? <ProhibitIcon size={17} weight="bold" /> : <CheckCircleIcon size={17} weight="bold" />}</span>;
}

function useLabelDefinitions(repositoryId: string) {
  const [definitions, setDefinitions] = useState<IssueLabelDefinition[]>([]);
  useEffect(() => {
    let active = true;
    request<{ labels: IssueLabelDefinition[] }>(`/api/repositories/${encodeURIComponent(repositoryId)}/issue-labels`).then((value) => { if (active) setDefinitions(value.labels); }).catch(() => {});
    return () => { active = false; };
  }, [repositoryId]);
  return definitions;
}

function LabelPicker({ id, value, definitions, disabled, onChange }: { id: string; value: string[]; definitions: IssueLabelDefinition[]; disabled?: boolean; onChange: (labels: string[]) => void }) {
  const [text, setText] = useState(value.join(", "));
  if (!definitions.length) return <Input id={id} aria-label="Labels, comma separated" maxLength={450} disabled={disabled} value={text} onChange={(event) => { setText(event.target.value); onChange(splitLabels(event.target.value)); }} placeholder="bug, checkout" />;
  const extra = value.filter((label) => !definitions.some((item) => item.name.toLowerCase() === label.toLowerCase()));
  const toggle = (name: string) => onChange(value.some((label) => label.toLowerCase() === name.toLowerCase()) ? value.filter((label) => label.toLowerCase() !== name.toLowerCase()) : [...value, name].slice(0, 10));
  return <div className="issue-label-picker" id={id} role="group" aria-label="Labels">
    {[...definitions.map((item) => item.name), ...extra].map((name) => {
      const selected = value.some((label) => label.toLowerCase() === name.toLowerCase());
      return <button key={name} type="button" aria-pressed={selected} disabled={disabled || (!selected && value.length >= 10)} onClick={() => toggle(name)}><Labels labels={[name]} definitions={definitions} /></button>;
    })}
  </div>;
}

function TemplateChooser({ templates, onChoose }: { templates: IssueTemplate[]; onChoose: (template: IssueTemplate | null) => void }) {
  return <ul className="issue-templates">
    {templates.map((template) => <li key={template.file}><button type="button" onClick={() => onChoose(template)}><FileTextIcon size={18} aria-hidden="true" /><span><strong>{template.name}</strong>{template.about && <small>{template.about}</small>}</span></button></li>)}
    <li><button type="button" onClick={() => onChoose(null)}><PlusIcon size={18} aria-hidden="true" /><span><strong>Blank issue</strong><small>Start from an empty description.</small></span></button></li>
  </ul>;
}

function NewIssue({ repository, viewer, base }: { repository: Repository; viewer: Viewer; base: string }) {
  const [templates, setTemplates] = useState<IssueTemplates | null>(null);
  const [template, setTemplate] = useState<IssueTemplate | null | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(crypto.randomUUID());
  const canModerate = viewer.permissions.includes("triage");
  const definitions = useLabelDefinitions(repository.id);
  useEffect(() => {
    let active = true;
    request<IssueTemplates>(`/api/repositories/${encodeURIComponent(repository.id)}/issue-templates`).then((value) => { if (active) { setTemplates(value); if (!value.templates.length) setTemplate(null); } }).catch(() => { if (active) { setTemplates({ directory: null, commitSha: null, templates: [] }); setTemplate(null); } });
    return () => { active = false; };
  }, [repository.id]);
  function choose(next: IssueTemplate | null) { setTemplate(next); setTitle(next?.title ?? ""); setBody(next?.body ?? ""); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const issue = await request<IssueDetail>(`/api/repositories/${encodeURIComponent(repository.id)}/issues`, { title, body, ...(template ? { template: template.file } : {}), ...(canModerate && labels.length ? { labels } : {}) }, key.current);
      navigate(`${base}/${issue.number}`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The issue could not be created."); key.current = crypto.randomUUID(); }
    finally { setBusy(false); }
  }
  if (!templates || template === undefined) return <div className="issue-new">
    <a className="header-back" href={`/${base}`}><ArrowLeftIcon size={13} />All issues</a>
    {!templates ? <RouteProgress /> : <section className="panel"><div className="panel-header"><h2>New issue</h2><InfoTip label="issue templates">Templates come from {templates.directory} on {repository.defaultBranch}.</InfoTip></div><TemplateChooser templates={templates.templates} onChoose={choose} /></section>}
  </div>;
  return (
    <form className="issue-new" onSubmit={(event) => void submit(event)}>
      <a className="header-back" href={`/${base}`}><ArrowLeftIcon size={13} />All issues</a>
      <section className="panel">
        <div className="panel-header"><h2>{template ? template.name : "New issue"}</h2>{templates.templates.length > 0 && <button type="button" className="text-link" disabled={busy} onClick={() => setTemplate(undefined)}>Change template</button>}</div>
        <div className="panel-body">
          <div className="form-field"><label htmlFor="issue-title">Title</label><Input id="issue-title" required maxLength={200} disabled={busy} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Checkout fails when the payment is retried" /></div>
          <div className="form-field"><label htmlFor="issue-body">Description <span className="proposal-optional">(Markdown, optional)</span></label><textarea id="issue-body" rows={8} maxLength={20000} disabled={busy} value={body} onChange={(event) => setBody(event.target.value)} placeholder="What happened, what you expected, and how to reproduce it…" /></div>
          {template && template.labels.length > 0 && <p className="issue-muted">Adds <Labels labels={template.labels} definitions={definitions} /></p>}
          {canModerate && <div className="form-field"><label htmlFor="issue-labels">Labels <span className="proposal-optional">(optional)</span></label><LabelPicker id="issue-labels" value={labels} definitions={definitions} disabled={busy} onChange={setLabels} /></div>}
          {error && <div className="error-notice" role="alert">{error}</div>}
          <div className="issue-actions"><Button type="button" variant="secondary" disabled={busy} onClick={() => navigate(base)}>Cancel</Button><Button type="submit" variant="primary" loading={busy} disabled={busy || !title.trim()}>Create issue</Button></div>
        </div>
      </section>
    </form>
  );
}

function IssueView({ repository, number, viewer, base, missions }: { repository: Repository; number: string; viewer: Viewer; base: string; missions: MissionSummary[] }) {
  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [people, setPeople] = useState<Record<string, IssuePerson>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [comment, setComment] = useState("");
  const [editing, setEditing] = useState<{ title: string; body: string } | null>(null);
  const [editingComment, setEditingComment] = useState<{ id: string; body: string } | null>(null);
  const [labels, setLabels] = useState<string[] | null>(null);
  const [reason, setReason] = useState<IssueCloseReason>("completed");
  const [createdBranch, setCreatedBranch] = useState("");
  const [locking, setLocking] = useState(false);
  const [hiding, setHiding] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [blocked, setBlocked] = useState<Set<string>>(new Set());
  const [confirm, confirmDialog] = useConfirm();
  const definitions = useLabelDefinitions(repository.id);
  const branchKey = useRef(crypto.randomUUID());
  const path = `/api/repositories/${encodeURIComponent(repository.id)}/issues/${encodeURIComponent(number)}`;
  const show = (value: IssueDetail) => { setIssue(value); if (value.people) setPeople((current) => ({ ...current, ...value.people })); };
  useEffect(() => {
    let active = true;
    request<IssueDetail>(path).then((value) => { if (active) show(value); }).catch((failure) => { if (active) setError(failure instanceof Error ? failure.message : "This issue could not be loaded."); });
    return () => { active = false; };
  }, [path]);
  async function act(name: string, action: string, body: Record<string, unknown>, done?: () => void) {
    setBusy(name); setError("");
    try { show(await request<IssueDetail>(`${path}/${action}`, body)); done?.(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The issue could not be updated."); }
    finally { setBusy(""); }
  }
  async function branch() {
    if (!issue) return;
    const name = issueBranchName(issue.number, issue.title);
    setBusy("branch"); setError("");
    try { await createBranch(repository.id, name, undefined, branchKey.current); setCreatedBranch(name); }
    catch (failure) { if (failure instanceof RequestError && failure.code === "BRANCH_EXISTS") setCreatedBranch(name); else setError(failure instanceof Error ? failure.message : "The stream could not be created."); }
    finally { setBusy(""); }
  }
  async function block(userId: string) {
    const label = personLabel(userId, people, viewer.names);
    if (!await confirm({ title: `Block ${label}?`, description: "They will see this repository's issues as not found and cannot open issues or comment. Unblock them in Settings → Issues.", confirmLabel: "Block", tone: "danger" })) return;
    setBusy("block"); setError("");
    try { await request(`/api/repositories/${encodeURIComponent(repository.id)}/issue-blocks`, { action: "block", userId }); setBlocked((current) => new Set(current).add(userId)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "This person could not be blocked."); }
    finally { setBusy(""); }
  }
  if (!issue) return error ? <><a className="header-back" href={`/${base}`}><ArrowLeftIcon size={13} />All issues</a><div className="error-notice" role="alert">{error}</div></> : <RouteProgress />;
  const canModerate = viewer.permissions.includes("triage");
  const canContribute = viewer.permissions.includes("contribute");
  const canParticipate = viewer.permissions.includes("participate");
  const canComment = canParticipate && (!issue.locked || canModerate);
  const canEdit = canModerate || (canParticipate && !issue.locked && issue.authorId === viewer.userId);
  const name = (id: string) => personLabel(id, people, viewer.names, viewer.userId);
  const outsider = (id: string) => id !== "gitflare" && !id.startsWith("github:") && id !== viewer.userId && !viewer.names.has(id);
  return (
    <div className="issue-detail">
      <a className="header-back" href={`/${base}`}><ArrowLeftIcon size={13} />All issues</a>
      {editing ? (
        <form className="panel issue-edit" onSubmit={(event) => { event.preventDefault(); void act("edit", "update", { title: editing.title, body: editing.body }, () => setEditing(null)); }}>
          <div className="panel-body">
            <div className="form-field"><label htmlFor="issue-edit-title">Title</label><Input id="issue-edit-title" required maxLength={200} value={editing.title} onChange={(event) => setEditing({ ...editing, title: event.target.value })} /></div>
            <div className="form-field"><label htmlFor="issue-edit-body">Description</label><textarea id="issue-edit-body" rows={10} maxLength={20000} value={editing.body} onChange={(event) => setEditing({ ...editing, body: event.target.value })} /></div>
            <div className="issue-actions"><Button type="button" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" variant="primary" loading={busy === "edit"} disabled={!!busy || !editing.title.trim()}>Save</Button></div>
          </div>
        </form>
      ) : (
        <div className="issue-header">
          <div><h2>{issue.title} <span>#{issue.number}</span></h2><p><StateBadge state={issue.state} reason={issue.closedReason} />{issue.locked && <span className="issue-locked"><LockSimpleIcon size={13} weight="bold" />Locked · {reasonLabel(issue.locked.reason)}</span>} {name(issue.authorId)} opened this issue {relativeTime(issue.createdAt)} · {issue.commentCount} {issue.commentCount === 1 ? "comment" : "comments"} <ImportedFrom source={issue.importedFrom} /></p></div>
          <div className="issue-header-actions">
            <SubscribeButton target={{ kind: "issue", repositoryId: repository.id, number: issue.number }} />
            {canContribute && issue.state === "open" && <Button className="ai-only" variant="primary" size="base" icon={SparkleIcon} onClick={() => navigate(`repository/${repository.id}/proposals/new?issue=${issue.number}`)}>Fix with AI</Button>}
            {canContribute && issue.state === "open" && <Button variant="secondary" size="base" icon={GitBranchIcon} loading={busy === "branch"} disabled={!!busy} onClick={() => void branch()}>Create stream</Button>}
            {canEdit && <Button variant="secondary" size="base" onClick={() => setEditing({ title: issue.title, body: issue.body })}>Edit</Button>}
            {canModerate && (issue.locked
              ? <Button variant="secondary" size="base" icon={LockSimpleOpenIcon} loading={busy === "unlock"} disabled={!!busy} onClick={() => void act("unlock", "unlock", {})}>Unlock</Button>
              : <Button variant="secondary" size="base" icon={LockSimpleIcon} disabled={!!busy} onClick={() => setLocking(true)}>Lock</Button>)}
          </div>
        </div>
      )}
      {error && <div className="error-notice" role="alert">{error}</div>}
      {createdBranch && <BranchCreated repositoryId={repository.id} name={createdBranch} onDismiss={() => setCreatedBranch("")} />}
      {canModerate && repository.visibility === "public" && <TriageSuggestionPanel key={issue.number} repositoryId={repository.id} number={issue.number} onAccepted={show} />}
      <div className="issue-layout">
        <div className="issue-thread">
          <article className="panel issue-comment">
            <header><strong>{name(issue.authorId)}</strong> <small>{new Date(issue.createdAt).toLocaleString()}</small>{canModerate && outsider(issue.authorId) && !blocked.has(issue.authorId) && <button type="button" className="text-link" disabled={!!busy} onClick={() => void block(issue.authorId)}><UserMinusIcon size={13} />Block</button>}</header>
            <div className="panel-body">{issue.body.trim() ? <SafeMarkdown>{issue.body}</SafeMarkdown> : <p className="issue-muted">No description provided.</p>}</div>
          </article>
          {issue.comments.map((item) => {
            const hidden = !!item.hidden && !revealed.has(item.id);
            return (
              <article className={`panel issue-comment${item.hidden ? " issue-comment-hidden" : ""}`} key={item.id}>
                <header>
                  <strong>{name(item.authorId)}</strong> <small>{new Date(item.createdAt).toLocaleString()}{item.editedAt ? " · edited" : ""}</small> <ImportedFrom source={item.importedFrom} />
                  {item.hidden && <span className="issue-hidden-tag"><EyeSlashIcon size={13} />Hidden · {reasonLabel(item.hidden.reason)}</span>}
                  <span className="issue-comment-actions">
                    {item.hidden && canModerate && <button type="button" className="text-link" onClick={() => setRevealed((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })}>{hidden ? "Show" : "Collapse"}</button>}
                    {item.authorId === viewer.userId && canComment && !item.hidden && editingComment?.id !== item.id && <button type="button" className="text-link" onClick={() => setEditingComment({ id: item.id, body: item.body })}>Edit</button>}
                    {canModerate && item.authorId !== "gitflare" && (item.hidden
                      ? <button type="button" className="text-link" disabled={!!busy} onClick={() => void act("unhide", "unhide", { commentId: item.id })}>Unhide</button>
                      : <button type="button" className="text-link" disabled={!!busy} onClick={() => setHiding(item.id)}>Hide</button>)}
                    {canModerate && outsider(item.authorId) && !blocked.has(item.authorId) && <button type="button" className="text-link" disabled={!!busy} onClick={() => void block(item.authorId)}>Block</button>}
                  </span>
                </header>
                {!hidden && <div className="panel-body">
                  {editingComment?.id === item.id ? (
                    <form onSubmit={(event) => { event.preventDefault(); void act("comment-edit", "comment", { body: editingComment.body, commentId: item.id }, () => setEditingComment(null)); }}>
                      <div className="form-field"><label htmlFor={`issue-comment-${item.id}`}>Edit comment</label><textarea id={`issue-comment-${item.id}`} required maxLength={10000} value={editingComment.body} onChange={(event) => setEditingComment({ id: item.id, body: event.target.value })} /></div>
                      <div className="issue-actions"><Button type="button" variant="secondary" onClick={() => setEditingComment(null)}>Cancel</Button><Button type="submit" variant="primary" loading={busy === "comment-edit"} disabled={!!busy || !editingComment.body.trim()}>Save</Button></div>
                    </form>
                  ) : <SafeMarkdown>{item.body}</SafeMarkdown>}
                </div>}
              </article>
            );
          })}
          {issue.state === "closed" && issue.closedAt && <p className="issue-event"><StateBadge state="closed" reason={issue.closedReason} /> {relativeTime(issue.closedAt)}</p>}
          {canComment ? (
            <form className="panel issue-reply" onSubmit={(event) => { event.preventDefault(); void act("comment", "comment", { body: comment }, () => setComment("")); }}>
              <div className="panel-body">
                <div className="form-field"><label htmlFor="issue-reply">Add a comment <span className="proposal-optional">(Markdown)</span></label><textarea id="issue-reply" required maxLength={10000} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Share context, findings or next steps…" /></div>
                <div className="issue-actions">
                  {canModerate && (issue.state === "open" ? <>
                    <select aria-label="Close reason" value={reason} onChange={(event) => setReason(event.target.value as IssueCloseReason)}><option value="completed">Completed</option><option value="not_planned">Not planned</option></select>
                    <Button type="button" variant="secondary" loading={busy === "close"} disabled={!!busy} onClick={() => void act("close", "close", { reason })}>Close issue</Button>
                  </> : <Button type="button" variant="secondary" loading={busy === "reopen"} disabled={!!busy} onClick={() => void act("reopen", "reopen", {})}>Reopen issue</Button>)}
                  <Button type="submit" variant="primary" loading={busy === "comment"} disabled={!!busy || !comment.trim()}>Comment</Button>
                </div>
              </div>
            </form>
          ) : issue.locked ? <p className="issue-muted issue-locked-note"><LockSimpleIcon size={14} />Locked · {reasonLabel(issue.locked.reason)}<InfoTip label="locked issues">Only people who triage this repository can comment.</InfoTip></p>
            : <p className="issue-muted">Your role can read this issue but cannot comment.</p>}
        </div>
        <aside className="issue-sidebar">
          <section>
            <h3>Assignees</h3>
            {canModerate ? (
              <ul className="issue-assignees">{[...viewer.names].map(([id, label]) => <li key={id}><label><input type="checkbox" disabled={!!busy || (!issue.assignees.includes(id) && issue.assignees.length >= 10)} checked={issue.assignees.includes(id)} onChange={(event) => void act("assignees", "update", { assignees: event.target.checked ? [...issue.assignees, id] : issue.assignees.filter((item) => item !== id) })} />{label}</label></li>)}</ul>
            ) : <p>{issue.assignees.length ? issue.assignees.map(name).join(", ") : "No one assigned"}</p>}
          </section>
          <section>
            <h3>Labels</h3>
            {labels !== null ? (
              <form onSubmit={(event) => { event.preventDefault(); void act("labels", "update", { labels }, () => setLabels(null)); }}>
                <LabelPicker id="issue-edit-labels" value={labels} definitions={definitions} disabled={!!busy} onChange={setLabels} />
                <div className="issue-actions"><Button type="button" variant="secondary" size="sm" onClick={() => setLabels(null)}>Cancel</Button><Button type="submit" variant="primary" size="sm" loading={busy === "labels"} disabled={!!busy}>Save</Button></div>
              </form>
            ) : <>{issue.labels.length ? <Labels labels={issue.labels} definitions={definitions} /> : <p>None yet</p>}{canModerate && <button type="button" className="text-link" onClick={() => setLabels(issue.labels)}>Edit labels</button>}</>}
          </section>
          <section>
            <h3>Linked missions</h3>
            {issue.missionIds.length ? <ul className="issue-missions">{issue.missionIds.map((id) => <li key={id}><a href={`/mission/${id}`}>{missions.find((mission) => mission.id === id)?.title ?? id.slice(0, 8)}</a>{canEdit && <button type="button" className="text-link" disabled={!!busy} aria-label="Unlink mission" onClick={() => void act("missions", "update", { missionIds: issue.missionIds.filter((item) => item !== id) })}>Unlink</button>}</li>)}</ul> : <p>None yet</p>}
            {canEdit && missions.some((mission) => !issue.missionIds.includes(mission.id)) && issue.missionIds.length < 20 && <select aria-label="Link a mission" value="" disabled={!!busy} onChange={(event) => { if (event.target.value) void act("missions", "update", { missionIds: [...issue.missionIds, event.target.value] }); }}><option value="">Link a mission…</option>{missions.filter((mission) => !issue.missionIds.includes(mission.id)).map((mission) => <option key={mission.id} value={mission.id}>{mission.title}</option>)}</select>}
          </section>
        </aside>
      </div>
      <ReasonDialog open={locking} title="Lock this issue?" description="Only people who triage this repository can comment or edit until it is unlocked." reasons={ISSUE_LOCK_REASONS} confirmLabel="Lock issue" busy={busy === "lock"} onCancel={() => setLocking(false)} onConfirm={(value) => void act("lock", "lock", { reason: value }, () => setLocking(false))} />
      <ReasonDialog open={hiding !== null} title="Hide this comment?" description="Readers see only that it was hidden and why. You can unhide it later." reasons={ISSUE_HIDE_REASONS} confirmLabel="Hide comment" tone="danger" busy={busy === "hide"} onCancel={() => setHiding(null)} onConfirm={(value) => void act("hide", "hide", { commentId: hiding, reason: value }, () => setHiding(null))} />
      {confirmDialog}
    </div>
  );
}
