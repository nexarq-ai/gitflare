import { useCallback, useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { ArrowClockwiseIcon, DownloadSimpleIcon, GithubLogoIcon } from "@phosphor-icons/react";
import type { GitHubImportCounts, GitHubImportSnapshot, GitHubImportView } from "../shared/github-import";
import { request } from "./api";
import InfoTip from "./InfoTip";
import { ErrorNotice, relativeTime } from "./components";
import { useConfirm } from "./ConfirmDialog";
import DemoFeaturePanel, { demoOf } from "./DemoFeaturePanel";
import type { DemoMarked } from "../shared/demo-features";
import "./github-import.css";

const STATE_LABELS: Record<GitHubImportView["state"], string> = { queued: "Queued", running: "Importing", waiting: "Waiting", completed: "Imported", failed: "Stopped", canceled: "Canceled" };
const PHASE_LABELS: Record<GitHubImportView["phase"], string> = { labels: "labels", issues: "issues", comments: "comments", pulls: "pull requests", releases: "releases", done: "done" };
const COUNT_LABELS: [keyof GitHubImportCounts, string][] = [["issues", "Issues"], ["comments", "Comments"], ["labels", "Labels"], ["proposals", "Proposals"], ["pullRequests", "Closed PRs"], ["releases", "Releases"], ["updated", "Updated"], ["skipped", "Skipped"]];
type Credential = "none" | "mirror" | "token" | "stored";

export function ImportCounts({ counts }: { counts: GitHubImportCounts }) {
  return <dl className="github-import-counts">{COUNT_LABELS.filter(([key]) => counts[key] > 0 || key === "issues").map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{counts[key].toLocaleString()}</dd></div>)}</dl>;
}

export default function GitHubImport({ repositoryId, onNotify }: { repositoryId: string; onNotify: (message: string) => void }) {
  const path = `/api/repositories/${encodeURIComponent(repositoryId)}/github-import`;
  const [snapshot, setSnapshot] = useState<(GitHubImportSnapshot & DemoMarked) | null>(null);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [owner, setOwner] = useState("");
  const [name, setName] = useState("");
  const [issues, setIssues] = useState(true);
  const [pulls, setPulls] = useState(true);
  const [releases, setReleases] = useState(true);
  const [credential, setCredential] = useState<Credential>("none");
  const [token, setToken] = useState("");
  const [keep, setKeep] = useState(false);
  const [notice, setNotice] = useState(true);
  const [again, setAgain] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  const show = useCallback((current: GitHubImportSnapshot & DemoMarked, initial = false) => {
    setSnapshot(current);
    if (!initial || demoOf(current)) return;
    const source = current.job ?? current.mirror;
    setOwner(source?.owner ?? "");
    setName(source?.name ?? "");
    if (current.job?.credential === "token") setCredential("stored");
    else if (current.mirror?.credential && (!current.job || current.job.credential === "mirror")) setCredential("mirror");
  }, []);

  useEffect(() => {
    let active = true;
    setLoadError("");
    request<GitHubImportSnapshot & DemoMarked>(path)
      .then(current => { if (active) show(current, attempt === 0); })
      .catch(failure => { if (active) setLoadError(failure instanceof Error ? failure.message : "The GitHub import could not be loaded."); });
    return () => { active = false; };
  }, [path, attempt, show]);

  const job = snapshot?.job ?? null;
  const running = !!job && ["queued", "running", "waiting"].includes(job.state);
  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => setAttempt(value => value + 1), 4000);
    return () => window.clearTimeout(timer);
  }, [running, snapshot]);

  async function act(action: string, body: Record<string, unknown>, done: string) {
    if (busy) return;
    setBusy(action);
    setError("");
    try {
      show(await request<GitHubImportSnapshot>(`${path}/${action}`, body));
      onNotify(done);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The import action failed.");
    } finally { setBusy(""); }
  }

  if (loadError) return <ErrorNotice message={loadError} onRetry={() => setAttempt(value => value + 1)} />;
  if (!snapshot) return null;
  const demo = demoOf(snapshot);
  if (demo) return <DemoFeaturePanel demo={demo} examples={snapshot.examples} />;
  const { canManage, mirror } = snapshot;
  const mirrorMatches = !!mirror?.credential && mirror.owner.toLowerCase() === owner.trim().toLowerCase() && mirror.name.toLowerCase() === name.trim().toLowerCase();
  const storedMatches = job?.credential === "token" && job.owner.toLowerCase() === owner.trim().toLowerCase() && job.name.toLowerCase() === name.trim().toLowerCase();
  const ready = !!owner.trim() && !!name.trim() && (issues || pulls || releases) && (credential !== "token" || !!token.trim()) && (credential !== "mirror" || mirrorMatches) && (credential !== "stored" || storedMatches);

  function start() {
    const body = { owner: owner.trim(), name: name.trim(), issues, pullRequests: pulls, releases, credential, ...(credential === "token" ? { token: token.trim() } : {}), keepCredential: credential === "token" || credential === "stored" ? keep : false };
    void act("start", body, "Import started.").then(() => { setToken(""); setAgain(false); });
  }

  const canNotify = !!job && (job.credential !== "none" || (!!mirror?.credential && mirror.owner.toLowerCase() === job.owner.toLowerCase() && mirror.name.toLowerCase() === job.name.toLowerCase()));

  async function canonical() {
    if (!job) return;
    const announce = canNotify && notice;
    const confirmed = await confirm({ title: "Make Gitflare canonical?", description: "GitHub issues stop being pulled and the stored token is deleted.", facts: [{ label: "GitHub", value: `${job.owner}/${job.name}` }, { label: "Notice on GitHub", value: announce ? "Opened" : "None" }], confirmLabel: "Make canonical", tone: "primary" });
    if (confirmed) void act("canonical", { notify: announce }, "Gitflare is now canonical.");
  }

  const form = canManage && !running && (!job || again) && (
    <div className={job ? "github-import-form" : undefined}>
      <fieldset className="check-settings-fields" disabled={!!busy}>
        <div className="form-field">
          <label htmlFor="import-owner">GitHub owner</label>
          <Input id="import-owner" aria-label="GitHub owner" maxLength={39} value={owner} placeholder="acme" onChange={event => setOwner(event.target.value)} />
        </div>
        <div className="form-field">
          <label htmlFor="import-name">Repository</label>
          <Input id="import-name" aria-label="GitHub repository" maxLength={100} value={name} placeholder="app" onChange={event => setName(event.target.value)} />
        </div>
        <div className="form-field github-import-wide">
          <span className="field-label">Import<InfoTip label="What is imported">Issue and pull request numbers are kept when this repository has no issues yet. Open pull requests become draft proposals; checks start when you choose. GitHub people appear as github:login.</InfoTip></span>
          <div className="github-import-options">
            <label><input type="checkbox" checked={issues} onChange={event => setIssues(event.target.checked)} />Issues and comments</label>
            <label><input type="checkbox" checked={pulls} onChange={event => setPulls(event.target.checked)} />Pull requests</label>
            <label><input type="checkbox" checked={releases} onChange={event => setReleases(event.target.checked)} />Releases</label>
          </div>
        </div>
        <div className="form-field">
          <span className="field-label"><label htmlFor="import-credential">Access</label><InfoTip label="Access">Public repositories need no token, within GitHub’s rate limit of 60 requests an hour. A read-only fine-grained token raises it and reads private repositories. Tokens are stored encrypted and deleted after the import unless kept.</InfoTip></span>
          <select id="import-credential" value={credential} onChange={event => setCredential(event.target.value as Credential)}>
            <option value="none">Public, no token</option>
            {mirror?.credential && <option value="mirror">Mirror credential</option>}
            {job?.credential === "token" && <option value="stored">Stored token</option>}
            <option value="token">Fine-grained token</option>
          </select>
        </div>
        {credential === "token" && (
          <div className="form-field">
            <span className="field-label"><label htmlFor="import-token">Token</label><InfoTip label="Token permissions"><>Create one at <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">GitHub → Developer settings</a> with read access to Contents, Issues, Pull requests and Metadata.</></InfoTip></span>
            <Input id="import-token" aria-label="GitHub token" type="password" autoComplete="off" spellCheck={false} maxLength={300} value={token} placeholder="github_pat_…" onChange={event => setToken(event.target.value)} />
          </div>
        )}
        {(credential === "token" || credential === "stored") && (
          <label className="check-settings-toggle github-import-wide"><input type="checkbox" checked={keep} onChange={event => setKeep(event.target.checked)} />Keep the token for the hourly issue pull</label>
        )}
      </fieldset>
      {credential === "mirror" && !mirrorMatches && <p className="branch-rule-note">The mirror credential belongs to {mirror?.owner}/{mirror?.name}.</p>}
      <div className="branch-rule-actions github-mirror-actions">
        {job && <Button variant="ghost" size="base" disabled={!!busy} onClick={() => setAgain(false)}>Cancel</Button>}
        <Button variant="primary" size="base" icon={DownloadSimpleIcon} loading={busy === "start"} disabled={!!busy || !ready} onClick={start}>{job ? "Import again" : "Import from GitHub"}</Button>
      </div>
    </div>
  );

  return (
    <section className="panel check-settings github-mirror github-import" id="github-import">
      <div className="panel-header"><h2><GithubLogoIcon size={18} /> Import from GitHub<InfoTip label="Import from GitHub">Copies labels, issues, comments, pull requests and releases. Run it again to pick up changes; nothing is duplicated. Code comes from Import from a Git URL or the mirror.</InfoTip></h2></div>
      <div className="panel-body">
        {!canManage && !job && <p className="branch-rule-note">Only workspace Owners can import from GitHub.</p>}
        {job && (
          <div className="github-import-status" aria-live="polite">
            <div className="github-import-line">
              <a href={job.url} target="_blank" rel="noreferrer">{job.owner}/{job.name}</a>
              <span className={`github-import-state github-import-${job.state}`}>{STATE_LABELS[job.state]}{running && job.phase !== "done" ? ` · ${PHASE_LABELS[job.phase]}` : ""}</span>
              {job.mode === "pull" && <span className="repo-pill">Hourly pull</span>}
              {job.canonical && <span className="repo-pill">Gitflare is canonical</span>}
              <small>{job.completedAt ? `finished ${relativeTime(job.completedAt)}` : `started ${relativeTime(job.startedAt)}`}</small>
            </div>
            <ImportCounts counts={job.counts} />
            {job.state === "waiting" && job.retryAt && <p className="branch-rule-note">{job.error?.message ?? "Waiting."} Continues at {new Date(job.retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</p>}
            {job.error && job.state !== "waiting" && <div className="error-notice" role="status">{job.error.message}</div>}
            {job.skipped.length > 0 && (
              <details className="github-import-skipped">
                <summary>{job.counts.skipped.toLocaleString()} skipped</summary>
                <ul>{job.skipped.map((item, index) => <li key={`${item.kind}-${item.ref}-${index}`}><code>{item.ref}</code> {item.reason}</li>)}</ul>
                {job.counts.skipped > job.skipped.length && <small>Showing the first {job.skipped.length}.</small>}
              </details>
            )}
            {job.canonical?.noticeUrl && <p className="branch-rule-note"><a href={job.canonical.noticeUrl} target="_blank" rel="noreferrer">Notice on GitHub</a></p>}
            {job.canonical?.noticeError && <p className="branch-rule-note">The GitHub notice was not opened: {job.canonical.noticeError}</p>}
            {canManage && job.state === "completed" && !job.canonical && (
              <div className="github-import-controls">
                <label className="github-import-toggle"><input type="checkbox" checked={job.transition.enabled} disabled={!!busy} onChange={event => void act("transition", { enabled: event.target.checked }, event.target.checked ? "GitHub issues are pulled hourly." : "Hourly pull is off.")} />Pull GitHub issues hourly<InfoTip label="Hourly pull">While you move, new GitHub issues and comments are copied here every hour. Replies made here are not sent to GitHub.</InfoTip></label>
                {job.transition.enabled && <span className="github-import-muted">{job.transition.lastPullAt ? `Last pulled ${relativeTime(job.transition.lastPullAt)}` : "Not pulled yet"}{job.transition.lastError ? ` · ${job.transition.lastError.message}` : ""}</span>}
                {job.transition.enabled && <Button variant="ghost" size="sm" disabled={!!busy} loading={busy === "pull"} onClick={() => void act("pull", {}, "Pulling GitHub issues.")}>Pull now</Button>}
              </div>
            )}
            {canManage && (
              <div className="branch-rule-actions github-mirror-actions">
                {running && <Button variant="ghost" size="base" disabled={!!busy} loading={busy === "cancel"} onClick={() => void act("cancel", {}, "Import canceled.")}>Cancel</Button>}
                {(job.state === "failed" || job.state === "waiting") && <Button variant="secondary" size="base" icon={ArrowClockwiseIcon} disabled={!!busy} loading={busy === "resume"} onClick={() => void act("resume", {}, "Import resumed.")}>Resume</Button>}
                {!running && !again && <Button variant="ghost" size="base" icon={DownloadSimpleIcon} disabled={!!busy} onClick={() => setAgain(true)}>Import again</Button>}
                {job.state === "completed" && !job.canonical && (
                  <>
                    {canNotify && <label className="github-import-toggle"><input type="checkbox" checked={notice} disabled={!!busy} onChange={event => setNotice(event.target.checked)} />Notice on GitHub<InfoTip label="Notice on GitHub">Opens an issue on GitHub that points here. The token needs Issues write access.</InfoTip></label>}
                    <Button variant="secondary" size="base" disabled={!!busy} loading={busy === "canonical"} onClick={() => void canonical()}>Make Gitflare canonical</Button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        {form}
        {error && <div className="error-notice" role="alert">{error}</div>}
        {confirmDialog}
      </div>
    </section>
  );
}
