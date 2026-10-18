import { useEffect, useState } from "react";
import type { CloudflareFeature } from "../shared/cloudflare-permissions";
import { request } from "./api";
import InfoTip from "./InfoTip";
import { effectiveAccount, type AccountsOverview } from "./cloudflare-accounts-data";
import "./cloudflare-connection.css";
import "./people-settings.css";

type FeatureState = { feature: CloudflareFeature; granted: boolean };
const label = (environment: string) => environment === "production" ? "Production" : environment === "staging" ? "Staging" : environment;

export default function DeployAccounts({ repositoryId, environments, canManage, feature = "deploy" }: { repositoryId: string; environments: string[]; canManage: boolean; feature?: CloudflareFeature }) {
  const [overview, setOverview] = useState<AccountsOverview | null>(null);
  const [features, setFeatures] = useState<FeatureState[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    request<AccountsOverview>("/api/cloudflare/connected-accounts").then(value => { if (active) setOverview(value); }).catch(failure => { if (active) setError(failure instanceof Error ? failure.message : "Cloudflare accounts could not be loaded."); });
    if (canManage) request<{ features?: FeatureState[] }>("/api/cloudflare").then(value => { if (active) setFeatures(value.features ?? null); }).catch(() => {});
    return () => { active = false; };
  }, [repositoryId, canManage]);

  if (!overview) return error ? <p className="form-error" role="alert">{error}</p> : null;
  const selection = overview.repositories[repositoryId] ?? {};
  const name = (id?: string) => overview.accounts.find(item => item.id === id)?.name ?? "an account that is no longer connected";

  if (!overview.accounts.length && !overview.defaultAccount) return <section className="panel cf-deploy-accounts">
    <div className="panel-header"><h2>No Cloudflare account yet</h2></div>
    <div className="panel-body"><p className="people-muted">{canManage ? <>Connect Cloudflare to deploy this repository. <a href="/settings/cloudflare">Settings → Cloudflare</a></> : "Ask an Owner to connect a Cloudflare account in Settings → Cloudflare."}</p></div>
  </section>;

  if (selection.own) return <section className="panel cf-deploy-accounts">
    <div className="panel-body"><p className="people-muted">This repository uses its own Cloudflare login{selection.own !== true ? ` (${selection.own.name})` : ""}, so every environment deploys there. <a href={`/repository/${repositoryId}/settings/cloudflare`}>Manage</a></p></div>
  </section>;

  async function choose(accountId: string | null, environment?: string) {
    const key = environment ?? "repository";
    const before = effectiveAccount(overview!, repositoryId, environment);
    setBusy(key); setError(""); setNotice("");
    try {
      await request(`/api/repositories/${encodeURIComponent(repositoryId)}/cloudflare/action`, { action: "account", accountId, ...(environment ? { environment } : {}) });
      const fresh = await request<AccountsOverview>("/api/cloudflare/connected-accounts");
      setOverview(fresh);
      const after = effectiveAccount(fresh, repositoryId, environment);
      setNotice(after && before && after.id !== before.id ? `Future ${environment ? label(environment) : ""} deploys go to ${after.name}. A Worker already running on ${before.name} is not moved.`.replace("  ", " ") : "Saved.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The account could not be changed."); }
    finally { setBusy(""); }
  }

  const repositoryDefault = overview.defaultAccount ? `Workspace default (${overview.defaultAccount.name})` : "Workspace default";
  const options = overview.accounts.map(item => <option key={item.id} value={item.id}>{item.name}</option>);
  const missing = features?.find(item => item.feature === feature && !item.granted);
  return <section className="panel cf-deploy-accounts">
    <div className="panel-header"><h2>Cloudflare account<InfoTip label="the deploy account">Each environment deploys to one Cloudflare account. Environments follow the repository's account unless you choose another one, and the repository follows the workspace default.</InfoTip></h2></div>
    <ul className="people-list">
      <li><div><strong>Repository</strong><small>Used by every environment without its own choice</small></div>
        {canManage ? <select aria-label="Repository account" value={selection.accountId ?? ""} disabled={!!busy} onChange={event => void choose(event.target.value || null)}><option value="">{repositoryDefault}</option>{options}</select> : <span className="people-muted">{selection.accountId ? name(selection.accountId) : repositoryDefault}</span>}</li>
      {environments.map(environment => {
        const chosen = selection.environments?.[environment];
        const inherited = selection.accountId ? name(selection.accountId) : overview.defaultAccount?.name ?? "the workspace default";
        return <li key={environment}><div><strong>{label(environment)}</strong><small>{chosen ? `Deploys to ${name(chosen)}` : `Follows the repository (${inherited})`}</small></div>
          {canManage ? <select aria-label={`${label(environment)} account`} value={chosen ?? ""} disabled={!!busy} onChange={event => void choose(event.target.value || null, environment)}><option value="">Same as repository</option>{options}</select> : null}</li>;
      })}
    </ul>
    {missing && <div className="panel-body"><p className="approval-warning">Deploys need the Deploy Workers permission on your Cloudflare login. <a href="/settings/cloudflare">Grant it in Settings → Cloudflare</a></p></div>}
    {notice && <div className="panel-body"><p className="people-notice" role="status">{notice}</p></div>}
    {error && <div className="panel-body"><p className="form-error" role="alert">{error}</p></div>}
  </section>;
}

export function PreviewAccountLine({ repositoryId, canManage }: { repositoryId: string; canManage: boolean }) {
  const [overview, setOverview] = useState<AccountsOverview | null>(null);
  const [previews, setPreviews] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    request<AccountsOverview>("/api/cloudflare/connected-accounts").then(value => { if (active) setOverview(value); }).catch(() => {});
    if (canManage) request<{ features?: FeatureState[] }>("/api/cloudflare").then(value => { if (active) setPreviews(value.features?.find(item => item.feature === "previews")?.granted ?? null); }).catch(() => {});
    return () => { active = false; };
  }, [repositoryId, canManage]);
  if (!overview) return null;
  const account = effectiveAccount(overview, repositoryId);
  if (!account || previews === false) return <p className="cf-preview-account">Previews run on Gitflare's shared previews Worker<InfoTip label="Preview account">{canManage ? <>To preview on your own account, <a href="/settings/cloudflare">grant the Previews permission in Settings → Cloudflare</a>.</> : "An Owner can grant the Previews permission in Settings → Cloudflare to preview on this repository's own account."}</InfoTip></p>;
  return <p className="cf-preview-account">Previews run on Cloudflare account {account.name} ({account.id.slice(0, 4)}…{account.id.slice(-4)})<InfoTip label="Preview account">Account ID {account.id}. Gitflare creates the repository's Worker there on the first preview if it does not exist yet.</InfoTip></p>;
}
