import { useEffect, useRef, useState } from "react";
import InfoTip from "./InfoTip";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { request } from "./api";
import { ErrorNotice, relativeTime } from "./components";
import { RouteProgress } from "./WorkspaceLoader";
import DemoFeaturePanel, { demoOf } from "./DemoFeaturePanel";
import type { DemoMarked } from "../shared/demo-features";
import { PREVIEW_SECRET_ENVIRONMENT, type SecretAction, type SecretLinkView, type SecretRequirementView } from "../shared/secrets";
import "./cloudflare-connection.css";
import "./check-settings.css";
import "./pull-requests.css";
import "./secret-settings.css";

type Connection = { connected: false; reason: string; requiredScopes: string[] } | { connected: true; source: "repository" | "workspace"; accountId: string; requiredScopes: string[]; missingScopes: string[]; canRead: boolean; canWrite: boolean };
interface Snapshot extends DemoMarked { repositoryId: string; canManage: boolean; environments: string[]; links: SecretLinkView[]; requirements: SecretRequirementView[]; missing: Record<string, string[]>; requirementErrors: string[]; connection: Connection; valuePolicy: string }
interface Catalog { stores: { id: string; name: string }[]; storeId?: string; secrets?: { id: string; name: string; scopes: string[] }[] }
type Mode = "link" | "create";

const environmentLabel = (environment: string) => environment === "production" ? "Production" : environment === "staging" ? "Staging" : environment === PREVIEW_SECRET_ENVIRONMENT ? "Previews" : environment;
const validationLabel: Record<SecretLinkView["validation"]["status"], string> = { valid: "Verified", not_found: "Missing in store", not_workers_scoped: "Not scoped to Workers", unchecked: "Not checked" };
const parseList = (text: string) => text.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);

export default function SecretSettings({ repositoryId, onNotify }: { repositoryId: string; onNotify: (message: string) => void }) {
  const path = `/api/repositories/${encodeURIComponent(repositoryId)}/secrets`;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [environment, setEnvironment] = useState("production");
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [mode, setMode] = useState<Mode>("link");
  const [binding, setBinding] = useState("");
  const [storeId, setStoreId] = useState("");
  const [secretId, setSecretId] = useState("");
  const [secretName, setSecretName] = useState("");
  const [value, setValue] = useState("");
  const [comment, setComment] = useState("");
  const [consumers, setConsumers] = useState("");
  const [previewAllowed, setPreviewAllowed] = useState(false);
  const [rotating, setRotating] = useState<string | null>(null);
  const [rotation, setRotation] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const keys = useRef(new Map<string, string>());

  useEffect(() => {
    let active = true;
    setLoadError("");
    request<Snapshot>(path)
      .then((current) => { if (!active) return; setSnapshot(current); if (demoOf(current)) return; setEnvironment((selected) => current.environments.includes(selected) ? selected : current.environments[0]); })
      .catch((failure) => { if (active) setLoadError(failure instanceof Error ? failure.message : "Secrets could not be loaded."); });
    return () => { active = false; };
  }, [path, attempt]);

  async function loadCatalog(store = "") {
    try { setCatalog(await request<Catalog>(`${path}/catalog${store ? `?store_id=${store}` : ""}`)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The Secrets Store catalog could not be loaded."); }
  }

  useEffect(() => {
    if (snapshot?.canManage && snapshot.connection.connected && snapshot.connection.canRead && !catalog) void loadCatalog();
  }, [snapshot]);

  function idempotencyKey(signature: string): string {
    const existing = keys.current.get(signature);
    if (existing) return existing;
    const key = crypto.randomUUID();
    keys.current.set(signature, key);
    return key;
  }

  async function act(action: SecretAction, fields: Record<string, unknown>, done: string, secret?: string) {
    if (busy) return;
    const signature = JSON.stringify([action, fields, secret !== undefined]);
    setBusy(action);
    setError("");
    try {
      await request(path, { action, ...fields, ...(secret !== undefined ? { value: secret } : {}) }, idempotencyKey(signature));
      keys.current.delete(signature);
      onNotify(done);
      setAttempt((count) => count + 1);
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The secret change failed.");
      return false;
    } finally { setBusy(""); }
  }

  async function connectSecretsStore() {
    if (!snapshot?.connection.connected || busy) return;
    setBusy("connect");
    setError("");
    try {
      const endpoint = snapshot.connection.source === "repository" ? `/api/repositories/${encodeURIComponent(repositoryId)}/cloudflare/connection/connect` : "/api/cloudflare/connect";
      const result = await request<{ authorizationUrl: string }>(endpoint, { secrets: true });
      window.location.assign(result.authorizationUrl);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Cloudflare could not be reconnected.");
      setBusy("");
    }
  }

  async function submit() {
    const fields = { environment, binding: binding.trim(), storeId, ...(consumers.trim() ? { consumers: parseList(consumers) } : {}), ...(environment === PREVIEW_SECRET_ENVIRONMENT ? { previewAllowed } : {}) };
    const secret = value;
    setValue("");
    const ok = mode === "create"
      ? await act("create", { ...fields, secretName: secretName.trim(), ...(comment.trim() ? { comment: comment.trim() } : {}) }, `Created ${secretName.trim()} in Secrets Store and linked it to ${fields.binding}.`, secret)
      : await act("link", { ...fields, ...(secretId ? { secretId } : { secretName: secretName.trim() }) }, `Linked ${fields.binding} in ${environmentLabel(environment)}.`);
    if (ok) { setBinding(""); setSecretId(""); setSecretName(""); setComment(""); setConsumers(""); setPreviewAllowed(false); }
  }

  async function rotate(link: SecretLinkView) {
    const secret = rotation;
    setRotation("");
    if (await act("rotate", { environment: link.environment, binding: link.binding }, `Rotated ${link.secretName}. New deploys and previews read the new value.`, secret)) setRotating(null);
  }

  if (loadError) return <ErrorNotice message={loadError} onRetry={() => setAttempt((count) => count + 1)} />;
  if (!snapshot) return <RouteProgress />;
  const demo = demoOf(snapshot);
  if (demo) return <DemoFeaturePanel demo={demo} examples={snapshot.examples} />;
  const { connection, canManage } = snapshot;
  const links = snapshot.links.filter((link) => link.environment === environment);
  const requirements = snapshot.requirements.filter((item) => item.environment === environment);
  const missing = snapshot.missing[environment] ?? [];
  const canWrite = canManage && connection.connected && connection.canWrite;
  const canLink = canManage && connection.connected && connection.canRead;
  const preview = environment === PREVIEW_SECRET_ENVIRONMENT;
  const formReady = binding.trim() && storeId && (mode === "create" ? secretName.trim() && value : secretId || secretName.trim());

  return (
    <section className="panel check-settings secret-settings" aria-label="Secrets">
      <div className="panel-header"><h2>Secrets</h2></div>
      <div className="panel-body">
        <p className="branch-rule-note">Link Cloudflare Secrets Store secrets to this repository per environment. Deploys bind them as <code>secrets_store_secrets</code>; read them in the Worker with <code>await env.BINDING.get()</code>. {snapshot.valuePolicy}</p>
        {!connection.connected ? <p className="cf-muted" role="status">{connection.reason} Connect Cloudflare in the repository’s Cloudflare tab first.</p>
          : connection.missingScopes.length > 0 && <div className="secret-connect" role="status">
            <p>The {connection.source} Cloudflare connection on <code>{connection.accountId}</code> was not granted {connection.missingScopes.join(", ")}. {canManage ? "Reconnect with Secrets Store access to link, create and rotate secrets." : "An Owner must reconnect with Secrets Store access."}</p>
            {canManage && <Button variant="primary" size="base" loading={busy === "connect"} disabled={!!busy} onClick={() => void connectSecretsStore()}>Connect Secrets Store</Button>}
          </div>}
        {!canManage && <p className="branch-rule-note">Only a workspace Owner, or a member granted secret deploy access to this repository, can change its secrets.</p>}
        <div className="secret-toggle" role="group" aria-label="Environment">
          {snapshot.environments.map((name) => <button key={name} type="button" aria-pressed={name === environment} onClick={() => { setEnvironment(name); setError(""); setRotating(null); }}>{environmentLabel(name)}{(snapshot.missing[name]?.length ?? 0) > 0 && <span className="secret-missing-count" aria-label={`${snapshot.missing[name].length} missing`}>{snapshot.missing[name].length}</span>}</button>)}
        </div>
        {preview && <p className="branch-rule-note">Worker Previews receive only secrets linked here and allowed for previews. Use separate test credentials: production and staging links never reach previews, and coding agents never receive secrets.</p>}
        {snapshot.requirementErrors.map((item) => <p key={item} className="cf-muted">{item}</p>)}
        {missing.length > 0 && <div className="error-notice" role="alert">{environmentLabel(environment)} deploys are blocked until {missing.join(", ")} {missing.length === 1 ? "is" : "are"} linked.</div>}
        {requirements.length > 0 && (
          <div className="secret-requirements">
            <h3>Required by the Wrangler config</h3>
            <ul className="cf-target-runs">
              {requirements.map((item) => (
                <li key={`${item.binding}-${item.workerName}`}>
                  <strong>{item.binding}</strong> · {item.workerName} · <code>{item.configPath}</code> ({item.source}) · {item.linkId ? <span className="secret-ok">Linked</span> : <span className="secret-bad">Missing</span>}
                  {!item.linkId && canLink && <Button variant="secondary" size="sm" onClick={() => { setMode("link"); setBinding(item.binding); setSecretName(item.declared?.secretName ?? ""); setSecretId(""); if (item.declared?.storeId) { setStoreId(item.declared.storeId); void loadCatalog(item.declared.storeId); } }}>Link</Button>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {links.length ? (
          <table className="cf-deployments secret-links">
            <thead><tr><th>Binding</th><th>Secret</th><th>Workers</th><th>Status</th><th>Rotated</th>{canManage && <th><span className="visually-hidden">Actions</span></th>}</tr></thead>
            <tbody>
              {links.map((link) => (
                <tr key={link.id}>
                  <td><code>{link.binding}</code></td>
                  <td>{link.secretName}<div className="cf-state">store <code>{link.storeId.slice(0, 8)}</code> · {link.origin === "created" ? "created here" : "linked"}</div></td>
                  <td>{link.consumers.length ? link.consumers.join(", ") : "All"}{preview && <div className="cf-state">{link.previewAllowed ? "Allowed in previews" : "Not allowed in previews"}</div>}</td>
                  <td>{validationLabel[link.validation.status]}<div className="cf-state">checked {relativeTime(link.validation.checkedAt)}</div></td>
                  <td>{link.rotatedAt ? relativeTime(link.rotatedAt) : "Never"}</td>
                  {canManage && <td>
                    <div className="secret-actions">
                      {canWrite && <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => { setRotating(rotating === link.id ? null : link.id); setRotation(""); }}>Rotate</Button>}
                      {canLink && <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => void act("validate", { environment, binding: link.binding }, `Checked ${link.secretName} in Secrets Store.`)}>Check</Button>}
                      {preview && <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => void act("update", { environment, binding: link.binding, previewAllowed: !link.previewAllowed }, link.previewAllowed ? `${link.binding} is no longer bound in previews.` : `${link.binding} is bound in new previews.`)}>{link.previewAllowed ? "Disallow in previews" : "Allow in previews"}</Button>}
                      <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => void act("unlink", { environment, binding: link.binding }, `Unlinked ${link.binding}. The secret stays in Secrets Store.`)}>Unlink</Button>
                    </div>
                    {rotating === link.id && (
                      <form className="secret-rotate" onSubmit={(event) => { event.preventDefault(); void rotate(link); }}>
                        <label htmlFor={`rotate-${link.id}`}>New value for {link.secretName}</label>
                        <Input id={`rotate-${link.id}`} type="password" autoComplete="off" spellCheck={false} value={rotation} onChange={(event) => setRotation(event.target.value)} />
                        <Button variant="primary" size="sm" type="submit" loading={busy === "rotate"} disabled={!rotation || !!busy}>Rotate value</Button>
                      </form>
                    )}
                  </td>}
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="cf-muted">No secrets are linked to {environmentLabel(environment)}.</p>}
        {canLink && (
          <form className="secret-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <h3>Add a secret to {environmentLabel(environment)}</h3>
            <div className="secret-toggle" role="group" aria-label="Secret source">
              <button type="button" aria-pressed={mode === "link"} onClick={() => setMode("link")}>Link existing</button>
              <button type="button" aria-pressed={mode === "create"} disabled={!canWrite} onClick={() => setMode("create")}>Create new</button>
            </div>
            <fieldset className="check-settings-fields" disabled={!!busy}>
              <div className="form-field">
                <span className="field-label"><label htmlFor="secret-binding">Binding name</label><InfoTip label="Binding name">The name your Worker code reads, for example env.STRIPE_KEY. Use capitals and underscores.</InfoTip></span>
                <Input id="secret-binding" maxLength={64} value={binding} placeholder="STRIPE_KEY" onChange={(event) => setBinding(event.target.value)} />
              </div>
              <div className="form-field">
                <span className="field-label"><label htmlFor="secret-store">Store</label><InfoTip label="Store">The Cloudflare Secrets Store that holds the value. Gitflare links to it and never shows the value.</InfoTip></span>
                <select id="secret-store" value={storeId} onChange={(event) => { setStoreId(event.target.value); setSecretId(""); if (event.target.value) void loadCatalog(event.target.value); }}>
                  <option value="">Choose a store</option>
                  {(catalog?.stores ?? []).map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
                </select>
                {catalog && !catalog.stores.length && <small>This account has no Secrets Store yet.{canWrite && <> <button type="button" className="secret-inline-button" onClick={() => void act("create-store", { name: "default_secrets_store" }, "Created a Secrets Store.").then(() => loadCatalog())}>Create one</button></>}</small>}
              </div>
              {mode === "link" ? (
                <div className="form-field">
                  <span className="field-label"><label htmlFor="secret-existing">Secret</label><InfoTip label="Secret">Pick a secret that already exists in the store.</InfoTip></span>
                  <select id="secret-existing" value={secretId} disabled={!catalog?.secrets} onChange={(event) => { setSecretId(event.target.value); setSecretName(""); }}>
                    <option value="">{catalog?.secrets ? "Choose a secret" : "Choose a store first"}</option>
                    {(catalog?.storeId === storeId ? catalog.secrets ?? [] : []).map((secret) => <option key={secret.id} value={secret.id} disabled={!secret.scopes.includes("workers")}>{secret.name}{secret.scopes.includes("workers") ? "" : " (not scoped to Workers)"}</option>)}
                  </select>
                </div>
              ) : (
                <>
                  <div className="form-field">
                    <span className="field-label"><label htmlFor="secret-name">Secret name in the store</label><InfoTip label="Secret name in the store">The name the secret gets in Cloudflare. Other Workers in the account can find it by this name.</InfoTip></span>
                    <Input id="secret-name" maxLength={255} value={secretName} placeholder="stripe_live_key" onChange={(event) => setSecretName(event.target.value)} />
                  </div>
                  <div className="form-field">
                    <span className="field-label"><label htmlFor="secret-value">Value</label><InfoTip label="Value">Sent once to Cloudflare and never stored or shown by Gitflare.</InfoTip></span>
                    <Input id="secret-value" type="password" autoComplete="off" spellCheck={false} value={value} onChange={(event) => setValue(event.target.value)} />
                    <small>Sent once to Cloudflare Secrets Store. Gitflare never stores or shows it again.</small>
                  </div>
                  <div className="form-field">
                    <span className="field-label"><label htmlFor="secret-comment">Comment <span className="proposal-optional">(optional)</span></label><InfoTip label="Comment">A note shown in Cloudflare next to the secret, for example who owns it.</InfoTip></span>
                    <Input id="secret-comment" maxLength={300} value={comment} onChange={(event) => setComment(event.target.value)} />
                  </div>
                </>
              )}
              <div className="form-field">
                <span className="field-label"><label htmlFor="secret-consumers">Workers <span className="proposal-optional">(optional)</span></label><InfoTip label="Workers">Only these Workers get the binding. Leave empty to bind it to every Worker this repository deploys.</InfoTip></span>
                <Input id="secret-consumers" value={consumers} placeholder="All Workers in this environment" onChange={(event) => setConsumers(event.target.value)} />
                <small>Comma-separated Worker names that receive the binding. Empty binds every Worker this environment deploys.</small>
              </div>
              {preview && <label className="check-settings-toggle"><input type="checkbox" checked={previewAllowed} onChange={(event) => setPreviewAllowed(event.target.checked)} />Allow Worker Previews to bind this secret<InfoTip label="Previews and secrets">Previews of proposals can read this secret. Leave it off for production-only values such as live payment keys.</InfoTip></label>}
            </fieldset>
            {error && <div className="error-notice" role="alert">{error}</div>}
            <div className="branch-rule-actions"><Button variant="primary" size="base" type="submit" loading={busy === "link" || busy === "create"} disabled={!formReady || !!busy}>{mode === "create" ? "Create and link" : "Link secret"}</Button></div>
          </form>
        )}
        {!canLink && error && <div className="error-notice" role="alert">{error}</div>}
      </div>
    </section>
  );
}
