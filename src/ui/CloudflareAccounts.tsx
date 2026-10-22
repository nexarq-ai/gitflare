import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { CheckCircleIcon, CopyIcon, TrashIcon } from "@phosphor-icons/react";
import type { Repository } from "../shared/types";
import { repositoryLabel } from "../shared/repository-names";
import { cloudflarePermissionGroups, type CloudflareFeature, type CloudflarePermissionPlan } from "../shared/cloudflare-permissions";
import type { DemoMarked } from "../shared/demo-features";
import { request, RequestError } from "./api";
import { ErrorNotice } from "./components";
import { PageLoading } from "./WorkspaceLoader";
import DemoFeaturePanel, { demoOf } from "./DemoFeaturePanel";
import { ConnectPermissions } from "./CloudflareConnection";
import InfoTip from "./InfoTip";
import { accountRows, accountUsage, FEATURE_HELP, FEATURE_LABELS, removeRefusal, type AccountsOverview } from "./cloudflare-accounts-data";
import "./cloudflare-connection.css";
import "./people-settings.css";

type Account = { id: string; name: string };
type FeatureState = { feature: CloudflareFeature; granted: boolean; missing: string[] };
type Status = { configured: boolean; connected: boolean; account?: Account; scopes?: string[]; permissions?: CloudflarePermissionPlan; features?: FeatureState[] };
type Reachable = Account & { connected?: boolean };
type Authorization = { kind: "primary" | "login"; features?: CloudflareFeature[]; plan?: CloudflarePermissionPlan };

export default function CloudflareAccounts({ canManage, repositories, workspaceName }: { canManage: boolean; repositories: Repository[]; workspaceName: string }) {
  const [status, setStatus] = useState<(Status & DemoMarked) | null>(null);
  const [overview, setOverview] = useState<(AccountsOverview & DemoMarked) | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [retry, setRetry] = useState(0);
  const [authorization, setAuthorization] = useState<Authorization | null>(null);
  const [reachable, setReachable] = useState<{ grantId: string | null; accounts: Reachable[] }[]>([]);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  const [highlight] = useState(() => new URLSearchParams(window.location.search).get("grant"));
  const scrolled = useRef(false);
  useEffect(() => {
    if (!authorization?.features || authorization.plan) return;
    let active = true;
    void request<Status>(`/api/cloudflare?features=${authorization.features.join(",")}`).then(value => { if (active && value.permissions) setAuthorization(current => current && { ...current, plan: value.permissions }); }).catch(() => {});
    return () => { active = false; };
  }, [authorization]);
  useEffect(() => { if (new URLSearchParams(window.location.search).has("connected")) window.history.replaceState(null, "", "/settings/cloudflare"); }, []);

  useEffect(() => {
    let active = true;
    setError("");
    const load = async () => {
      const [view, state] = await Promise.all([
        request<AccountsOverview & DemoMarked>("/api/cloudflare/connected-accounts"),
        canManage ? request<Status & DemoMarked>("/api/cloudflare") : Promise.resolve(null),
      ]);
      if (!active) return;
      setOverview(view); setStatus(state);
      if (!canManage || !state?.connected || demoOf(state)) { setReachable([]); return; }
      const logins = [null, ...(view.grants ?? [])];
      const lists = await Promise.all(logins.map(grantId => request<{ accounts: Reachable[] }>(grantId ? `/api/cloudflare/logins/${grantId}/accounts` : "/api/cloudflare/accounts").then(result => ({ grantId, accounts: result.accounts })).catch(() => ({ grantId, accounts: [] as Reachable[] }))));
      if (!active) return;
      setReachable(lists);
      const first = lists[0]?.accounts ?? [];
      if (!state.account && !view.accounts.length && first.length === 1) {
        await request("/api/cloudflare/select-account", { accountId: first[0].id });
        if (active) { setNotice(`Connected. ${first[0].name} is this workspace's default Cloudflare account.`); setRetry(value => value + 1); }
      }
    };
    void load().catch(failure => { if (active) setError(failure instanceof Error ? failure.message : "Cloudflare accounts could not be loaded."); });
    return () => { active = false; };
  }, [retry, canManage]);

  async function act(key: string, path: string, body: Record<string, unknown>, done?: string) {
    setBusy(key); setError(""); setNotice("");
    try {
      const result = await request<unknown>(path, body);
      if (result && typeof result === "object" && "accounts" in result && "repositories" in result) setOverview(result as AccountsOverview);
      if (done) setNotice(done);
      return result;
    } catch (failure) {
      setError(failure instanceof RequestError && failure.code === "ACCOUNT_IN_USE" ? removeRefusal(String(body.accountId ?? ""), overview, repositories) : failure instanceof Error ? failure.message : "The change could not be saved.");
      return null;
    } finally { setBusy(""); }
  }

  async function authorize() {
    if (!authorization) return;
    const result = await act("connect", authorization.kind === "login" ? "/api/cloudflare/logins" : "/api/cloudflare/connect", authorization.features ? { features: authorization.features } : {});
    if (result && typeof result === "object" && "authorizationUrl" in result) window.location.assign(String((result as { authorizationUrl: string }).authorizationUrl));
  }

  const demo = demoOf(status) ?? demoOf(overview);
  const owner = canManage;
  const accounts = overview?.accounts ?? [];
  const features = status?.features ?? [];
  const granted = features.filter(item => item.granted).map(item => item.feature);
  const grants = overview?.grants ?? [];
  const loginName = (grantId: string | null) => grantId === null ? "First login" : `Login ${grants.indexOf(grantId) + 2}`;
  const rows = accountRows(accounts, reachable, status?.account ?? null);
  async function addAccount(row: { id: string; name: string; grantId: string | null }) {
    if (row.grantId === null && !status?.account) { await act(`add:${row.id}`, "/api/cloudflare/select-account", { accountId: row.id }, `${row.name} added as the default.`); setRetry(value => value + 1); return; }
    await act(`add:${row.id}`, "/api/cloudflare/account-put", { accountId: row.id, ...(row.grantId ? { grantId: row.grantId } : {}) }, `${row.name} added.`);
  }

  return <div className="cf-accounts-page">
    <div className="page-heading"><div><h1>Cloudflare accounts</h1><p>Accounts your repositories can deploy to. Connecting Cloudflare is separate from signing in.</p></div></div>
    {error && <ErrorNotice message={error} onRetry={() => setRetry(value => value + 1)} />}
    {notice && <p className="people-notice" role="status">{notice}</p>}
    {!overview ? !error && <PageLoading /> : demo ? <DemoFeaturePanel demo={demo} examples={(status ?? overview).examples} />
      : owner && status && !status.configured ? <section className="panel"><div className="panel-body"><p className="people-muted">Cloudflare connections are not available on this installation. The operator needs to configure the Cloudflare OAuth client.</p></div></section>
      : owner && status && !status.connected ? <section className="panel">
        <div className="panel-header"><h2>Connect Cloudflare</h2></div>
        <div className="panel-body">
          <p className="people-muted">Gitflare reads your accounts and their Workers, D1 and other resources. You choose which accounts {workspaceName} can use. Signing in to Gitflare did not connect one.</p>
          <div className="general-row"><Button variant="primary" size="base" onClick={() => setAuthorization({ kind: "primary" })}>Connect Cloudflare</Button></div>
        </div>
      </section>
      : <>
        <section className="panel">
          <div className="panel-header"><h2>Accounts</h2><span className="number-tag">{rows.filter(row => row.added).length} used</span></div>
          {rows.length ? <div className="people-table-wrap"><table className="people-table cf-accounts-table">
            <thead><tr><th scope="col">Account</th><th scope="col">Status</th><th scope="col">Default<InfoTip label="the default account">The default is used by every repository that does not choose its own account. Changing it affects their next deploy, not what is already running.</InfoTip></th>{grants.length > 0 && <th scope="col">Login</th>}<th scope="col">Used by</th>{owner && <th scope="col"><span className="sr-only">Actions</span></th>}</tr></thead>
            <tbody>{rows.map(row => {
              const used = accountUsage(row.id, overview, repositories);
              const isDefault = overview.defaultAccount?.id === row.id;
              return <tr key={row.id} className={row.added ? undefined : "cf-account-not-added"}>
                <td><div className="people-person"><div><strong>{row.name}</strong><AccountId id={row.id} name={row.name} onCopied={() => setNotice("Account ID copied.")} /></div></div></td>
                <td>{row.added ? <span className="account-method-on"><CheckCircleIcon size={16} weight="fill" aria-hidden="true" />Used by this workspace</span> : <span className="people-muted">Not added</span>}</td>
                <td data-label="Default">{row.added ? owner ? <input type="radio" name="cf-default" aria-label={`Make ${row.name} the default`} checked={isDefault} disabled={!!busy} onChange={() => void act(`default:${row.id}`, "/api/cloudflare/account-default", { accountId: row.id }, `${row.name} is the default for repositories that do not choose an account.`)} /> : isDefault ? <span className="people-tag">Default</span> : null : null}</td>
                {grants.length > 0 && <td><span className="people-muted">{loginName(row.grantId)}</span></td>}
                <td data-label="Used by">{!row.added ? null : used.length ? <details className="cf-used-by"><summary>{used.length === 1 ? "1 repository" : `${used.length} repositories`}</summary><ul>{used.map(item => <li key={item.repository.id}><a href={`/repository/${item.repository.id}/settings/deploys`}>{repositoryLabel(item.repository)}</a> <small>{item.where}</small></li>)}</ul></details> : <span className="people-muted">{isDefault ? "Repositories without their own choice" : "None yet"}</span>}</td>
                {owner && <td className="people-actions">{row.added ? !isDefault && <Button variant="ghost" size="sm" shape="square" icon={TrashIcon} aria-label={`Remove ${row.name}`} loading={busy === `remove:${row.id}`} disabled={!!busy} onClick={() => void act(`remove:${row.id}`, "/api/cloudflare/account-remove", { accountId: row.id }, `${row.name} removed from this workspace.`)} />
                  : <Button variant="secondary" size="sm" loading={busy === `add:${row.id}`} disabled={!!busy} onClick={() => void addAccount(row)}>Add</Button>}</td>}
              </tr>;
            })}</tbody>
          </table></div> : <div className="panel-body"><p className="people-muted">No Cloudflare account is connected to this workspace.</p></div>}
          {owner ? rows.some(row => !row.added) && <div className="panel-body"><p className="people-muted">Your Cloudflare {grants.length ? "logins reach" : "login reaches"} every account listed. Add the ones repositories here should deploy to.</p></div>
            : <div className="panel-body"><p className="people-muted">An Owner manages Cloudflare connections.</p></div>}
        </section>

        {owner && status && <section className="panel">
          <div className="panel-header"><h2>What Gitflare can do</h2></div>
          <ul className="people-list cf-features">
            <li><div><strong>Read accounts and resources</strong><small>List accounts, Workers, D1 databases and usage.</small></div><span className="account-method-on"><CheckCircleIcon size={16} weight="fill" aria-hidden="true" />On</span></li>
            {features.map(item => <li key={item.feature} className={item.feature === highlight ? "cf-feature-highlight" : undefined} ref={item.feature === highlight ? (node => { if (node && !scrolled.current) { scrolled.current = true; node.scrollIntoView({ block: "center" }); } }) : undefined}><div><strong>{FEATURE_LABELS[item.feature]}<InfoTip label={FEATURE_LABELS[item.feature]}>{FEATURE_HELP[item.feature]}</InfoTip></strong>{!item.granted && <small>Not granted yet</small>}</div>
              {item.granted ? <span className="account-method-on"><CheckCircleIcon size={16} weight="fill" aria-hidden="true" />On</span> : <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => setAuthorization({ kind: "primary", features: [...granted, item.feature] })}>Grant</Button>}
            </li>)}
          </ul>
          {status.permissions && <details className="cf-permission-details"><summary>All Cloudflare permissions</summary><div className="cf-permission-groups">{cloudflarePermissionGroups(status.permissions.permissions).map(({ group, permissions }) => <section key={group}><h3>{group}</h3><ul>{permissions.map(permission => <li key={permission.scope}><strong>{permission.name}</strong> <span>{permission.reason}</span></li>)}</ul></section>)}</div></details>}
        </section>}

        {owner && status && <section className="panel">
          <div className="panel-header"><h2>Cloudflare {grants.length ? "logins" : "login"}</h2></div>
          <ul className="people-list">
            <li><div><strong>{loginName(null)}</strong><small>{status.account ? `Reaches ${status.account.name}${accounts.filter(item => item.grantId === null).length > 1 ? " and more" : ""}` : "Connected"}</small></div>
              <span className="cf-login-actions"><Button variant="secondary" size="sm" disabled={!!busy} onClick={() => setAuthorization({ kind: "primary", features: granted })}>Reconnect</Button><InfoTip label="Reconnect">Use if you changed permissions or accounts in Cloudflare. Gitflare asks for the same permissions again and keeps your settings.</InfoTip>
                <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setConfirmDisconnect("primary")}>Disconnect</Button></span></li>
            {grants.map(grantId => <li key={grantId}><div><strong>{loginName(grantId)}</strong><small>{accounts.filter(item => item.grantId === grantId).map(item => item.name).join(", ") || "No accounts added yet"}</small></div>
              <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setConfirmDisconnect(grantId)}>Disconnect</Button></li>)}
          </ul>
          <div className="panel-body"><div className="general-row"><Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setAuthorization({ kind: "login" })}>Add another Cloudflare login</Button><InfoTip label="another Cloudflare login">For accounts that belong to a different Cloudflare user. That person signs in to Cloudflare, and must be an Owner of {workspaceName}.</InfoTip></div></div>
        </section>}
      </>}
    <ConnectPermissions plan={authorization?.features ? authorization.plan : status?.permissions} open={!!authorization} busy={busy === "connect"} onOpenChange={open => { if (!open) setAuthorization(null); }} onContinue={() => void authorize()} />
    <Dialog.Root open={!!confirmDisconnect} onOpenChange={open => { if (!open) setConfirmDisconnect(null); }}>
      <Dialog size="sm" className="dialog-content confirm-dialog">
        <Dialog.Title className="dialog-title">Disconnect this login?</Dialog.Title>
        <Dialog.Description className="dialog-description">Gitflare stops using this Cloudflare login and the accounts it reaches. Deploys to those accounts stop until you connect again. Nothing in Cloudflare is deleted.</Dialog.Description>
        <div className="dialog-actions"><Button variant="secondary" size="base" type="button" onClick={() => setConfirmDisconnect(null)}>Cancel</Button><Button variant="destructive" size="base" type="button" loading={busy.startsWith("disconnect")} onClick={() => { const target = confirmDisconnect; setConfirmDisconnect(null); void act(`disconnect:${target}`, target === "primary" ? "/api/cloudflare/disconnect" : `/api/cloudflare/logins/${target}/disconnect`, {}, "Disconnected.").then(() => setRetry(value => value + 1)); }}>Disconnect</Button></div>
      </Dialog>
    </Dialog.Root>
  </div>;
}

function AccountId({ id, name, onCopied }: { id: string; name: string; onCopied: () => void }) {
  return <small className="cf-account-id"><code>{id}</code><button type="button" className="cf-copy" aria-label={`Copy the account ID of ${name}`} onClick={() => void navigator.clipboard.writeText(id).then(onCopied).catch(() => {})}><CopyIcon size={12} /></button></small>;
}
