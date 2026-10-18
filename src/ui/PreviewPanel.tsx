import { useEffect, useState } from "react";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { ArrowClockwiseIcon, ArrowSquareOutIcon, CheckCircleIcon, CheckIcon, CircleNotchIcon, ClockIcon, CopyIcon, StopIcon, WarningCircleIcon } from "@phosphor-icons/react";
import InfoTip from "./InfoTip";
import { previewProgressLine, type PreviewProgress } from "../shared/preview-progress";
import "./preview-panel.css";

export type PreviewHost =
  | { kind: "connection"; source: "repository" | "workspace"; accountId: string; workerName: string; access: "link" | "cloudflare-access" }
  | { kind: "installation"; accountId: string; workerName: string; access: "link" };
export type PreviewAccess = "link" | "cloudflare-access" | "members";
export type PreviewState = {
  previewUrl: string;
  candidateSha: string;
  expiresAt: string;
  linkExpiresAt?: string;
  extended: boolean;
  access: PreviewAccess;
  worker?: { deploymentUrl: string | null; notes: string[]; host?: PreviewHost };
  notes?: string[];
};

const ACCESS_LABEL: Record<PreviewAccess, string> = { link: "Public link", "cloudflare-access": "Cloudflare Access", members: "Members only" };
const ACCESS_TEXT: Record<PreviewAccess, string> = {
  link: "Anyone with the link can open it. Search engines are asked not to index it.",
  "cloudflare-access": "Only allowed workspace members or email domains can sign in.",
  members: "Works for signed-in workspace members until the preview expires.",
};

export function remaining(until: string, now: number): string {
  const seconds = Math.max(0, Math.round((Date.parse(until) - now) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours} h ${String(minutes).padStart(2, "0")} min` : `${minutes}:${rest}`;
}

function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function Countdown({ until }: { until: string }) {
  const now = useNow();
  return <span className="preview-card-meta" title={`Retires at ${new Date(until).toLocaleTimeString()}`} aria-live="off"><ClockIcon size={13} aria-hidden="true" />{remaining(until, now)} left</span>;
}

export function hostSummary(preview: PreviewState): { label: string; account?: string; via?: string } {
  const host = preview.worker?.host;
  if (!preview.worker) return { label: "Isolated container on Gitflare’s preview origin" };
  if (!host) return { label: "Cloudflare Worker Preview" };
  if (host.kind === "connection") return { label: `Worker Preview of ${host.workerName}`, account: host.accountId, via: `${host.source} Cloudflare connection` };
  return { label: `Installation previews Worker ${host.workerName}`, account: host.accountId };
}

export function failureHeadline(message: string): string {
  const line = message.split("\n").map((part) => part.trim()).find(Boolean) ?? "The preview stopped before it was ready.";
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

function displayUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
}

function CopyUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <Button variant="ghost" size="sm" shape="square" icon={copied ? CheckIcon : CopyIcon} aria-label={copied ? "Preview link copied" : "Copy preview link"} title={copied ? "Copied" : "Copy link"} onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true)).catch(() => {})} />;
}

export function PreviewReadyCard({ preview, busy, canExtend, canStop, onExtend, onStop }: { preview: PreviewState; busy: string; canExtend: boolean; canStop: boolean; onExtend: () => void; onStop: () => void }) {
  const host = hostSummary(preview);
  const notes = preview.worker?.notes ?? preview.notes ?? [];
  const deploymentUrl = preview.worker?.deploymentUrl;
  return <section className="preview-card" data-state="ready" aria-label="Candidate preview">
    <div className="preview-card-head">
      <CheckCircleIcon size={17} weight="fill" className="preview-card-icon" aria-hidden="true" />
      <strong>Preview ready</strong>
      <code className="preview-card-sha" title={preview.candidateSha}>{preview.candidateSha.slice(0, 7)}</code>
      <span className="preview-card-access">{ACCESS_LABEL[preview.access]}<InfoTip label={ACCESS_LABEL[preview.access]}>{ACCESS_TEXT[preview.access]}</InfoTip></span>
      <Countdown until={preview.expiresAt} />
    </div>
    <div className="preview-card-url">
      <a href={preview.previewUrl} target="_blank" rel="noreferrer">{displayUrl(preview.previewUrl)}</a>
      <CopyUrl url={preview.previewUrl} />
    </div>
    <div className="preview-card-actions">
      <LinkButton variant="primary" size="sm" href={preview.previewUrl} external icon={ArrowSquareOutIcon}>Open preview</LinkButton>
      {canExtend && !preview.extended && <span className="preview-card-action">
        <Button variant="secondary" size="sm" icon={ClockIcon} loading={busy === "preview-extend"} disabled={!!busy} onClick={onExtend}>Extend</Button>
        <InfoTip label="Extend">Keeps this preview for one more preview lifetime. You can extend once.</InfoTip>
      </span>}
      {canStop && <span className="preview-card-action">
        <Button variant="secondary" size="sm" icon={StopIcon} loading={busy === "preview-stop"} disabled={!!busy} onClick={onStop}>Stop</Button>
        <InfoTip label="Stop">Retires the preview now and frees one of the workspace’s preview slots.</InfoTip>
      </span>}
    </div>
    <details className="preview-card-details">
      <summary>Details</summary>
      <dl>
        <dt>Host</dt><dd>{host.label}</dd>
        {host.account && <><dt>Account</dt><dd><code>{host.account}</code>{host.via && <> · {host.via}</>}</dd></>}
        <dt>Retires</dt><dd>{new Date(preview.expiresAt).toLocaleTimeString()}{preview.extended ? " · extended" : ""}</dd>
        {preview.linkExpiresAt && preview.linkExpiresAt < preview.expiresAt && <><dt>Link</dt><dd>Works until {new Date(preview.linkExpiresAt).toLocaleTimeString()}. Refresh the preview for a new one.</dd></>}
        {deploymentUrl && <><dt>Deployment</dt><dd><a href={deploymentUrl} target="_blank" rel="noreferrer">Deployment URL <ArrowSquareOutIcon size={11} aria-hidden="true" /></a></dd></>}
      </dl>
      {notes.length > 0 && <ul className="preview-card-notes">{notes.map((note) => <li key={note}>{note}</li>)}</ul>}
    </details>
  </section>;
}

export function PreviewStartingCard({ progress }: { progress: PreviewProgress }) {
  const now = useNow();
  return <section className="preview-card" data-state="starting" role="status" aria-label="Candidate preview">
    <div className="preview-card-head">
      <CircleNotchIcon size={17} className="preview-card-icon preview-card-spin" aria-hidden="true" />
      <strong>Preparing preview</strong>
      <span className="preview-card-meta">{previewProgressLine(progress, now)}</span>
      {progress.message && <InfoTip label="Preparing preview">{progress.message}</InfoTip>}
    </div>
  </section>;
}

export function PreviewFailedCard({ message, canRetry, busy, onRetry }: { message: string; canRetry: boolean; busy: string; onRetry: () => void }) {
  const headline = failureHeadline(message);
  return <section className="preview-card" data-state="failed" role="alert" aria-label="Candidate preview">
    <div className="preview-card-head">
      <WarningCircleIcon size={17} className="preview-card-icon" aria-hidden="true" />
      <strong>Preview failed</strong>
      <span className="preview-card-reason">{headline}</span>
    </div>
    {canRetry && <div className="preview-card-actions">
      <Button variant="secondary" size="sm" icon={ArrowClockwiseIcon} loading={busy === "preview"} disabled={!!busy} onClick={onRetry}>Retry</Button>
    </div>}
    {message.trim() !== headline && <details className="preview-card-details">
      <summary>Show log</summary>
      <pre tabIndex={0}>{message}</pre>
    </details>}
  </section>;
}
