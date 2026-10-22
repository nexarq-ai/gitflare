import { useRef, useState, type FormEvent, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { CheckCircleIcon, ProhibitIcon, ShieldWarningIcon, ShieldCheckIcon, TrashIcon } from "@phosphor-icons/react";
import type { AdvisoryAffected, AdvisoryComment, AdvisoryCloseReason, AdvisorySeverity, AdvisoryState, IssuePerson } from "../shared/types";
import { relativeTime } from "./components";
import { ADVISORY_COMMENT_MAX, ADVISORY_LIST_MAX, CLOSE_REASON_LABELS, emptyAffected, SEVERITY_LABELS, STATE_LABELS } from "./advisory-data";
import "./issues.css";
import "./advisories.css";

export function SeverityPill({ severity }: { severity: AdvisorySeverity | null }) {
  return <span className={`advisory-severity is-${severity ?? "unrated"}`}>{severity ? SEVERITY_LABELS[severity] : "Unrated"}</span>;
}

export function AdvisoryStateBadge({ state, reason }: { state: AdvisoryState; reason?: AdvisoryCloseReason | null }) {
  const Icon = state === "published" ? CheckCircleIcon : state === "closed" ? ProhibitIcon : ShieldWarningIcon;
  return <span className={`advisory-state is-${state}`}><Icon size={14} weight="bold" aria-hidden="true" />{state === "closed" && reason ? `Closed · ${CLOSE_REASON_LABELS[reason]}` : STATE_LABELS[state]}</span>;
}

export function AdvisoryMarkdown({ children }: { children: string }) {
  return <div className="documentation-markdown advisory-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    img: ({ alt }) => <span>{alt || "Image"}</span>,
    a: ({ href, children: text }) => href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noopener noreferrer nofollow ugc">{text}</a> : <span>{text}</span>,
    pre: ({ children: code }) => <pre tabIndex={0}>{code}</pre>,
    table: ({ children: rows }) => <div className="repo-markdown-table"><table>{rows}</table></div>,
  }}>{children}</Markdown></div>;
}

export function AdvisoryTime({ value }: { value: string }) {
  return <time dateTime={value} title={new Date(value).toLocaleString()}>{relativeTime(value)}</time>;
}

export function personName(id: string | null, people: Record<string, IssuePerson>): string {
  if (!id) return "Someone";
  const person = people[id];
  return person?.handle ? `@${person.handle}` : person?.name || "Unknown";
}

export function cweUrl(id: string): string | null {
  const match = /^CWE-(\d{1,5})$/.exec(id);
  return match ? `https://cwe.mitre.org/data/definitions/${match[1]}.html` : null;
}

export function cveUrl(id: string): string | null {
  return /^CVE-\d{4}-\d{4,}$/.test(id) ? `https://www.cve.org/CVERecord?id=${id}` : null;
}

function External({ href, children }: { href: string | null; children: ReactNode }) {
  return href ? <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a> : <>{children}</>;
}

export interface AdvisoryFactsInput {
  severity: AdvisorySeverity | null;
  cvssVector: string | null;
  cveId: string | null;
  cweIds: string[];
  affected: AdvisoryAffected[];
  references: string[];
  credits: string[];
}

export function AdvisoryFacts({ advisory, release }: { advisory: AdvisoryFactsInput; release?: ReactNode }) {
  return <div className="advisory-facts">
    <dl className="advisory-fact-list">
      <div><dt>Severity</dt><dd><SeverityPill severity={advisory.severity} /></dd></div>
      <div><dt>CVE</dt><dd>{advisory.cveId ? <External href={cveUrl(advisory.cveId)}><code>{advisory.cveId}</code></External> : <span className="advisory-muted">None</span>}</dd></div>
      <div><dt>Weaknesses</dt><dd>{advisory.cweIds.length ? <span className="advisory-chips">{advisory.cweIds.map(id => <External key={id} href={cweUrl(id)}><code>{id}</code></External>)}</span> : <span className="advisory-muted">None</span>}</dd></div>
      <div><dt>CVSS</dt><dd>{advisory.cvssVector ? <code className="advisory-cvss">{advisory.cvssVector}</code> : <span className="advisory-muted">None</span>}</dd></div>
      {release !== undefined && <div><dt>Fixed in</dt><dd>{release ?? <span className="advisory-muted">None</span>}</dd></div>}
      {advisory.credits.length > 0 && <div><dt>Credits</dt><dd>{advisory.credits.join(", ")}</dd></div>}
    </dl>
    {advisory.affected.length > 0 && <div className="advisory-affected">
      <h3>Affected packages</h3>
      <div className="advisory-table-wrap"><table>
        <thead><tr><th scope="col">Ecosystem</th><th scope="col">Package</th><th scope="col">Vulnerable</th><th scope="col">Patched</th></tr></thead>
        <tbody>{advisory.affected.map((row, index) => <tr key={`${row.ecosystem}-${row.package}-${index}`}><td>{row.ecosystem}</td><td><code>{row.package}</code></td><td><code>{row.vulnerableVersions || "–"}</code></td><td><code>{row.patchedVersions || "–"}</code></td></tr>)}</tbody>
      </table></div>
    </div>}
    {advisory.references.length > 0 && <div className="advisory-references">
      <h3>References</h3>
      <ul>{advisory.references.map(url => <li key={url}><a href={url} target="_blank" rel="noopener noreferrer nofollow">{url}</a></li>)}</ul>
    </div>}
  </div>;
}

export function AdvisoryThread({ comments, people, reporterId }: { comments: AdvisoryComment[]; people: Record<string, IssuePerson>; reporterId: string | null }) {
  if (!comments.length) return <p className="advisory-muted advisory-thread-empty">No messages yet.</p>;
  return <ol className="advisory-thread">{comments.map(comment => <li key={comment.id} className="advisory-comment">
    <header><strong>{personName(comment.authorId, people)}</strong>{comment.authorId === reporterId && <span className="repo-pill">Reporter</span>}<AdvisoryTime value={comment.createdAt} /></header>
    <AdvisoryMarkdown>{comment.body}</AdvisoryMarkdown>
  </li>)}</ol>;
}

export function AdvisoryCommentBox({ onSubmit, placeholder = "Write a private message" }: { onSubmit: (body: string, key: string) => Promise<void>; placeholder?: string }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(crypto.randomUUID());

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try { await onSubmit(body, key.current); setBody(""); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The message could not be sent."); }
    finally { key.current = crypto.randomUUID(); setBusy(false); }
  }

  return <form className="advisory-comment-box" onSubmit={event => void submit(event)}>
    <textarea aria-label="Message" rows={4} maxLength={ADVISORY_COMMENT_MAX} disabled={busy} value={body} placeholder={placeholder} onChange={event => setBody(event.target.value)} />
    {error && <div className="error-notice" role="alert">{error}</div>}
    <div className="advisory-comment-actions"><span className="advisory-muted">Markdown</span><Button type="submit" variant="primary" size="sm" loading={busy} disabled={busy || !body.trim()}>Send</Button></div>
  </form>;
}

export function EmptyAdvisories({ children }: { children: ReactNode }) {
  return <div className="advisory-empty"><ShieldCheckIcon size={24} aria-hidden="true" /><span>{children}</span></div>;
}

export function AffectedEditor({ rows, disabled, onChange }: { rows: AdvisoryAffected[]; disabled: boolean; onChange: (rows: AdvisoryAffected[]) => void }) {
  const update = (index: number, field: keyof AdvisoryAffected, value: string) => onChange(rows.map((row, at) => at === index ? { ...row, [field]: value } : row));
  return <fieldset className="advisory-affected-editor" disabled={disabled}>
    <legend>Affected packages <span className="proposal-optional">(optional)</span></legend>
    {rows.map((row, index) => <div key={index} className="advisory-affected-row">
      <Input aria-label={`Ecosystem ${index + 1}`} placeholder="npm" value={row.ecosystem} maxLength={40} onChange={event => update(index, "ecosystem", event.target.value)} />
      <Input aria-label={`Package ${index + 1}`} placeholder="package-name" value={row.package} maxLength={200} onChange={event => update(index, "package", event.target.value)} />
      <Input aria-label={`Vulnerable versions ${index + 1}`} placeholder="< 1.4.2" value={row.vulnerableVersions} maxLength={200} onChange={event => update(index, "vulnerableVersions", event.target.value)} />
      <Input aria-label={`Patched versions ${index + 1}`} placeholder="1.4.2" value={row.patchedVersions} maxLength={200} onChange={event => update(index, "patchedVersions", event.target.value)} />
      <button type="button" className="advisory-icon-button" aria-label={`Remove package ${index + 1}`} onClick={() => onChange(rows.filter((_, at) => at !== index))}><TrashIcon size={14} /></button>
    </div>)}
    {rows.length < ADVISORY_LIST_MAX && <button type="button" className="text-link" onClick={() => onChange([...rows, emptyAffected()])}>Add a package</button>}
  </fieldset>;
}
