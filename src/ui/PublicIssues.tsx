import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { ArrowLeftIcon, ChatCircleIcon, CheckCircleIcon, CircleDashedIcon, CircleIcon, EyeSlashIcon, FileTextIcon, FlagIcon, LockSimpleIcon, MagnifyingGlassIcon, PencilSimpleIcon, PlusIcon, ProhibitIcon, RssSimpleIcon } from "@phosphor-icons/react";
import { CONTENT_REPORT_REASONS, type ContentReportReason, type IssueCloseReason, type IssueComment, type IssueDetail, type IssueLabelDefinition, type IssueList, type IssuePerson, type IssueTemplate, type IssueTemplates, type IssueViewer } from "../shared/types";
import { request, RequestError } from "./api";
import { relativeTime } from "./components";
import { useConfirm } from "./ConfirmDialog";
import { appHref, siteSignedInHint } from "./hosts";
import InfoTip from "./InfoTip";
import SubscribeButton, { publicThreadTarget } from "./SubscribeButton";
import { ImportedFrom } from "./IssueLabels";
import { RequestFix } from "./FixRequests";
import { currentRoute } from "./router";
import { useTurnstile, type Turnstile } from "./turnstile";
import "./public-issues.css";

const RETURN_ROUTE_KEY = "gitflare:return-route";
const SYSTEM_AUTHOR = "gitflare";
const REPORT_LABELS: Record<ContentReportReason, string> = { spam: "Spam", abuse: "Abuse", harassment: "Harassment", illegal: "Illegal content", other: "Something else" };

type People = Record<string, IssuePerson>;

export function personLabel(id: string, people?: People): string {
  if (id === SYSTEM_AUTHOR) return "Gitflare";
  if (id.startsWith("github:")) return id;
  const person = people?.[id];
  return person?.handle ? `@${person.handle}` : person?.name || "Unknown";
}

export function labelColor(value?: string): string | null {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

export function labelStyle(value?: string): CSSProperties | undefined {
  const color = labelColor(value);
  return color ? { "--issue-label": color } as CSSProperties : undefined;
}

export function reasonLabel(reason: string): string {
  const text = reason.replace(/[-_]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function signInHref(siteHint: boolean, pathname: string, toApp: (path: string) => string = appHref): string {
  return toApp(siteHint ? pathname : "/signin");
}

function failureText(failure: unknown, fallback: string) {
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

function isHiddenRepository(failure: unknown) {
  return failure instanceof RequestError && failure.status === 404 && failure.code === "NOT_FOUND";
}

interface Context {
  api: string;
  viewer: IssueViewer;
  userId: string;
  colors: Map<string, string>;
  href: (path?: string) => string;
  link: (to: string, children: ReactNode, className?: string, title?: string) => ReactNode;
  go: (to: string) => void;
  onNotFound: () => void;
  feed?: string;
}

export interface PublicIssuesProps {
  api: string;
  path: string;
  href: (path?: string) => string;
  link: (to: string, children: ReactNode, className?: string, title?: string) => ReactNode;
  go: (to: string) => void;
  onNotFound: () => void;
  feed?: string;
}

export default function PublicIssues({ api, path, href, link, go, onNotFound, feed }: PublicIssuesProps) {
  const [viewer, setViewer] = useState<IssueViewer | null>(null);
  const [labels, setLabels] = useState<IssueLabelDefinition[]>([]);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setError("");
    Promise.all([
      request<IssueViewer>(`${api}/issue-viewer`),
      request<{ labels: IssueLabelDefinition[] }>(`${api}/issue-labels`).catch(() => ({ labels: [] })),
    ]).then(([current, defined]) => {
      if (!active) return;
      setViewer(current);
      setLabels(defined.labels);
    }, (failure: unknown) => {
      if (!active) return;
      if (isHiddenRepository(failure)) onNotFound();
      else setError(failureText(failure, "Issues could not be loaded."));
    });
    return () => { active = false; };
  }, [api, retry]);

  if (error) return <section className="repo-panel"><div className="repo-panel-padding"><div className="error-notice" role="alert">{error} <button type="button" className="text-link" onClick={() => setRetry(value => value + 1)}>Try again</button></div></div></section>;
  if (!viewer) return <section className="repo-panel" aria-busy="true"><p className="repo-panel-padding" role="status">Loading…</p></section>;
  const context: Context = { api, viewer, userId: viewer.userId ?? "", colors: new Map(labels.flatMap(label => labelColor(label.color) ? [[label.name, label.color] as [string, string]] : [])), href, link, go, onNotFound, feed };
  if (path === "new") return <NewIssue context={context} />;
  if (path) return <IssueThread key={path} context={context} number={path} />;
  return <IssueIndex context={context} />;
}

export function SafeMarkdown({ children }: { children: string }) {
  return <div className="documentation-markdown issue-markdown pub-issue-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    img: ({ alt }) => <span>{alt || "Image"}</span>,
    a: ({ href, children: text }) => href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noopener noreferrer nofollow ugc">{text}</a> : <span>{text}</span>,
    pre: ({ children: code }) => <pre tabIndex={0}>{code}</pre>,
    table: ({ children: rows }) => <div className="repo-markdown-table"><table>{rows}</table></div>,
  }}>{children}</Markdown></div>;
}

function LabelChips({ labels, colors }: { labels: string[]; colors: Map<string, string> }) {
  return labels.length ? <span className="pub-issue-labels">{labels.map(label => <span key={label} className="pub-issue-label" style={labelStyle(colors.get(label))}>{label}</span>)}</span> : null;
}

function StateIcon({ state, reason, size = 17 }: { state: string; reason?: IssueCloseReason; size?: number }) {
  const tone = state === "open" ? "open" : reason === "not_planned" ? "not-planned" : "closed";
  const Icon = state === "open" ? CircleDashedIcon : reason === "not_planned" ? ProhibitIcon : CheckCircleIcon;
  return <span className={`pub-issue-icon ${tone}`} role="img" aria-label={state === "open" ? "Open" : "Closed"}><Icon size={size} weight="bold" /></span>;
}

function StateBadge({ state, reason }: { state: string; reason?: IssueCloseReason }) {
  const tone = state === "open" ? "open" : reason === "not_planned" ? "not-planned" : "closed";
  const Icon = state === "open" ? CircleDashedIcon : reason === "not_planned" ? ProhibitIcon : CheckCircleIcon;
  return <span className={`pub-issue-badge ${tone}`}><Icon size={14} weight="bold" aria-hidden="true" />{state === "open" ? "Open" : reason === "not_planned" ? "Not planned" : "Closed"}</span>;
}

function Time({ value }: { value: string }) {
  return <time dateTime={value} title={new Date(value).toLocaleString()}>{relativeTime(value).replace(/^Just now$/, "just now")}</time>;
}

export function SignIn({ children, primary = false }: { children: ReactNode; primary?: boolean }) {
  const target = signInHref(siteSignedInHint(), window.location.pathname);
  const remember = () => {
    if (!target.startsWith("/")) return;
    try { sessionStorage.setItem(RETURN_ROUTE_KEY, currentRoute()); } catch {}
  };
  return primary
    ? <LinkButton variant="primary" size="base" href={target} onClick={remember}>{children}</LinkButton>
    : <a className="pub-issue-signin" href={target} onClick={remember}>{children}</a>;
}

function TriageLink({ viewer, number }: { viewer: IssueViewer; number?: number }) {
  if (!viewer.member || !viewer.canTriage || !viewer.repositoryId) return null;
  return <a className="pub-issue-quiet-link" href={appHref(`/repository/${encodeURIComponent(viewer.repositoryId)}/issues${number ? `/${number}` : ""}`)}>Triage in workspace</a>;
}

function NewIssueAction({ context }: { context: Context }) {
  const { viewer } = context;
  if (!viewer.signedIn) return <SignIn primary>Sign in to open an issue</SignIn>;
  if (!viewer.canParticipate) return <span className="pub-issue-blocked"><Button variant="primary" size="base" icon={PlusIcon} disabled>New issue</Button><InfoTip label="opening issues">Your account can't open issues in this repository.</InfoTip></span>;
  return <Button variant="primary" size="base" icon={PlusIcon} onClick={() => context.go(context.href("new"))}>New issue</Button>;
}

function IssueIndex({ context }: { context: Context }) {
  const { api, viewer, colors } = context;
  const [state, setState] = useState<"open" | "closed">("open");
  const [label, setLabel] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<IssueList | null>(null);
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);

  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 250); return () => clearTimeout(timer); }, [search]);

  const load = useCallback(async (offset = 0) => {
    const current = offset ? generation.current : ++generation.current;
    const params = new URLSearchParams({ state, offset: String(offset) });
    if (label) params.set("label", label);
    if (query) params.set("q", query);
    if (offset) setLoadingMore(true);
    try {
      const page = await request<IssueList>(`${api}/issues?${params}`);
      if (current !== generation.current) return;
      setData(previous => offset && previous ? { ...page, items: [...previous.items, ...page.items], people: { ...previous.people, ...page.people } } : page);
      setError("");
    } catch (failure) {
      if (current !== generation.current) return;
      if (isHiddenRepository(failure)) context.onNotFound();
      else setError(failureText(failure, "Issues could not be loaded."));
    } finally { if (offset) setLoadingMore(false); }
  }, [api, state, label, query]);

  useEffect(() => { setData(null); void load(); }, [load]);

  const definitions = data?.labelDefinitions ?? [];
  const palette = new Map([...colors, ...definitions.flatMap(item => labelColor(item.color) ? [[item.name, item.color] as [string, string]] : [])]);
  const labelNames = [...new Set([...definitions.map(item => item.name), ...(data?.labels ?? []), ...(label ? [label] : [])])].sort((a, b) => a.localeCompare(b));
  const filtered = !!(query || label);

  return <div className="pub-issues">
    <div className="pub-issues-bar">
      <div className="pub-issue-states" role="group" aria-label="Issue state">
        <button type="button" aria-pressed={state === "open"} onClick={() => setState("open")}><CircleDashedIcon size={15} aria-hidden="true" /><span>{data ? data.openCount.toLocaleString() : "–"}</span> Open</button>
        <button type="button" aria-pressed={state === "closed"} onClick={() => setState("closed")}><CheckCircleIcon size={15} aria-hidden="true" /><span>{data ? data.closedCount.toLocaleString() : "–"}</span> Closed</button>
      </div>
      <div className="pub-issues-filters">
        <label className="pub-issues-search"><MagnifyingGlassIcon size={14} aria-hidden="true" /><Input aria-label="Search issues" placeholder="Search issues" value={search} maxLength={200} onChange={event => setSearch(event.target.value)} /></label>
        <select className="pub-issues-select" aria-label="Filter by label" value={label} onChange={event => setLabel(event.target.value)}>
          <option value="">All labels</option>
          {labelNames.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </div>
      <div className="pub-issues-action">{context.feed && <a className="repo-feed-link" href={context.feed} title="Issues feed (Atom)" aria-label="Issues feed (Atom)" target="_blank" rel="noopener noreferrer"><RssSimpleIcon size={14} aria-hidden="true" /></a>}<NewIssueAction context={context} /></div>
    </div>
    {error && <div className="error-notice" role="alert">{error} <button type="button" className="text-link" onClick={() => void load()}>Try again</button></div>}
    <section className="repo-panel pub-issue-panel" aria-busy={!data && !error}>
      {!data ? !error && <p className="repo-panel-padding" role="status">Loading…</p>
        : !data.items.length ? <div className="pub-issues-empty">
          <ChatCircleIcon size={22} aria-hidden="true" />
          <strong>{filtered ? "No matching issues" : state === "open" ? "No open issues" : "No closed issues"}</strong>
          {filtered && <button type="button" className="text-link" onClick={() => { setSearch(""); setQuery(""); setLabel(""); }}>Clear filters</button>}
        </div>
        : <ul className="pub-issue-list">
          {data.items.map(issue => <li key={issue.number}>
            <StateIcon state={issue.state} reason={issue.closedReason} />
            <div className="pub-issue-row">
              <div className="pub-issue-row-title">{context.link(context.href(String(issue.number)), issue.title, "pub-issue-title")}<LabelChips labels={issue.labels} colors={palette} /></div>
              <small>#{issue.number} opened <Time value={issue.createdAt} /> by {personLabel(issue.authorId, data.people)}{issue.locked && <span className="pub-issue-row-lock"><LockSimpleIcon size={12} aria-label="Locked" /></span>}</small>
            </div>
            {issue.commentCount > 0 && context.link(context.href(String(issue.number)), <><ChatCircleIcon size={15} aria-hidden="true" />{issue.commentCount}</>, "pub-issue-count", `${issue.commentCount} ${issue.commentCount === 1 ? "comment" : "comments"}`)}
          </li>)}
        </ul>}
      {data?.nextOffset != null && <div className="pub-issue-more"><Button variant="secondary" size="sm" loading={loadingMore} disabled={loadingMore} onClick={() => void load(data.nextOffset ?? 0)}>Show more</Button></div>}
    </section>
    <div className="pub-issue-foot"><TriageLink viewer={viewer} /></div>
  </div>;
}

export function MarkdownField({ id, label, value, onChange, rows = 8, maxLength, placeholder, disabled, autoFocus }: { id: string; label: string; value: string; onChange: (value: string) => void; rows?: number; maxLength: number; placeholder?: string; disabled?: boolean; autoFocus?: boolean }) {
  const [preview, setPreview] = useState(false);
  return <div className="pub-md">
    <div className="pub-md-tabs">
      <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>Write</button>
      <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>Preview</button>
      <span className="pub-md-hint">Markdown</span>
    </div>
    {preview
      ? <div className="pub-md-preview" aria-label={`${label} preview`}>{value.trim() ? <SafeMarkdown>{value}</SafeMarkdown> : <p className="pub-issue-muted">Nothing to preview.</p>}</div>
      : <textarea id={id} aria-label={label} rows={rows} maxLength={maxLength} disabled={disabled} autoFocus={autoFocus} value={value} placeholder={placeholder} onChange={event => onChange(event.target.value)} />}
  </div>;
}

export function HumanCheck({ turnstile }: { turnstile: Turnstile }) {
  if (!turnstile.required) return null;
  return <div className="pub-issue-human">
    <span className="pub-issue-human-label">Confirm you're human<InfoTip label="the human check">New accounts confirm this for their first 7 days.</InfoTip></span>
    <div className="pub-issue-turnstile" ref={turnstile.container} />
    {turnstile.error && <span className="pub-issue-error">{turnstile.error}</span>}
  </div>;
}

export function human(turnstile: Turnstile): Record<string, string> {
  return turnstile.token ? { turnstileToken: turnstile.token } : {};
}

function NewIssue({ context }: { context: Context }) {
  const { api, viewer } = context;
  const [templates, setTemplates] = useState<IssueTemplate[] | null>(null);
  const [template, setTemplate] = useState<IssueTemplate | null | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(crypto.randomUUID());
  const turnstile = useTurnstile(viewer.canParticipate && viewer.limited ? viewer.turnstileSiteKey : null);
  const [confirm, confirmDialog] = useConfirm();

  useEffect(() => {
    let active = true;
    request<IssueTemplates>(`${api}/issue-templates`).then(
      result => { if (active) setTemplates(result.templates); },
      () => { if (active) setTemplates([]); },
    );
    return () => { active = false; };
  }, [api]);

  function choose(next: IssueTemplate | null) {
    setTemplate(next);
    setTitle(next?.title ?? "");
    setBody(next?.body ?? "");
    setError("");
  }

  const pristine = title === (template?.title ?? "") && body === (template?.body ?? "");
  async function leave(to: () => void) {
    if (pristine || await confirm({ title: "Discard this issue?", description: "What you wrote is not saved.", confirmLabel: "Discard", tone: "danger" })) to();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const issue = await request<IssueDetail>(`${api}/issues`, { title: title.trim(), body, ...(template ? { template: template.file } : {}), ...human(turnstile) }, key.current);
      context.go(context.href(String(issue.number)));
    } catch (failure) {
      setError(failureText(failure, "The issue could not be opened."));
      key.current = crypto.randomUUID();
      turnstile.reset();
    } finally { setBusy(false); }
  }

  const back = context.link(context.href(), <><ArrowLeftIcon size={13} aria-hidden="true" />Issues</>, "pub-issue-back");
  if (!viewer.signedIn) return <div className="pub-issues">{back}<section className="repo-panel pub-issue-gate"><CircleDashedIcon size={22} aria-hidden="true" /><strong>Sign in to open an issue</strong><SignIn primary>Sign in</SignIn></section></div>;
  if (!viewer.canParticipate) return <div className="pub-issues">{back}<section className="repo-panel pub-issue-gate"><ProhibitIcon size={22} aria-hidden="true" /><strong>Your account can't open issues in this repository.</strong></section></div>;
  if (!templates) return <div className="pub-issues">{back}<section className="repo-panel" aria-busy="true"><p className="repo-panel-padding" role="status">Loading…</p></section></div>;

  if (templates.length && template === undefined) return <div className="pub-issues">
    {back}
    <h2 className="pub-issue-heading">New issue</h2>
    <ul className="pub-issue-templates">
      {templates.map(item => <li key={item.file}><button type="button" onClick={() => choose(item)}><FileTextIcon size={18} aria-hidden="true" /><span><strong>{item.name}</strong>{item.about && <small>{item.about}</small>}</span><span className="pub-issue-template-go">Get started</span></button></li>)}
      <li><button type="button" onClick={() => choose(null)}><PencilSimpleIcon size={18} aria-hidden="true" /><span><strong>Blank issue</strong><small>Start from scratch.</small></span><span className="pub-issue-template-go">Get started</span></button></li>
    </ul>
  </div>;

  return <div className="pub-issues">
    {templates.length ? <button type="button" className="pub-issue-back" onClick={() => void leave(() => setTemplate(undefined))}><ArrowLeftIcon size={13} aria-hidden="true" />Templates</button> : back}
    <form className="repo-panel pub-issue-form" onSubmit={event => void submit(event)}>
      <div className="repo-panel-heading"><h2>New issue</h2>{template && <span className="pub-issue-template-name"><FileTextIcon size={13} aria-hidden="true" />{template.name}</span>}</div>
      <div className="pub-issue-form-body">
        <div className="pub-issue-field"><label htmlFor="public-issue-title">Title</label><Input id="public-issue-title" required maxLength={200} disabled={busy} value={title} autoFocus onChange={event => setTitle(event.target.value)} /></div>
        <div className="pub-issue-field"><label htmlFor="public-issue-body">Description</label><MarkdownField id="public-issue-body" label="Description" rows={10} maxLength={20000} disabled={busy} value={body} onChange={setBody} placeholder="What happened, and what did you expect?" /></div>
        {template?.labels.length ? <p className="pub-issue-muted pub-issue-template-labels">Labels <LabelChips labels={template.labels} colors={context.colors} /></p> : null}
        {error && <div className="error-notice" role="alert">{error}</div>}
        <div className="pub-issue-submit">
          <HumanCheck turnstile={turnstile} />
          <div className="pub-issue-buttons">
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void leave(() => context.go(context.href()))}>Cancel</Button>
            <Button type="submit" variant="primary" loading={busy} disabled={busy || !title.trim() || (turnstile.required && !turnstile.token)}>Open issue</Button>
          </div>
        </div>
      </div>
    </form>
    {confirmDialog}
  </div>;
}

function CommentForm({ context, initial = "", label, submitLabel, onSubmit, onCancel, autoFocus }: { context: Context; initial?: string; label: string; submitLabel: string; onSubmit: (body: string, extra: Record<string, string>, key: string) => Promise<void>; onCancel?: () => void; autoFocus?: boolean }) {
  const { viewer } = context;
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(crypto.randomUUID());
  const turnstile = useTurnstile(viewer.limited ? viewer.turnstileSiteKey : null);
  const [confirm, confirmDialog] = useConfirm();
  const field = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await onSubmit(body, human(turnstile), key.current);
      if (!onCancel) setBody("");
      key.current = crypto.randomUUID();
      turnstile.reset();
    } catch (failure) {
      setError(failureText(failure, "This could not be saved."));
      key.current = crypto.randomUUID();
      turnstile.reset();
    } finally { setBusy(false); }
  }

  async function cancel() {
    if (body === initial || await confirm({ title: "Discard your changes?", description: "Your edit is not saved.", confirmLabel: "Discard", tone: "danger" })) onCancel?.();
  }

  return <form className="pub-issue-reply" onSubmit={event => void submit(event)}>
    <MarkdownField id={field} label={label} rows={onCancel ? 6 : 5} maxLength={10000} disabled={busy} value={body} onChange={setBody} autoFocus={autoFocus} placeholder={onCancel ? undefined : "Leave a comment"} />
    {error && <div className="error-notice" role="alert">{error}</div>}
    <div className="pub-issue-submit">
      <HumanCheck turnstile={turnstile} />
      <div className="pub-issue-buttons">
        {onCancel && <Button type="button" variant="secondary" disabled={busy} onClick={() => void cancel()}>Cancel</Button>}
        <Button type="submit" variant="primary" loading={busy} disabled={busy || !body.trim() || body === initial && !!onCancel || (turnstile.required && !turnstile.token)}>{submitLabel}</Button>
      </div>
    </div>
    {confirmDialog}
  </form>;
}

function IssueEditor({ context, issue, onSaved, onCancel }: { context: Context; issue: IssueDetail; onSaved: (issue: IssueDetail) => void; onCancel: () => void }) {
  const { api, viewer } = context;
  const [title, setTitle] = useState(issue.title);
  const [body, setBody] = useState(issue.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(crypto.randomUUID());
  const turnstile = useTurnstile(viewer.limited ? viewer.turnstileSiteKey : null);
  const [confirm, confirmDialog] = useConfirm();
  const changed = title !== issue.title || body !== issue.body;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      onSaved(await request<IssueDetail>(`${api}/issues/${issue.number}/update`, { ...(title !== issue.title ? { title: title.trim() } : {}), ...(body !== issue.body ? { body } : {}), ...human(turnstile) }, key.current));
    } catch (failure) {
      setError(failureText(failure, "The issue could not be saved."));
      key.current = crypto.randomUUID();
      turnstile.reset();
    } finally { setBusy(false); }
  }

  async function cancel() {
    if (!changed || await confirm({ title: "Discard your changes?", description: "Your edit is not saved.", confirmLabel: "Discard", tone: "danger" })) onCancel();
  }

  return <form className="repo-panel pub-issue-form" onSubmit={event => void submit(event)}>
    <div className="pub-issue-form-body">
      <div className="pub-issue-field"><label htmlFor="public-issue-edit-title">Title</label><Input id="public-issue-edit-title" required maxLength={200} disabled={busy} value={title} onChange={event => setTitle(event.target.value)} /></div>
      <div className="pub-issue-field"><label htmlFor="public-issue-edit-body">Description</label><MarkdownField id="public-issue-edit-body" label="Description" rows={10} maxLength={20000} disabled={busy} value={body} onChange={setBody} /></div>
      {error && <div className="error-notice" role="alert">{error}</div>}
      <div className="pub-issue-submit">
        <HumanCheck turnstile={turnstile} />
        <div className="pub-issue-buttons">
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void cancel()}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={busy || !changed || !title.trim() || (turnstile.required && !turnstile.token)}>Save</Button>
        </div>
      </div>
    </div>
    {confirmDialog}
  </form>;
}

function ReportDialog({ api, number, target, onClose, onSent }: { api: string; number: number; target: { commentId?: string } | null; onClose: () => void; onSent: () => void }) {
  const [reason, setReason] = useState<ContentReportReason | "">("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!target) return;
    setReason(""); setDetail(""); setError("");
    key.current = crypto.randomUUID();
  }, [target]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!reason) return;
    setBusy(true); setError("");
    try {
      await request<{ ok: boolean; id: string }>(`${api}/issues/${number}/report`, { reason, ...(detail.trim() ? { detail: detail.trim() } : {}), ...(target?.commentId ? { commentId: target.commentId } : {}) }, key.current);
      onSent();
    } catch (failure) {
      setError(failureText(failure, "The report could not be sent."));
      key.current = crypto.randomUUID();
    } finally { setBusy(false); }
  }

  return <Dialog.Root open={!!target} onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Dialog size="sm" className="dialog-content pub-issue-report">
      <Dialog.Title className="dialog-title">Report {target?.commentId ? "comment" : "issue"}</Dialog.Title>
      <Dialog.Description className="dialog-description">Gitflare reviews every report.</Dialog.Description>
      <form onSubmit={event => void submit(event)}>
        <div className="pub-issue-field"><label htmlFor="public-report-reason">Reason</label>
          <select id="public-report-reason" className="pub-issues-select" required value={reason} disabled={busy} onChange={event => setReason(event.target.value as ContentReportReason)}>
            <option value="" disabled>Choose a reason</option>
            {CONTENT_REPORT_REASONS.map(item => <option key={item} value={item}>{REPORT_LABELS[item]}</option>)}
          </select>
        </div>
        <div className="pub-issue-field"><label htmlFor="public-report-detail">Details <span className="pub-issue-optional">Optional</span></label><textarea id="public-report-detail" rows={4} maxLength={1000} disabled={busy} value={detail} onChange={event => setDetail(event.target.value)} /></div>
        {error && <div className="error-notice" role="alert">{error}</div>}
        <div className="dialog-actions pub-issue-buttons">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="destructive" loading={busy} disabled={busy || !reason}>Send report</Button>
        </div>
      </form>
    </Dialog>
  </Dialog.Root>;
}

function IssueThread({ context, number }: { context: Context; number: string }) {
  const { api, viewer, userId, colors } = context;
  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [people, setPeople] = useState<People>({});
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const [retry, setRetry] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editingComment, setEditingComment] = useState<string | null>(null);
  const [reporting, setReporting] = useState<{ commentId?: string } | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    setError("");
    request<IssueDetail>(`${api}/issues/${number}`).then(value => {
      if (!active) return;
      setIssue(value);
      setPeople(current => ({ ...current, ...value.people }));
    }, (failure: unknown) => {
      if (!active) return;
      if (isHiddenRepository(failure)) context.onNotFound();
      else if (failure instanceof RequestError && failure.status === 404) setMissing(true);
      else setError(failureText(failure, "This issue could not be loaded."));
    });
    return () => { active = false; };
  }, [api, number, retry]);

  useEffect(() => {
    if (!issue) return;
    const previous = document.title;
    document.title = `${issue.title} · #${issue.number} · Gitflare`;
    return () => { document.title = previous; };
  }, [issue?.title, issue?.number]);

  function apply(next: IssueDetail) {
    setIssue(next);
    setPeople(current => ({ ...current, ...next.people }));
  }

  const back = context.link(context.href(), <><ArrowLeftIcon size={13} aria-hidden="true" />Issues</>, "pub-issue-back");
  if (missing) return <div className="pub-issues">{back}<section className="repo-panel pub-issue-gate"><CircleIcon size={22} aria-hidden="true" /><strong>This issue doesn't exist.</strong></section></div>;
  if (!issue) return <div className="pub-issues">{back}<section className="repo-panel" aria-busy={!error}>{error ? <div className="repo-panel-padding"><div className="error-notice" role="alert">{error} <button type="button" className="text-link" onClick={() => setRetry(value => value + 1)}>Try again</button></div></div> : <p className="repo-panel-padding" role="status">Loading…</p>}</section></div>;

  const name = (id: string) => personLabel(id, people);
  const own = (authorId: string) => !!userId && authorId === userId;
  const canWrite = viewer.canParticipate && !issue.locked;
  const commentPath = `${api}/issues/${issue.number}/comment`;
  const subscription = publicThreadTarget(api, issue.number);

  function actions(authorId: string, onEdit: () => void, commentId?: string) {
    const edit = canWrite && own(authorId);
    const report = viewer.signedIn && !own(authorId) && authorId !== SYSTEM_AUTHOR;
    if (!edit && !report) return null;
    return <span className="pub-issue-card-actions">
      {edit && <button type="button" className="pub-issue-icon-button" aria-label={commentId ? "Edit comment" : "Edit issue"} title="Edit" onClick={onEdit}><PencilSimpleIcon size={15} /></button>}
      {report && <button type="button" className="pub-issue-icon-button" aria-label={commentId ? "Report comment" : "Report issue"} title="Report" onClick={() => { setNotice(""); setReporting(commentId ? { commentId } : {}); }}><FlagIcon size={15} /></button>}
    </span>;
  }

  function commentCard(comment: IssueComment) {
    if (comment.hidden) return <div key={comment.id} className="pub-issue-hidden" id={`comment-${comment.id}`}><EyeSlashIcon size={15} aria-hidden="true" /><span>Hidden · {reasonLabel(comment.hidden.reason)}</span></div>;
    return <article key={comment.id} className="pub-issue-card" id={`comment-${comment.id}`}>
      <header><strong>{name(comment.authorId)}</strong>{comment.authorId === issue!.authorId && <span className="repo-pill">Author</span>}<span className="pub-issue-card-time"><Time value={comment.createdAt} />{comment.editedAt && <span title={new Date(comment.editedAt).toLocaleString()}> · edited</span>}</span>{actions(comment.authorId, () => setEditingComment(comment.id), comment.id)}</header>
      <div className="pub-issue-card-body">
        {editingComment === comment.id
          ? <CommentForm context={context} initial={comment.body} label="Edit comment" submitLabel="Save" autoFocus onCancel={() => setEditingComment(null)} onSubmit={async (body, extra, key) => { apply(await request<IssueDetail>(commentPath, { body, commentId: comment.id, ...extra }, key)); setEditingComment(null); }} />
          : <SafeMarkdown>{comment.body}</SafeMarkdown>}
      </div>
    </article>;
  }

  function replyArea() {
    if (!viewer.signedIn) return <div className="pub-issue-gate-line"><SignIn>Sign in to comment</SignIn></div>;
    if (issue!.locked) return <div className="pub-issue-gate-line"><LockSimpleIcon size={15} aria-hidden="true" /><span>Locked · {reasonLabel(issue!.locked.reason)}</span><InfoTip label="locked issues">Only people who triage this repository can comment.</InfoTip></div>;
    if (!viewer.canParticipate) return <div className="pub-issue-gate-line"><ProhibitIcon size={15} aria-hidden="true" /><span>Your account can't comment in this repository.</span></div>;
    return <section className="pub-issue-card pub-issue-composer" aria-label="Add a comment">
      <CommentForm context={context} label="Comment" submitLabel="Comment" onSubmit={async (body, extra, key) => apply(await request<IssueDetail>(commentPath, { body, ...extra }, key))} />
    </section>;
  }

  return <div className="pub-issues pub-issue-detail">
    {back}
    {editing ? <IssueEditor context={context} issue={issue} onCancel={() => setEditing(false)} onSaved={next => { apply(next); setEditing(false); }} /> : <header className="pub-issue-header">
      <h2>{issue.title} <span>#{issue.number}</span></h2>
      <div className="pub-issue-meta">
        <StateBadge state={issue.state} reason={issue.closedReason} />
        <span><strong>{name(issue.authorId)}</strong> opened <Time value={issue.createdAt} /> · {issue.commentCount} {issue.commentCount === 1 ? "comment" : "comments"}</span>
        <ImportedFrom source={issue.importedFrom} />
        {issue.locked && <span className="pub-issue-locked"><LockSimpleIcon size={13} aria-hidden="true" />Locked</span>}
      </div>
      {issue.labels.length > 0 && <LabelChips labels={issue.labels} colors={colors} />}
      {viewer.signedIn && subscription && <div className="pub-issue-subscribe"><SubscribeButton target={subscription} /></div>}
    </header>}
    {notice && <p className="pub-issue-notice" role="status">{notice}</p>}
    <div className="pub-issue-thread">
      {!editing && <article className="pub-issue-card">
        <header><strong>{name(issue.authorId)}</strong><span className="pub-issue-card-time"><Time value={issue.createdAt} /></span>{actions(issue.authorId, () => setEditing(true))}</header>
        <div className="pub-issue-card-body">{issue.body.trim() ? <SafeMarkdown>{issue.body}</SafeMarkdown> : <p className="pub-issue-muted">No description.</p>}</div>
      </article>}
      {issue.comments.map(commentCard)}
      {issue.state === "closed" && issue.closedAt && <p className="pub-issue-event"><StateIcon state="closed" reason={issue.closedReason} size={15} />{issue.closedReason === "not_planned" ? "Closed as not planned" : "Closed"} <Time value={issue.closedAt} /></p>}
      <RequestFix api={api} issueNumber={issue.number} open={issue.state === "open"} signIn={<SignIn>Sign in to request a fix</SignIn>} />
      {replyArea()}
    </div>
    <div className="pub-issue-foot"><TriageLink viewer={viewer} number={issue.number} /></div>
    <ReportDialog api={api} number={issue.number} target={reporting} onClose={() => setReporting(null)} onSent={() => { setReporting(null); setNotice("Report sent"); }} />
  </div>;
}
