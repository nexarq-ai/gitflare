import { useEffect, useRef, useState } from "react";
import { PreviewAccountLine } from "./AccountPicker";
import InfoTip from "./InfoTip";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { request } from "./api";
import { ErrorNotice } from "./components";
import DemoFeaturePanel, { demoOf } from "./DemoFeaturePanel";
import type { DemoMarked } from "../shared/demo-features";

type AccessMode = "link" | "cloudflare-access";
type Snapshot = DemoMarked & {
  repositoryId: string;
  canChange: boolean;
  settings: { lifetimeMinutes: number; access: AccessMode; accessEmailDomains: string[]; previewEmailRecipients: string[]; targetWorker?: string; updatedAt?: string };
  email: { recipients: string[]; blocked: boolean; description: string };
  lifetime: { minutes: number; choices: number[]; maxMinutes: number };
  target: { workerName: string; configPath?: string; accountId?: string; connection?: "repository" | "workspace"; connectionCanPreview: boolean } | null;
  access: { description: string; containerDescription: string; cloudflareAccess: { available: boolean; reason?: string } };
  accessApp?: { domain: string; accountId: string; workerName: string };
};

const LIFETIME_LABELS: Record<number, string> = { 15: "15 minutes", 60: "1 hour", 240: "4 hours", 1440: "24 hours" };
const PREVIEW_ACCESS_TIP = "Only the allowed emails or email domains can sign in to Worker Preview URLs.";
const previewUrlExample = (worker?: string) => `pr-<id>-${worker || "<worker>"}.<subdomain>.workers.dev`;
const domainsText = (domains: string[]) => domains.join("\n");
const parseDomains = (text: string) => text.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);

export default function PreviewSettings({ repositoryId, canManage = false, onNotify }: { repositoryId: string; canManage?: boolean; onNotify: (message: string) => void }) {
  const path = `/api/repositories/${encodeURIComponent(repositoryId)}/preview-settings`;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [lifetime, setLifetime] = useState(15);
  const [access, setAccess] = useState<AccessMode>("link");
  const [domains, setDomains] = useState("");
  const [targetWorker, setTargetWorker] = useState("");
  const [recipients, setRecipients] = useState("");
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mutation = useRef<{ signature: string; key: string } | null>(null);

  function show(current: Snapshot) {
    setSnapshot(current);
    if (demoOf(current)) return;
    setLifetime(current.settings.lifetimeMinutes);
    setAccess(current.settings.access);
    setDomains(domainsText(current.settings.accessEmailDomains));
    setTargetWorker(current.settings.targetWorker ?? "");
    setRecipients(domainsText(current.settings.previewEmailRecipients));
  }

  useEffect(() => {
    let active = true;
    setLoadError("");
    request<Snapshot>(path)
      .then((current) => { if (active) show(current); })
      .catch((failure) => { if (active) setLoadError(failure instanceof Error ? failure.message : "Preview settings could not be loaded."); });
    return () => { active = false; };
  }, [path, attempt]);

  async function save() {
    if (busy || !snapshot) return;
    const body = { lifetimeMinutes: lifetime, access, accessEmailDomains: parseDomains(domains), previewEmailRecipients: parseDomains(recipients), targetWorker: targetWorker.trim() };
    const signature = JSON.stringify(body);
    if (mutation.current?.signature !== signature) mutation.current = { signature, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const saved = await request<Snapshot>(path, body, mutation.current.key);
      mutation.current = null;
      show(saved);
      onNotify(saved.accessApp ? `Preview settings saved. Cloudflare Access now protects ${saved.accessApp.domain}.` : "Preview settings saved. New previews use them.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Preview settings could not be saved.");
    } finally { setBusy(false); }
  }

  if (loadError) return <ErrorNotice message={loadError} onRetry={() => setAttempt((value) => value + 1)} />;
  if (!snapshot) return null;
  const demo = demoOf(snapshot);
  if (demo) return <DemoFeaturePanel demo={demo} examples={snapshot.examples} />;
  const { canChange, target } = snapshot;
  const accessAvailable = snapshot.access.cloudflareAccess.available;
  return (
    <section className="panel check-settings">
      <div className="panel-header"><h2>Previews</h2></div>
      <div className="panel-body"><PreviewAccountLine repositoryId={repositoryId} canManage={canManage} />
        {target && (
          <p className="branch-rule-note">
            Previews of <code>{target.workerName}</code>
            <InfoTip label="Preview Worker">{target.connectionCanPreview ? "Each preview is a Cloudflare Worker Preview of this Worker. Gitflare creates the Worker with workers.dev and Previews on if it does not exist yet." : "A Cloudflare connection with the Previews permission is needed for Worker Previews of this Worker; until then previews use the installation previews Worker or a preview container."}</InfoTip>
          </p>
        )}
        {!canChange && <p className="branch-rule-note">Only Owners can change preview settings.</p>}
        <fieldset className="check-settings-fields" disabled={!canChange || busy}>
          <div className="form-field">
            <span className="field-label"><label htmlFor="preview-lifetime">Preview lifetime</label><InfoTip label="Preview lifetime">Max {LIFETIME_LABELS[snapshot.lifetime.maxMinutes] ?? `${snapshot.lifetime.maxMinutes} minutes`} on this installation. Owners/Maintainers can extend once. When it ends the preview is deleted and its slot released.</InfoTip></span>
            <select id="preview-lifetime" value={lifetime} onChange={(event) => setLifetime(Number(event.target.value))}>
              {snapshot.lifetime.choices.map((minutes) => <option key={minutes} value={minutes}>{LIFETIME_LABELS[minutes] ?? `${minutes} minutes`}</option>)}
            </select>
          </div>
          <div className="form-field">
            <span className="field-label"><label htmlFor="preview-target">Preview Worker <span className="proposal-optional">(optional)</span></label><InfoTip label="Preview Worker">For repositories with several Workers. Empty uses the deploy target for the root Wrangler config, or its name.</InfoTip></span>
            <Input id="preview-target" maxLength={63} value={targetWorker} placeholder={target?.workerName ?? "my-worker"} onChange={(event) => setTargetWorker(event.target.value.toLowerCase())} />
          </div>
        </fieldset>
        <fieldset className="check-settings-fields" disabled={!canChange || busy}>
          <label className="check-settings-toggle"><input type="radio" name="preview-access" checked={access === "link"} onChange={() => setAccess("link")} />Cloudflare preview URL (<code>{previewUrlExample(targetWorker.trim() || target?.workerName)}</code>)<InfoTip label="Cloudflare preview URL">Anyone with the link can open it. {snapshot.access.containerDescription}</InfoTip></label>
          <label className="check-settings-toggle"><input type="radio" name="preview-access" checked={access === "cloudflare-access"} disabled={!accessAvailable && access !== "cloudflare-access"} onChange={() => setAccess("cloudflare-access")} />{accessAvailable ? "Cloudflare Access" : "Cloudflare Access — not available for workers.dev URLs"}<InfoTip label="Cloudflare Access">{accessAvailable ? PREVIEW_ACCESS_TIP : snapshot.access.cloudflareAccess.reason}</InfoTip></label>
          {access === "cloudflare-access" && (
            <div className="form-field">
              <span className="field-label"><label htmlFor="preview-domains">Allowed email domains <span className="proposal-optional">(optional)</span></label><InfoTip label="Allowed email domains">One per line, for example example.com. Empty allows every workspace member who can read this repository.</InfoTip></span>
              <textarea id="preview-domains" rows={2} value={domains} placeholder="example.com" onChange={(event) => setDomains(event.target.value)} />
            </div>
          )}
        </fieldset>
        <fieldset className="check-settings-fields" disabled={!canChange || busy}>
          <div className="form-field">
            <span className="field-label"><label htmlFor="preview-email-recipients">Preview email recipients</label><InfoTip label="Preview email recipients">One per line, max 50. Exact addresses only; empty blocks all preview email. Staging and production are unaffected.</InfoTip></span>
            <textarea id="preview-email-recipients" rows={3} value={recipients} placeholder="person@example.com" onChange={(event) => setRecipients(event.target.value)} />
            <small>{snapshot.email.blocked ? "Preview email is blocked." : `Previews may email ${snapshot.email.recipients.length} address${snapshot.email.recipients.length === 1 ? "" : "es"}.`}</small>
          </div>
        </fieldset>
        {error && <div className="error-notice" role="alert">{error}</div>}
        {canChange && <div className="branch-rule-actions"><Button variant="primary" size="base" loading={busy} disabled={busy} onClick={() => void save()}>Save preview settings</Button></div>}
      </div>
    </section>
  );
}
