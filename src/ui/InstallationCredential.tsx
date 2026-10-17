import { useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import { request } from "./api";
import { ErrorNotice } from "./components";

type Account = { id: string; name: string };
type Labelled = { key: string; label: string };
export type InstallationCredentialStatus = {
  manageable: boolean;
  edition: "hosted" | "self-hosted";
  oauthAvailable: boolean;
  source: "connection" | "installation" | "environment" | "none";
  state: "configured" | "missing_permission" | "unavailable" | "missing";
  problem?: { code: string; message: string };
  connection?: { workspaceId: string; accountId: string; accountName?: string; workerName: string; scopes: string[] };
  tokenSource?: "installation" | "environment" | "none";
  accountId?: string;
  workerName?: string;
  permissions?: string[];
  missing?: Labelled[];
  verifiedAt?: string;
  tokenPageUrl?: string;
};
export type WorkspaceConnection = { connected: boolean; account?: Account; scopes?: string[] };
type SetResult = { stored: true; createdWorker: boolean; status: InstallationCredentialStatus } | { stored: false; accountSelectionRequired: true; accounts: Account[] };
type UseResult = { stored: true; createdWorker: boolean; status: InstallationCredentialStatus };

const BASE = "/api/cloudflare/installation-credential";
const CONNECTION_SCOPES = ["workers-scripts.edit", "d1.write"];

export function loadInstallationCredential() { return request<InstallationCredentialStatus>(BASE); }

function stateLabel(status: InstallationCredentialStatus): string {
  if (status.state === "missing") return "Not set up";
  if (status.state === "unavailable") return "Needs attention";
  if (status.state === "missing_permission") return `Missing ${status.missing?.map((item) => item.label).join(", ")}`;
  if (status.source === "connection") return "Configured (workspace connection)";
  return status.source === "environment" ? "Configured (deployment secret)" : "Configured";
}

function sourceLabel(status: InstallationCredentialStatus): string {
  const verified = status.verifiedAt ? `, checked ${new Date(status.verifiedAt).toLocaleString()}` : "";
  if (status.source === "connection") return `This workspace’s Cloudflare connection${status.connection?.accountName ? ` (${status.connection.accountName})` : ""}${verified}`;
  if (status.source === "installation") return `API token saved in Gitflare${verified}`;
  return "Deployment secret PREVIEWS_API_TOKEN";
}

export function InstallationCredentialPrompt({ onOpen }: { onOpen: () => void }) {
  const [status, setStatus] = useState<InstallationCredentialStatus | null>(null);
  useEffect(() => { let active = true; loadInstallationCredential().then((value) => { if (active) setStatus(value); }, () => {}); return () => { active = false; }; }, []);
  if (!status?.manageable || status.state === "configured") return null;
  const heading = status.state === "missing" ? "Finish setup: turn on Worker previews" : status.state === "unavailable" ? "Worker previews need attention" : "Worker previews need another permission";
  const detail = status.state === "missing" ? (status.oauthAvailable ? "Use this workspace’s Cloudflare connection so proposals of Worker apps get live previews and isolated D1 databases." : "Paste one Cloudflare API token so proposals of Worker apps get live previews and isolated D1 databases. No terminal needed.") : status.problem?.message ?? `Missing ${status.missing?.map((item) => item.label).join(", ")}.`;
  return <section className="panel settings-cloudflare" aria-labelledby="installation-previews-prompt">
    <div className="settings-cloudflare-heading"><div><h2 id="installation-previews-prompt">{heading}</h2><p>{detail}</p></div></div>
    <Button variant="primary" size="base" onClick={onOpen}>Set up previews</Button>
  </section>;
}

export default function InstallationCredential({ workspace }: { workspace?: WorkspaceConnection | null }) {
  const [status, setStatus] = useState<InstallationCredentialStatus | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<"token" | "connection" | null>(null);

  useEffect(() => {
    let active = true;
    loadInstallationCredential().then((value) => { if (active) { setStatus(value); setEditing(value.manageable && value.state === "missing" && !value.oauthAvailable); } }, (failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "Preview credential status could not be loaded."); });
    return () => { active = false; };
  }, []);

  async function perform(name: string, operation: () => Promise<void>) {
    setBusy(name); setError(""); setMessage("");
    try { await operation(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The request failed."); }
    finally { setBusy(""); }
  }

  const save = () => perform("save", async () => {
    const result = await request<SetResult>(BASE, { token, ...(accountId ? { accountId } : {}) });
    if (!result.stored) { setAccounts(result.accounts); setMessage("This token can reach several accounts. Choose the one that should host previews, then save again."); return; }
    setStatus(result.status); setEditing(false); setToken(""); setAccounts([]); setAccountId("");
    if (result.status.source === "connection") setMessage("Saved. The workspace connection stays in use; this token is used if you stop using the connection.");
    else setMessage(result.status.state === "missing_permission" ? "Saved. Worker previews are on, but apps that bind D1 need the missing permission." : `Saved. Worker previews are on${result.createdWorker ? ` and ${result.status.workerName} was created` : ""}.`);
  });

  const useConnection = () => perform("connection", async () => {
    const result = await request<UseResult>(`${BASE}/connection`, workspace?.account ? { accountId: workspace.account.id } : {});
    setStatus(result.status);
    setMessage(`Worker previews now use this workspace’s Cloudflare connection${result.createdWorker ? ` and ${result.status.workerName} was created` : ""}.`);
  });

  const remove = (kind: "token" | "connection") => perform("remove", async () => {
    const next = await request<InstallationCredentialStatus>(`${BASE}/${kind === "token" ? "remove" : "connection-remove"}`, {});
    setStatus(next);
    if (kind === "connection") setMessage(next.source === "none" ? "Stopped using the workspace connection. Worker previews of repositories without their own connection are off." : "Stopped using the workspace connection. Previews now use the API token.");
    else setMessage(next.source === "connection" ? "Removed the API token. The workspace connection stays in use." : next.source === "environment" ? "Removed. Previews now use the deployment secret." : "Removed. Worker previews are off; proposals use container previews.");
  });

  if (!status) return error ? <ErrorNotice message={error} /> : null;
  const hosted = status.edition === "hosted";
  const heading = hosted ? "Previews and deploys on this installation (operator credential)" : "Previews and deploys on this installation";
  const fallback = "Only used for repositories without their own Cloudflare connection. A repository whose own or workspace connection can reach its Worker previews there instead.";
  if (!status.manageable) return <section className="panel">
    <div className="panel-header"><h2>{heading}</h2><span className={`cf-state${status.state === "configured" ? " cf-state-on" : ""}`}>{stateLabel(status)}</span></div>
    <div className="panel-body"><p className="cf-description">{fallback} {hosted ? "Only the operator workspace can change it." : "Only an owner of the installation workspace can change it."}</p></div>
  </section>;
  const usingConnection = status.source === "connection";
  const savedToken = status.source === "installation" || status.tokenSource === "installation";
  const missingWorkspaceScopes = CONNECTION_SCOPES.filter((scope) => !workspace?.scopes?.includes(scope));
  const tokenForm = editing ? <div className="installation-credential-form">
    <ol className="cf-description">
      <li><a href={status.tokenPageUrl} target="_blank" rel="noopener noreferrer">Open Cloudflare’s token page</a> with Workers Scripts: Edit and D1: Edit prefilled.</li>
      <li>Choose “Continue to summary”, then “Create Token”, and copy it.</li>
      <li>Paste it here. Gitflare checks it before saving.</li>
    </ol>
    <div className="cf-form-row">
      <label htmlFor="installation-token">Cloudflare API token<Input id="installation-token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(event) => setToken(event.target.value)} disabled={!!busy} /></label>
      {accounts.length > 1 && <label htmlFor="installation-account">Cloudflare account<select id="installation-account" value={accountId} onChange={(event) => setAccountId(event.target.value)} disabled={!!busy}><option value="">Choose an account</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>}
    </div>
    <div className="cf-actions"><Button variant="primary" size="base" disabled={!!busy || token.trim().length < 20 || (accounts.length > 1 && !accountId)} onClick={() => void save()}>{busy === "save" ? "Checking…" : "Verify and save"}</Button><Button variant="secondary" size="base" disabled={!!busy} onClick={() => { setEditing(false); setToken(""); setAccounts([]); setAccountId(""); }}>Cancel</Button></div>
  </div> : <div className="cf-actions">
    <Button variant={status.oauthAvailable || status.state !== "missing" ? "secondary" : "primary"} size="base" disabled={!!busy} onClick={() => { setEditing(true); setMessage(""); }}>{savedToken ? "Replace token" : "Add a token"}</Button>
    {savedToken && <Button variant="secondary" size="base" disabled={!!busy} onClick={() => setConfirmRemove("token")}>Remove token</Button>}
  </div>;
  return <section className="panel">
    <div className="panel-header"><h2>{heading}</h2><span className={`cf-state${status.state === "configured" ? " cf-state-on" : ""}`}>{status.state === "configured" && <span className="cf-connected-dot" />}{stateLabel(status)}</span></div>
    <div className="panel-body">
      <p className="cf-description">{fallback} For those, Gitflare publishes Worker Previews and creates isolated preview D1 databases on {hosted ? "the operator’s" : "this installation’s"} previews Worker.</p>
      {error && <ErrorNotice message={error} />}
      {message && <p className="cf-notice" role="status">{message}</p>}
      {status.problem && <p className="cf-field-hint" role="alert">{status.problem.message} Worker previews of repositories without their own connection fail until this is fixed.</p>}
      <dl className="cf-account-facts">
        <div><dt>Account ID</dt><dd>{status.accountId ? <code>{status.accountId}</code> : status.oauthAvailable ? "From the workspace connection or token" : "Chosen from the token"}</dd></div>
        <div><dt>Previews Worker</dt><dd><code>{status.workerName}</code></dd></div>
        {status.source !== "none" && <div><dt>Source</dt><dd>{sourceLabel(status)}</dd></div>}
      </dl>
      {!usingConnection && !!status.missing?.length && <p className="cf-field-hint" role="status">Missing permission: {status.missing.map((item) => item.label).join(", ")}. Previews of apps that bind D1 fail until you replace the token with one that includes it.</p>}
      {status.oauthAvailable && <div className="installation-credential-form">
        <h3>Use this workspace’s Cloudflare connection</h3>
        <p className="cf-description">Gitflare keeps a reference to this workspace’s Cloudflare connection and its selected account, not a copy of its credential, and creates the previews Worker with previews enabled if it is missing. The connection needs workers-scripts.edit and d1.write.</p>
        {!usingConnection && !workspace?.connected && <p className="cf-field-hint">Connect Cloudflare for this workspace below first.</p>}
        {!usingConnection && workspace?.connected && !workspace.account && <p className="cf-field-hint">Choose the workspace’s Cloudflare account below first.</p>}
        {!usingConnection && workspace?.connected && missingWorkspaceScopes.length > 0 && <p className="cf-field-hint">The workspace connection was not granted {missingWorkspaceScopes.join(" and ")}. Reconnect Cloudflare and grant it.</p>}
        <div className="cf-actions">
          <Button variant={usingConnection ? "secondary" : "primary"} size="base" disabled={!!busy || (!usingConnection && (!workspace?.connected || !workspace.account))} onClick={() => void useConnection()}>{busy === "connection" ? "Checking…" : usingConnection ? "Check and use again" : `Use this workspace’s Cloudflare connection${workspace?.account ? ` (${workspace.account.name})` : ""}`}</Button>
          {usingConnection && <Button variant="secondary" size="base" disabled={!!busy} onClick={() => setConfirmRemove("connection")}>Stop using the connection</Button>}
        </div>
      </div>}
      {status.oauthAvailable ? <details className="cf-environment-settings installation-credential-form" open={editing || undefined}>
        <summary>Use an API token instead</summary>
        <p className="cf-description">For installations without a Cloudflare OAuth client. A saved token is used only while the workspace connection is not chosen. It is stored encrypted and never shown again.</p>
        {tokenForm}
      </details> : <>
        <p className="cf-description">One Cloudflare API token lets Gitflare publish these previews. It is stored encrypted and never shown again.</p>
        {tokenForm}
      </>}
    </div>
    <Dialog.Root open={confirmRemove !== null} onOpenChange={(open) => { if (!open) setConfirmRemove(null); }}>
      <Dialog size="sm" className="dialog-content confirm-dialog">
        <Dialog.Title className="dialog-title">{confirmRemove === "connection" ? "Stop using the workspace connection?" : "Remove the previews token?"}</Dialog.Title>
        <Dialog.Description className="dialog-description">{confirmRemove === "connection" ? "Previews of repositories without their own Cloudflare connection then use the saved API token or deployment secret if one exists, otherwise container previews. The workspace connection itself stays connected." : "Gitflare deletes the saved token. Previews then use the deployment secret if one exists, otherwise proposals fall back to container previews. Nothing in your Cloudflare account changes; revoke the token in Cloudflare if you no longer need it."}</Dialog.Description>
        <div className="dialog-actions"><Button variant="secondary" size="base" type="button" onClick={() => setConfirmRemove(null)}>Cancel</Button><Button variant="primary" size="base" type="button" onClick={() => { const kind = confirmRemove; setConfirmRemove(null); if (kind) void remove(kind); }}>{confirmRemove === "connection" ? "Stop using" : "Remove"}</Button></div>
      </Dialog>
    </Dialog.Root>
  </section>;
}
