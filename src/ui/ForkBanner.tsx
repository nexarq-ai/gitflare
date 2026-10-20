import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { ArrowsClockwiseIcon, GitForkIcon } from "@phosphor-icons/react";
import type { ForkStatus, ForkSyncResult, ForkSyncState, Repository } from "../shared/types";
import { request } from "./api";
import { useConfirm } from "./ConfirmDialog";
import InfoTip from "./InfoTip";
import "./forks.css";

const SYNC_LABELS: Record<ForkSyncState, string> = { "up-to-date": "Up to date", behind: "Behind upstream", ahead: "Ahead of upstream", diverged: "Diverged", unknown: "Upstream unavailable" };

export function storageLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

export default function ForkBanner({ repository, onNotify, onChanged }: { repository: Repository; onNotify: (message: string) => void; onChanged: () => void }) {
  const [status, setStatus] = useState<ForkStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, dialog] = useConfirm();
  const key = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    request<ForkStatus>(`/api/repositories/${encodeURIComponent(repository.id)}/fork`).then(value => { if (active) setStatus(value); }).catch(failure => { if (active) setError(failure instanceof Error ? failure.message : "The upstream could not be read."); });
    return () => { active = false; };
  }, [repository.id, repository.headSha]);

  async function sync() {
    if (!status || busy) return;
    const confirmed = await confirm({ title: `Sync ${status.defaultBranch} from ${status.upstream.label}?`, description: `Moves ${status.defaultBranch} forward to the upstream head. Your streams don't change.`, confirmLabel: "Sync", facts: [{ label: "From", value: status.headSha?.slice(0, 12) ?? "—", code: true }, { label: "To", value: status.upstream.headSha?.slice(0, 12) ?? "—", code: true }] });
    if (!confirmed) return;
    key.current ??= crypto.randomUUID();
    setBusy(true); setError("");
    try {
      const result = await request<ForkSyncResult>(`/api/repositories/${encodeURIComponent(repository.id)}/fork/sync`, {}, key.current);
      key.current = null;
      setStatus(result.status);
      onNotify(result.updated ? `${status.defaultBranch} is up to date with ${status.upstream.label}.` : "Already up to date.");
      onChanged();
    } catch (failure) {
      key.current = null;
      setError(failure instanceof Error ? failure.message : "The fork could not be synced.");
    } finally { setBusy(false); }
  }

  const label = status?.upstream.label ?? repository.fork?.upstream.label ?? "";
  return <section className="fork-banner" aria-label="Fork">
    <GitForkIcon size={18} aria-hidden="true" className="fork-banner-icon" />
    <div className="fork-banner-text">
      <span>Forked from {status?.upstream.url ? <a href={status.upstream.url} target="_blank" rel="noopener noreferrer">{label}</a> : <strong>{label}</strong>}</span>
      {status && <span className={`fork-sync fork-sync-${status.sync}`}>{SYNC_LABELS[status.sync]}</span>}
      <InfoTip label="this fork">Push streams here with a personal token created in this workspace, then propose them upstream. {status ? `Uses ${storageLabel(status.storage.usedBytes)} of ${storageLabel(status.storage.limitBytes)}.` : "Holds up to 1 GiB."}</InfoTip>
    </div>
    {error && <span className="fork-banner-error" role="alert">{error}</span>}
    <div className="fork-banner-actions">
      {status?.sync === "behind" && <Button variant="secondary" size="sm" icon={ArrowsClockwiseIcon} loading={busy} disabled={busy || !status.canSync} onClick={() => void sync()}>Sync</Button>}
    </div>
    {dialog}
  </section>;
}
