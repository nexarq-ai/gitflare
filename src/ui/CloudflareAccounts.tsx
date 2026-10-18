import { useEffect, useMemo, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { CheckCircleIcon, CopyIcon, TrashIcon } from "@phosphor-icons/react";
import type { Repository } from "../shared/types";
import { repositoryLabel } from "../shared/repository-names";
import { cloudflarePermissionGroups, type CloudflareFeature, type CloudflarePermissionPlan } from "../shared/cloudflare-permissions";
import type { DemoMarked } from "../shared/demo-features";
import { request, RequestError } from "./api";
import { ErrorNotice } from "./components";
import { RouteProgress } from "./WorkspaceLoader";
import DemoFeaturePanel, { demoOf } from "./DemoFeaturePanel";
import { ConnectPermissions } from "./CloudflareConnection";
import InfoTip from "./InfoTip";
import { accountUsage, FEATURE_HELP, FEATURE_LABELS, removeRefusal, type AccountsOverview } from "./cloudflare-accounts-data";
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
  const [chooser, setChooser] = useState<{ grantId: string | null; accounts: Reachable[] } | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  useEffect(() => {
    if (!authorization?.features || authorization.plan) return;
    let active = true;
    void request<Status>(`/api/cloudflare?features=${authorization.features.join(",")}`).then(value => { if (active && value.permissions) setAuthorization(current => current && { ...current, plan: value.permissions }); }).catch(() => {});
    return () => { active = false; };
  }, [authorization]);
  const connectedGrant = useMemo(() => new URLSearchParams(window.location.search).get("connected"), []);

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
      if (!canManage || !state?.connected || demoOf(state)) return;
      const grantId = connectedGrant && view.grants?.includes(connectedGrant) ? connectedGrant : null;
      if (!grantId && state.account && view.accounts.length) return;
      const reachable = await request<{ accounts: Reachable[] }>(grantId ? `/api/cloudflare/logins/${grantId}/accounts` : "/api/cloudflare/accounts");
      if (!active) return;
      const known = new Set(view.accounts.map(item => item.id));
      const fresh = reachable.accounts.filter(item => !known.has(item.id));
      if (fresh.length > 1) setChooser({ grantId, accounts: fresh });
      else if (fresh.length === 1 && !grantId && !state.account) {
        await request("/api/cloudflare/select-account", { accountId: fresh[0].id });
        if (active) { setNotice(`Connected. ${fresh[0].name} is this workspace's default Cloudflare account.`); setRetry(value => value + 1); }
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
  const single = accounts.length === 1 ? accounts[0] : !accounts.length && status?.account ? { ...status.account, grantId: null } : null;

  return <div className="cf-accounts-page">
    <div className="page-heading"><div><h1>Cloudflare accounts</h1><p>Accounts your repositories can deploy to. Connecting Cloudflare is separate from signing in.</p></div></div>
    {error && <ErrorNotice message={error} onRetry={() => setRetry(value => value + 1)} />}
    {notice && <p className="people-notice" role="status">{notice}</p>}
    {!overview ? !error && <RouteProgress /> : demo ? <DemoFeaturePanel demo={demo} examples={(status ?? overview).examples} />
      : owner && status && !status.configured ? <section className="panel"><div className="panel-body"><p className="people-muted">Cloudflare connections are not available on this installation. The operator needs to configure the Cloudflare OAuth client.</p></div></section>
      : owner && status && !status.connected ? <section className="panel">
        <div className="panel-header"><h2>Connect Cloudflare</h2></div>
        <div className="panel-body">
          <p className="people-muted">Gitflare reads your accounts and their Workers, D1 and other resources. You choose which accounts {workspaceName} can use. Signing in to Gitflare did not connect one.</p>
          <div className="general-row"><Button variant="primary" size="base" onClick={() => setAuthorization({ kind: "primary" })}>Connect Cloudflare</Button></div>
        </div>
      </section>
      : <>
        {chooser && owner && <AccountChooser workspaceName={workspaceName} grantId={chooser.grantId} accounts={chooser.accounts} hasDefault={!!overview.defaultAccount} busy={busy} onSave={async (ids, defaultId) => {
          setBusy("choose"); setError("");
          try {
            if (chooser.grantId === null && !status?.account && defaultId) await request("/api/cloudflare/select-account", { accountId: defaultId });
            for (const id of ids) if (!(chooser.grantId === null && !status?.account && id === defaultId)) await request("/api/cloudflare/account-put", { accountId: id, ...(chooser.grantId ? { grantId: chooser.grantId } : {}) });
            if (defaultId && (chooser.grantId !== null || status?.account)) await request("/api/cloudflare/account-default", { accountId: defaultId });
            setChooser(null); setNotice(`${ids.length === 1 ? "1 account" : `${ids.length} accounts`} added.`);
            window.history.replaceState(null, "", "/settings/cloudflare");
            setRetry(value => value + 1);
          } catch (failure) { setError(failure instanceof Error ? failure.message : "The accounts could not be added."); }
          finally { setBusy(""); }
        }} onSkip={() => { setChooser(null); window.history.replaceState(null, "", "/settings/cloudflare"); }} />}

        {single ? <section className="panel">
          <div className="panel-header"><h2>Account</h2><span className="account-method-on"><CheckCircleIcon size={16} weight="fill" aria-hidden="true" />Connected</span></div>
          <div className="panel-body cf-single-account"><strong>{single.name}</strong><AccountId id={single.id} name={single.name} onCopied={() => setNotice("Account ID copied.")} /><p className="people-muted">Every repository deploys here unless it chooses another account.</p></div>
        </section> : <section className="panel">
          <div className="panel-header"><h2>Connected accounts</h2><span className="number-tag">{accounts.length}</span></div>
          {accounts.length ? <div className="people-table-wrap"><table className="people-table">
            <thead><tr><th scope="col">Account</th><th scope="col">Default<InfoTip label="the default account">The default is used by every repository that does not choose its own account. Changing it affects their next deploy, not what is already running.</InfoTip></th>{grants.length > 0 && <th scope="col">Login</th>}<th scope="col">Used by</th>{owner && <th scope="col"><span className="sr-only">Actions</span></th>}</tr></thead>
            <tbody>{accounts.map(account => {
              const used = accountUsage(account.id, overview, repositories);
              const isDefault = overview.defaultAccount?.id === account.id;
              return <tr key={account.id}>
                <td><div className="people-person"><div><strong>{account.name}</strong><AccountId id={account.id} name={account.name} onCopied={() => setNotice("Account ID copied.")} /></div></div></td>
                <td>{owner ? <input type="radio" name="cf-default" aria-label={`Make ${account.name} the default`} checked={isDefault} disabled={!!busy} onChange={() => void act(`default:${account.id}`, "/api/cloudflare/account-default", { accountId: account.id }, `${account.name} is the default for repositories that do not choose an account.`)} /> : isDefault ? <span className="people-tag">Default</span> : null}</td>
                {grants.length > 0 && <td><span className="people-muted">{loginName(account.grantId)}</span></td>}
                <td>{used.length ? <details className="cf-used-by"><summary>{used.length === 1 ? "1 repository" : `${used.length} repositories`}</summary><ul>{used.map(item => <li key={item.repository.id}><a href={`/repository/${item.repository.id}/settings/deploys`}>{repositoryLabel(item.repository)}</a> <small>{item.where}</small></li>)}</ul></details> : <span className="people-muted">{isDefault ? "Repositories without their own choice" : "Not used"}</span>}</td>
                {owner && <td className="people-actions">{!isDefault && <Button variant="ghost" size="sm" shape="square" icon={TrashIcon} aria-label={`Remove ${account.name}`} loading={busy === `remove:${account.id}`} disabled={!!busy} onClick={() => void act(`remove:${account.id}`, "/api/cloudflare/account-remove", { accountId: account.id }, `${account.name} removed.`)} />}</td>}
              </tr>;
            })}</tbody>
          </table></div> : <div className="panel-body"><p className="people-muted">No Cloudflare account is connected to this workspace.</p></div>}
          {!owner && <div className="panel-body"><p className="people-muted">An Owner manages Cloudflare connections.</p></div>}
        </section>}

        {owner && status && <section className="panel">
          <div className="panel-header"><h2>What Gitflare can do</h2></div>
          <ul className="people-list cf-features">
            <li><div><strong>Read accounts and resources</strong><small>List accounts, Workers, D1 databases and usage.</small></div><span className="account-method-on"><CheckCircleIcon size={16} weight="fill" aria-hidden="true" />On</span></li>
            {features.map(item => <li key={item.feature}><div><strong>{FEATURE_LABELS[item.feature]}<InfoTip label={FEATURE_LABELS[item.feature]}>{FEATURE_HELP[item.feature]}</InfoTip></strong>{!item.granted && <small>Not granted yet</small>}</div>
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

function AccountChooser({ workspaceName, grantId, accounts, hasDefault, busy, onSave, onSkip }: { workspaceName: string; grantId: string | null; accounts: Reachable[]; hasDefault: boolean; busy: string; onSave: (ids: string[], defaultId: string | null) => Promise<void>; onSkip: () => void }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const effectiveDefault = defaultId && chosen.includes(defaultId) ? defaultId : hasDefault ? null : chosen[0] ?? null;
  return <section className="panel cf-chooser" aria-labelledby="cf-chooser-title">
    <div className="panel-header"><h2 id="cf-chooser-title">Which accounts should {workspaceName} use?</h2></div>
    <div className="panel-body">
      <p className="people-muted">You can add more later. One account is the default for repositories that do not choose their own.{grantId ? " These come from the login you just added." : ""}</p>
      <ul className="cf-chooser-list">{accounts.map(account => <li key={account.id}>
        <label><input type="checkbox" checked={chosen.includes(account.id)} onChange={event => setChosen(current => event.target.checked ? [...current, account.id] : current.filter(id => id !== account.id))} /><span><strong>{account.name}</strong><small>{account.id}</small></span></label>
        {chosen.includes(account.id) && <label className="cf-chooser-default"><input type="radio" name="cf-chooser-default" checked={effectiveDefault === account.id} onChange={() => setDefaultId(account.id)} />Default</label>}
      </li>)}</ul>
      <div className="general-row"><Button variant="primary" size="base" loading={busy === "choose"} disabled={!chosen.length || !!busy} onClick={() => void onSave(chosen, effectiveDefault)}>{chosen.length > 1 ? `Add ${chosen.length} accounts` : "Add account"}</Button><Button variant="ghost" size="base" disabled={!!busy} onClick={onSkip}>Not now</Button></div>
    </div>
  </section>;
}
