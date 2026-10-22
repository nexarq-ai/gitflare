import { useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { CubeIcon, GitBranchIcon, LockKeyIcon, RobotIcon } from "@phosphor-icons/react";
import type { Workspace } from "../shared/types";
import { request, RequestError } from "./api";
import { ErrorNotice, Status } from "./components";
import InstallationCredential, { type WorkspaceConnection } from "./InstallationCredential";
import ContentReports from "./ContentReports";
import OperatorAi from "./OperatorAi";
import { PageLoading } from "./WorkspaceLoader";
import "./people-settings.css";

export type AdminStatus = { edition: "hosted" | "self-hosted"; superAdmins: string[]; cloudflareOAuth: boolean; email: boolean; previewsWorker: string | null; scopes: { signin: string[]; connect: string[]; access: string[] }; publicIndex: { configured: boolean; repositories: number | null } };
type Rebuild = { indexed: number; removed: number; failed: number; repositories: number };

export function loadAdminStatus(): Promise<AdminStatus | null> {
  return request<AdminStatus>("/api/admin/status").catch((failure: unknown) => { if (failure instanceof RequestError && [403, 404].includes(failure.status)) return null; throw failure; });
}

export default function InstallationAdmin({ workspace, notFound }: { workspace: Workspace; notFound: React.ReactNode }) {
  const [status, setStatus] = useState<AdminStatus | null | undefined>(undefined);
  const [connection, setConnection] = useState<WorkspaceConnection | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    loadAdminStatus().then(value => { if (active) setStatus(value); }, (failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "Installation status is unavailable."); });
    request<WorkspaceConnection>("/api/cloudflare").then(value => { if (active) setConnection(value); }, () => {});
    return () => { active = false; };
  }, [workspace.name]);
  if (error) return <ErrorNotice message={error} />;
  if (status === undefined) return <PageLoading />;
  if (status === null) return <>{notFound}</>;
  const hosted = status.edition === "hosted";
  return <>
    <div className="page-heading"><div><h1>Installation</h1><p>Settings for the Gitflare service itself, not for a workspace.</p></div></div>
    <InstallationCredential workspace={connection} />
    {hosted && <section className="panel">
      <div className="panel-header"><h2>Super admins</h2><span className="number-tag">{status.superAdmins.length}</span></div>
      <div className="panel-body"><p className="people-muted">People who become Owners of the operator workspace when they sign in with a verified Cloudflare email. Change the list with <code>SUPER_ADMIN_EMAILS</code> in the deployment.</p></div>
      {status.superAdmins.length ? <ul className="people-list">{status.superAdmins.map(email => <li key={email}><div><strong>{email}</strong></div></li>)}</ul> : <div className="panel-body"><p className="people-muted">None configured.</p></div>}
    </section>}
    {hosted && <ContentReports />}
    {hosted && <OperatorAi />}
    {status.publicIndex.configured && <PublicIndexPanel repositories={status.publicIndex.repositories} />}
    <section className="panel">
      <div className="panel-header"><h2>Edition and configuration</h2><span className="people-role-text">{hosted ? "Hosted" : "Self-hosted"}</span></div>
      <dl className="general-facts admin-facts">
        <dt>Cloudflare sign-in and connections</dt><dd>{status.cloudflareOAuth ? "OAuth client configured" : "Not configured: set CLOUDFLARE_CLIENT_ID and CLOUDFLARE_CLIENT_SECRET"}</dd>
        <dt>Email</dt><dd>{status.email ? "Sender configured" : "No sender: invitations show links to share instead"}</dd>
        <dt>Shared previews Worker</dt><dd>{status.previewsWorker ? <code>{status.previewsWorker}</code> : "Not set"}</dd>
        {hosted && <><dt>Sign-in permissions</dt><dd><ScopeList scopes={status.scopes.signin} /></dd></>}
        <dt>Connect permissions</dt><dd><ScopeList scopes={status.scopes.connect} /></dd>
        <dt>Cloudflare Access permissions</dt><dd>{status.scopes.access.length ? <ScopeList scopes={status.scopes.access} /> : "Not requested. Protecting deploys with Cloudflare Access is off until CLOUDFLARE_ACCESS_SCOPES is set."}</dd>
      </dl>
      {hosted && <div className="panel-body"><p className="people-muted">The operator workspace runs on Gitflare's own Cloudflare account. Gitflare's own Workers and databases are hidden from resource lists there and cannot be linked to a repository.</p></div>}
    </section>
    <section className="panel">
      <div className="panel-header"><h2>Platform services</h2><span className="number-tag">{workspace.integrations.filter(item => item.ready).length} of {workspace.integrations.length} ready</span></div>
      {workspace.integrations.map(item => <div className="readiness-row" key={item.id}>
        <div className="service-icon">{item.id === "artifacts" ? <GitBranchIcon size={19} /> : item.id === "sandbox" ? <CubeIcon size={19} /> : item.id === "model" ? <RobotIcon size={19} /> : <LockKeyIcon size={19} />}</div>
        <div><h3>{item.name}</h3><p>{item.detail}</p></div>
        <Status status={item.ready ? "ready" : "blocked"} />
      </div>)}
      <div className="notice-inline">These are configured in the deployment. Reload the page after changing them.</div>
    </section>
  </>;
}

function PublicIndexPanel({ repositories }: { repositories: number | null }) {
  const [count, setCount] = useState(repositories);
  const [result, setResult] = useState<Rebuild | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function rebuild() {
    setBusy(true); setError("");
    try { const value = await request<Rebuild>("/api/admin/public-index/rebuild", {}); setResult(value); setCount(value.repositories); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The public index could not be rebuilt."); }
    finally { setBusy(false); }
  }
  return <section className="panel">
    <div className="panel-header"><h2>Public index</h2>{count !== null && <span className="number-tag">{count}</span>}</div>
    <div className="panel-body">
      <p className="people-muted">Explore, search and profile details read this index. It updates when repositories change and is rebuilt every night. Rebuild it now if public repositories are missing.</p>
      {error && <div className="error-notice" role="alert">{error}</div>}
      {result && <p role="status">{result.indexed} indexed, {result.removed} removed{result.failed ? `, ${result.failed} failed` : ""}.</p>}
      <Button variant="secondary" loading={busy} disabled={busy} onClick={() => { void rebuild(); }}>Rebuild public index</Button>
    </div>
  </section>;
}

function ScopeList({ scopes }: { scopes: string[] }) {
  return scopes.length ? <span className="admin-scopes">{scopes.map(scope => <code key={scope}>{scope}</code>)}</span> : <>None</>;
}
