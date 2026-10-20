import { useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { DownloadSimpleIcon, GithubLogoIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import type { GitHubOrgImportEntry, GitHubOrgImportView, GitHubOrgListing, GitHubOrgRepository } from "../shared/github-import";
import { request } from "./api";
import InfoTip from "./InfoTip";
import { ErrorNotice, relativeTime } from "./components";
import { ImportCounts } from "./GitHubImport";
import "./github-import.css";

const MAX = 20;

function entryState(entry: GitHubOrgImportEntry): { label: string; active: boolean } {
  if (entry.error) return { label: entry.error.message, active: false };
  if (entry.code?.status === "importing") return { label: "Importing code", active: true };
  if (entry.code?.status === "failed") return { label: "Code import failed", active: false };
  if (!entry.data) return { label: "Queued", active: true };
  if (["queued", "running", "waiting"].includes(entry.data.state)) return { label: entry.data.state === "waiting" ? "Waiting" : `Importing ${entry.data.phase === "pulls" ? "pull requests" : entry.data.phase}`, active: true };
  return { label: entry.data.state === "completed" ? "Imported" : entry.data.state === "failed" ? "Stopped" : "Canceled", active: false };
}

export default function GitHubOrgImport({ canManage, onOpen, onImported }: { canManage: boolean; onOpen: (repositoryId: string) => void; onImported: () => void }) {
  const [owner, setOwner] = useState("");
  const [token, setToken] = useState("");
  const [listing, setListing] = useState<GitHubOrgListing | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [issues, setIssues] = useState(true);
  const [pulls, setPulls] = useState(true);
  const [releases, setReleases] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [imports, setImports] = useState<GitHubOrgImportView[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    request<{ imports: GitHubOrgImportView[] }>("/api/github-import/organizations")
      .then(value => { if (active) { setImports(value.imports); setLoadError(""); } })
      .catch(failure => { if (active) setLoadError(failure instanceof Error ? failure.message : "Imports could not be loaded."); });
    return () => { active = false; };
  }, [refresh]);

  const inProgress = !!imports?.some(item => item.repositories.some(entry => entryState(entry).active));
  useEffect(() => {
    if (!inProgress) return;
    const timer = window.setTimeout(() => setRefresh(value => value + 1), 5000);
    return () => window.clearTimeout(timer);
  }, [inProgress, imports]);

  async function list(page = 1) {
    if (busy) return;
    setBusy("list"); setError("");
    try {
      const next = await request<GitHubOrgListing>("/api/github-import/organizations/repositories", { owner: owner.trim(), page, ...(token.trim() ? { token: token.trim() } : {}) });
      setListing(current => page > 1 && current ? { ...next, repositories: [...current.repositories, ...next.repositories] } : next);
      if (page === 1) setSelected(new Set());
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The repositories could not be listed."); }
    finally { setBusy(""); }
  }

  async function start() {
    if (busy || !listing) return;
    setBusy("import"); setError("");
    try {
      const created = await request<GitHubOrgImportView>("/api/github-import/organizations", { owner: listing.owner, repositories: [...selected], issues, pullRequests: pulls, releases, ...(token.trim() ? { token: token.trim() } : {}) });
      setImports(current => [created, ...(current ?? []).filter(item => item.id !== created.id)]);
      setSelected(new Set()); setToken("");
      onImported();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The import could not start."); }
    finally { setBusy(""); }
  }

  function toggle(repository: GitHubOrgRepository) {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(repository.name)) next.delete(repository.name); else if (next.size < MAX) next.add(repository.name);
      return next;
    });
  }

  return (
    <div className="github-org-import">
      <div className="page-heading"><div><h1>Import from GitHub</h1><p>Bring an organization’s repositories with their history, issues and releases.</p></div></div>
      {canManage ? (
        <section className="panel check-settings">
          <div className="panel-header"><h2><GithubLogoIcon size={18} /> Organization</h2></div>
          <div className="panel-body">
            <form onSubmit={event => { event.preventDefault(); void list(); }}>
              <fieldset className="check-settings-fields" disabled={!!busy}>
                <div className="form-field">
                  <label htmlFor="org-owner">GitHub organization or user</label>
                  <Input id="org-owner" aria-label="GitHub organization or user" maxLength={39} value={owner} placeholder="acme" onChange={event => setOwner(event.target.value)} />
                </div>
                <div className="form-field">
                  <span className="field-label"><label htmlFor="org-token">Token <span className="proposal-optional">(optional)</span></label><InfoTip label="Token">Needed for private repositories and large organizations. Use a read-only fine-grained token for Contents, Issues, Pull requests and Metadata. It is stored encrypted per repository and deleted after each import.</InfoTip></span>
                  <Input id="org-token" aria-label="GitHub token" type="password" autoComplete="off" spellCheck={false} maxLength={300} value={token} placeholder="github_pat_…" onChange={event => setToken(event.target.value)} />
                </div>
              </fieldset>
              <div className="branch-rule-actions github-mirror-actions">
                <Button type="submit" variant="secondary" size="base" icon={MagnifyingGlassIcon} loading={busy === "list"} disabled={!!busy || !owner.trim()}>List repositories</Button>
              </div>
            </form>
            {listing && (
              <>
                {listing.repositories.length ? (
                  <div className="github-org-list" role="list" aria-label={`${listing.owner} repositories`}>
                    {listing.repositories.map(repository => (
                      <label className="github-org-row" role="listitem" key={repository.name}>
                        <input type="checkbox" checked={selected.has(repository.name)} disabled={!selected.has(repository.name) && selected.size >= MAX} onChange={() => toggle(repository)} />
                        <span><strong>{repository.name}</strong>{repository.private && <span className="repo-pill">Private</span>}{repository.archived && <span className="repo-pill">Archived</span>}{repository.fork && <span className="repo-pill">Fork</span>}<small>{repository.description || "No description"}</small></span>
                        <small>{repository.pushedAt ? relativeTime(repository.pushedAt) : ""}</small>
                      </label>
                    ))}
                  </div>
                ) : <p className="branch-rule-note">No repositories found.</p>}
                {listing.nextPage && <div className="branch-rule-actions github-mirror-actions"><Button variant="ghost" size="base" loading={busy === "list"} disabled={!!busy} onClick={() => void list(listing.nextPage!)}>Load more</Button></div>}
                <div className="github-import-options">
                  <label><input type="checkbox" checked={issues} onChange={event => setIssues(event.target.checked)} />Issues and comments</label>
                  <label><input type="checkbox" checked={pulls} onChange={event => setPulls(event.target.checked)} />Pull requests</label>
                  <label><input type="checkbox" checked={releases} onChange={event => setReleases(event.target.checked)} />Releases</label>
                </div>
                <div className="branch-rule-actions github-mirror-actions">
                  <Button variant="primary" size="base" icon={DownloadSimpleIcon} loading={busy === "import"} disabled={!!busy || !selected.size} onClick={() => void start()}>{selected.size ? `Import ${selected.size} ${selected.size === 1 ? "repository" : "repositories"}` : "Choose repositories"}</Button>
                </div>
              </>
            )}
            {error && <div className="error-notice" role="alert">{error}</div>}
          </div>
        </section>
      ) : <p className="branch-rule-note">Only workspace Owners can import from GitHub.</p>}
      {loadError ? <ErrorNotice message={loadError} onRetry={() => setRefresh(value => value + 1)} /> : imports && imports.length > 0 && (
        <section className="panel">
          <div className="panel-header"><h2>Recent imports</h2></div>
          <div className="panel-body github-org-progress">
            {imports.map(item => (
              <div key={item.id}>
                <h3 className="github-mirror-heading">{item.owner} · {relativeTime(item.createdAt)}</h3>
                {item.repositories.map(entry => {
                  const state = entryState(entry);
                  return (
                    <div className="github-org-progress-row" key={entry.name}>
                      {entry.repositoryId ? <Button variant="ghost" size="sm" onClick={() => onOpen(entry.repositoryId!)}>{entry.name}</Button> : <strong>{entry.name}</strong>}
                      <span>{state.label}</span>
                      {entry.data && <ImportCounts counts={entry.data.counts} />}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
