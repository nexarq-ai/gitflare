import { useCallback, useEffect, useState } from "react";
import InfoTip from "./InfoTip";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { ArrowsClockwiseIcon, GithubLogoIcon } from "@phosphor-icons/react";
import type { GitHubMirrorSnapshot, MirrorRefStatus } from "../shared/github-mirror";
import { request } from "./api";
import { ErrorNotice, relativeTime } from "./components";
import { useConfirm } from "./ConfirmDialog";
import DemoFeaturePanel, { demoOf } from "./DemoFeaturePanel";
import type { DemoMarked } from "../shared/demo-features";
import "./github-mirror.css";

const short = (sha: string | null) => sha ? sha.slice(0, 7) : "none";
const STATE_LABELS: Record<MirrorRefStatus["state"], string> = { pending: "Pending", synced: "Synced", failed: "Failed", diverged: "Diverged" };
const SYNC_LABELS: Record<string, string> = { idle: "Idle", running: "Syncing", retrying: "Retrying", failed: "Failed" };

export default function GitHubMirror({ repositoryId, onNotify }: { repositoryId: string; onNotify: (message: string) => void }) {
  const path = `/api/repositories/${encodeURIComponent(repositoryId)}/github-mirror`;
  const [snapshot, setSnapshot] = useState<(GitHubMirrorSnapshot & DemoMarked) | null>(null);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [owner, setOwner] = useState("");
  const [name, setName] = useState("");
  const [patterns, setPatterns] = useState("");
  const [token, setToken] = useState("");
  const [installation, setInstallation] = useState("");
  const [confirm, confirmDialog] = useConfirm();

  const show = useCallback((current: GitHubMirrorSnapshot & DemoMarked) => {
    setSnapshot(current);
    if (demoOf(current)) return;
    setOwner(current.mirror?.owner ?? "");
    setName(current.mirror?.name ?? "");
    setPatterns((current.mirror?.refPatterns ?? current.defaultRefPatterns).join("\n"));
  }, []);

  useEffect(() => {
    let active = true;
    setLoadError("");
    request<GitHubMirrorSnapshot & DemoMarked>(path)
      .then((current) => { if (active) show(current); })
      .catch((failure) => { if (active) setLoadError(failure instanceof Error ? failure.message : "The GitHub mirror could not be loaded."); });
    return () => { active = false; };
  }, [path, attempt, show]);

  const syncing = snapshot?.mirror?.sync.state === "running" || snapshot?.mirror?.sync.state === "retrying";
  useEffect(() => {
    if (!syncing) return;
    const timer = window.setTimeout(() => setAttempt((value) => value + 1), 5000);
    return () => window.clearTimeout(timer);
  }, [syncing, snapshot]);

  async function act(action: string, body: Record<string, unknown>, done: (current: GitHubMirrorSnapshot & Record<string, unknown>) => string) {
    if (busy) return;
    setBusy(action);
    setError("");
    try {
      const current = await request<GitHubMirrorSnapshot & Record<string, unknown>>(`${path}/${action}`, body);
      show(current);
      onNotify(done(current));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The mirror action failed.");
    } finally { setBusy(""); }
  }

  if (loadError) return <ErrorNotice message={loadError} onRetry={() => setAttempt((value) => value + 1)} />;
  if (!snapshot) return null;
  const demo = demoOf(snapshot);
  if (demo) return <DemoFeaturePanel demo={demo} examples={snapshot.examples} />;
  const { canManage, mirror, app } = snapshot;
  const refPatterns = patterns.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);

  async function overwrite(ref: MirrorRefStatus) {
    const confirmed = await confirm(ref.gitflareSha
      ? { title: `Overwrite ${ref.ref} on GitHub?`, description: "GitHub's copy of this ref moves to Gitflare's revision. Revisions that exist only on GitHub are no longer on that ref.", facts: [{ label: "GitHub now", value: short(ref.githubSha), title: ref.githubSha ?? undefined, code: true }, { label: "Gitflare", value: short(ref.gitflareSha), title: ref.gitflareSha, code: true }], confirmLabel: "Overwrite GitHub", tone: "danger" }
      : { title: `Delete ${ref.ref} on GitHub?`, description: "Gitflare has no such ref, so the mirror removes it from GitHub.", confirmLabel: "Delete on GitHub", tone: "danger" });
    if (!confirmed) return;
    void act("overwrite", { ref: ref.ref, expectedGithubSha: ref.githubSha }, (current) => (current.outcome as { state?: string } | undefined)?.state === "diverged" ? "GitHub changed again. Review the new state before overwriting." : `Overwrote ${ref.ref} on GitHub.`);
  }

  return (
    <section className="panel check-settings github-mirror" id="github-mirror">
      <div className="panel-header"><h2><GithubLogoIcon size={18} /> GitHub mirror</h2></div>
      <div className="panel-body">
        <p className="branch-rule-note">Every landing and push is mirrored to GitHub.<InfoTip label="mirroring">If GitHub has revisions Gitflare doesn't, mirroring stops for that stream. Nothing is overwritten unless an Owner chooses to.</InfoTip></p>
        {!canManage && <p className="branch-rule-note">Only workspace Owners can change the mirror.</p>}
        <fieldset className="check-settings-fields" disabled={!canManage || !!busy}>
          <div className="form-field">
            <span className="field-label"><label htmlFor="mirror-owner">GitHub owner</label><InfoTip label="GitHub owner">The GitHub user or organization that owns the mirror repository, for example acme.</InfoTip></span>
            <Input id="mirror-owner" maxLength={39} value={owner} placeholder="nexarq-ai" onChange={(event) => setOwner(event.target.value)} />
          </div>
          <div className="form-field">
            <span className="field-label"><label htmlFor="mirror-name">Repository</label><InfoTip label="Mirror repository">The GitHub repository Gitflare pushes to. Gitflare stays the source of truth; changes made on GitHub are overwritten.</InfoTip></span>
            <Input id="mirror-name" maxLength={100} value={name} placeholder="my-repository" onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="form-field github-mirror-wide">
            <span className="field-label"><label htmlFor="mirror-patterns">Mirrored refs <span className="proposal-optional">(one per line, * matches anything)</span></label><InfoTip label="Mirrored refs">Which streams and tags are copied, one per line. main copies only main; * copies everything.</InfoTip></span>
            <textarea id="mirror-patterns" rows={2} value={patterns} onChange={(event) => setPatterns(event.target.value)} />
          </div>
        </fieldset>
        {canManage && (
          <div className="branch-rule-actions github-mirror-actions">
            {mirror && <Button variant="ghost" size="base" disabled={!!busy} onClick={async () => { if (await confirm({ title: `Unlink ${mirror.owner}/${mirror.name}?`, description: "Gitflare stops mirroring and deletes the stored GitHub credential. GitHub keeps its current content.", confirmLabel: "Unlink", tone: "danger" })) void act("unlink", {}, () => "The GitHub mirror is unlinked."); }}>Unlink</Button>}
            <Button variant="primary" size="base" loading={busy === "link"} disabled={!!busy || !owner.trim() || !name.trim() || !refPatterns.length} onClick={() => void act("link", { owner: owner.trim(), name: name.trim(), refPatterns }, () => mirror ? "Mirror settings saved." : "Linked. Add a GitHub credential next.")}>{mirror ? "Save mirror settings" : "Link GitHub repository"}</Button>
          </div>
        )}
        {mirror && (
          <>
            <h3 className="github-mirror-heading">Credential</h3>
            <p className="branch-rule-note">
              {mirror.credential
                ? <>{mirror.credential.kind === "pat" ? "A fine-grained personal access token" : `GitHub App installation ${mirror.credential.installationId}`} is stored, set {relativeTime(mirror.credential.setAt)}. It is encrypted and never shown again, sent to agents, or returned by the API.</>
                : <>Create a fine-grained token at <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">GitHub → Settings → Developer settings</a> for <code>{mirror.owner}/{mirror.name}</code> only, with Repository permissions → Contents: Read and write. Gitflare checks push access before storing it.</>}
            </p>
            {canManage && (
              <fieldset className="check-settings-fields" disabled={!!busy}>
                <div className="form-field">
                  <label htmlFor="mirror-token">{mirror.credential ? "Replace token" : "Fine-grained token"}</label>
                  <Input id="mirror-token" type="password" autoComplete="off" spellCheck={false} maxLength={300} value={token} placeholder="github_pat_…" onChange={(event) => setToken(event.target.value)} />
                </div>
                {app.available && (
                  <div className="form-field">
                    <span className="field-label"><label htmlFor="mirror-installation">Or GitHub App installation ID</label><InfoTip label="GitHub App installation ID">Use a GitHub App installation instead of a personal token. Find the number in the app installation URL.</InfoTip></span>
                    <Input id="mirror-installation" inputMode="numeric" maxLength={12} value={installation} placeholder="12345678" onChange={(event) => setInstallation(event.target.value.replace(/\D/g, ""))} />
                    {app.installUrl && <small><a href={app.installUrl} target="_blank" rel="noreferrer">Install the App</a> on the repository, then paste the installation ID from the URL.</small>}
                  </div>
                )}
              </fieldset>
            )}
            {canManage && (
              <div className="branch-rule-actions github-mirror-actions">
                {mirror.credential && <Button variant="ghost" size="base" disabled={!!busy} onClick={() => void act("remove-credential", {}, () => "The GitHub credential is deleted. Mirroring is paused.")}>Remove credential</Button>}
                {app.available && <Button variant="secondary" size="base" loading={busy === "credential" && !!installation} disabled={!!busy || !installation} onClick={() => void act("credential", { kind: "app", installationId: Number(installation) }, () => { setInstallation(""); return "GitHub App installation verified and saved."; })}>Use App installation</Button>}
                <Button variant="primary" size="base" loading={busy === "credential" && !!token} disabled={!!busy || !token.trim()} onClick={() => void act("credential", { kind: "pat", token: token.trim() }, () => { setToken(""); return "Token verified and stored."; })}>Save token</Button>
              </div>
            )}
            <h3 className="github-mirror-heading">Status</h3>
            <p className="branch-rule-note">
              <a href={mirror.url} target="_blank" rel="noreferrer">{mirror.owner}/{mirror.name}</a> · {SYNC_LABELS[mirror.sync.state] ?? mirror.sync.state}
              {mirror.sync.lastSuccessAt ? <> · last synced {relativeTime(mirror.sync.lastSuccessAt)}</> : null}
              {mirror.sync.attempt ? <> · attempt {mirror.sync.attempt}</> : null}
              {mirror.adoptedAt ? <> · adopted from GitHub {relativeTime(mirror.adoptedAt)}</> : null}
            </p>
            {mirror.sync.error && mirror.sync.state !== "idle" && <div className="error-notice" role="status">{mirror.sync.error.message}</div>}
            {mirror.refs.length > 0 && (
              <div className="github-mirror-table" role="table" aria-label="Mirrored refs">
                <div className="github-mirror-row github-mirror-head" role="row"><span role="columnheader">Ref</span><span role="columnheader">State</span><span role="columnheader">Gitflare</span><span role="columnheader">GitHub</span><span role="columnheader">Last synced</span></div>
                {mirror.refs.map((ref) => (
                  <div className="github-mirror-row" role="row" key={ref.ref}>
                    <span role="cell"><code>{ref.ref.replace(/^refs\/(heads|tags)\//, "")}</code></span>
                    <span role="cell" className={`github-mirror-state github-mirror-${ref.state}`}>{STATE_LABELS[ref.state]}</span>
                    <span role="cell"><code>{short(ref.gitflareSha)}</code></span>
                    <span role="cell"><code>{short(ref.githubSha)}</code></span>
                    <span role="cell">{ref.lastSyncedAt ? relativeTime(ref.lastSyncedAt) : "never"}</span>
                    {(ref.error || ref.importedBranch) && <small className="github-mirror-detail" role="cell">{ref.error?.message}{ref.importedBranch ? ` Imported as ${ref.importedBranch.replace(/^refs\/heads\//, "")}; open a proposal from it to land the GitHub changes.` : ""}</small>}
                    {canManage && ref.state === "diverged" && (
                      <span className="github-mirror-resolve" role="cell">
                        {ref.githubSha && <Button variant="secondary" size="sm" disabled={!!busy} loading={busy === "import"} onClick={() => void act("import", { ref: ref.ref }, (current) => `Imported GitHub ${ref.ref} as ${String((current.imported as { branch?: string } | undefined)?.branch ?? "a new stream").replace(/^refs\/heads\//, "")}.`)}>Import from GitHub</Button>}
                        <Button variant="destructive" size="sm" disabled={!!busy} loading={busy === "overwrite"} onClick={() => void overwrite(ref)}>Overwrite GitHub</Button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {error && <div className="error-notice" role="alert">{error}</div>}
            {canManage && mirror.credential && (
              <div className="branch-rule-actions github-mirror-actions">
                {!mirror.adoptedAt && <Button variant="ghost" size="base" disabled={!!busy} loading={busy === "adopt"} onClick={async () => { if (await confirm({ title: `Adopt ${mirror.owner}/${mirror.name}?`, description: "Gitflare copies the GitHub repository into this one, once. This only works while this repository is empty or has just its setup commit. Afterwards Gitflare is the source of truth and pushes to GitHub.", confirmLabel: "Adopt", tone: "primary" })) void act("adopt", {}, () => "GitHub adopted. Gitflare is now the source of truth."); }}>Adopt from GitHub</Button>}
                <Button variant="primary" size="base" icon={ArrowsClockwiseIcon} loading={busy === "sync"} disabled={!!busy} onClick={() => void act("sync", {}, () => "Sync started.")}>Sync now</Button>
              </div>
            )}
          </>
        )}
        {!mirror && error && <div className="error-notice" role="alert">{error}</div>}
        {confirmDialog}
      </div>
    </section>
  );
}
