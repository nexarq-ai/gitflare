import { useEffect, useRef, useState, type DragEvent } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { CopyIcon, DownloadSimpleIcon, FileIcon, LinkIcon, TrashIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import type { Release, ReleaseAsset, ReleaseAssetUsage } from "../shared/types";
import { request, selectedWorkspace } from "./api";
import { useConfirm } from "./ConfirmDialog";
import InfoTip from "./InfoTip";
import { assetProblem, byteLabel, shortHash } from "./advisory-data";
import "./advisories.css";

type Upload = { name: string; loaded: number; total: number; hashing?: boolean };

class UploadError extends Error {
  constructor(message: string, public code?: string) { super(message); }
}

export function assetUploadUrl(repositoryId: string, releaseId: string, name: string): string {
  return `/api/repositories/${repositoryId}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function uploadAsset(url: string, file: File, sha256: string, onProgress: (loaded: number) => void): Promise<ReleaseAsset> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("Idempotency-Key", crypto.randomUUID());
    xhr.setRequestHeader("X-Content-SHA256", sha256);
    const workspace = selectedWorkspace();
    if (workspace) xhr.setRequestHeader("X-Gitflare-Workspace", workspace);
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded); };
    xhr.onerror = () => reject(new UploadError("The upload was interrupted. Check your connection and try again.", "NETWORK"));
    xhr.onabort = () => reject(new UploadError("The upload was cancelled.", "ABORTED"));
    xhr.onload = () => {
      let data: unknown = null;
      try { data = JSON.parse(xhr.responseText); } catch { data = null; }
      if (xhr.status >= 200 && xhr.status < 300 && data && typeof data === "object" && "id" in data) resolve(data as ReleaseAsset);
      else {
        const error = data && typeof data === "object" && "error" in data ? (data as { error: { code?: string; message?: string } }).error : null;
        reject(new UploadError(error?.message ?? `The upload failed (${xhr.status}). Try again.`, error?.code));
      }
    };
    xhr.send(file);
  });
}

export default function ReleaseAssets({ repositoryId, release, usage, canLand, onChanged }: { repositoryId: string; release: Release; usage?: ReleaseAssetUsage; canLand: boolean; onChanged: () => void }) {
  const [assets, setAssets] = useState<ReleaseAsset[]>(release.assets ?? []);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [confirm, confirmDialog] = useConfirm();

  useEffect(() => { setAssets(release.assets ?? []); }, [release.assets]);

  if (!release.assets && !usage) return null;
  const available = !!usage?.available;
  const canUpload = canLand && available && !upload;

  async function send(files: File[]) {
    if (!usage || !files.length) return;
    setError(""); setNotice("");
    let current = assets;
    let spent = 0;
    for (const file of files) {
      const problem = assetProblem(file, { ...usage, usedBytes: usage.usedBytes + spent }, current);
      if (problem) { setError(problem); break; }
      setUpload({ name: file.name, loaded: 0, total: file.size, hashing: true });
      try {
        const sha256 = await sha256Hex(await file.arrayBuffer());
        setUpload({ name: file.name, loaded: 0, total: file.size });
        const asset = await uploadAsset(assetUploadUrl(repositoryId, release.id, file.name), file, sha256, loaded => setUpload({ name: file.name, loaded, total: file.size }));
        current = [...current, asset];
        spent += asset.size;
        setAssets(current);
        setNotice(`Uploaded ${asset.name}.`);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "The upload failed. Try again.");
        break;
      }
    }
    setUpload(null);
    onChanged();
  }

  async function remove(asset: ReleaseAsset) {
    const ok = await confirm({ title: `Delete ${asset.name}?`, description: release.draft ? "The file is removed from this draft." : "The file is removed from this release. Existing download links stop working.", confirmLabel: "Delete file", tone: "danger" });
    if (!ok) return;
    setBusy(asset.id); setError(""); setNotice("");
    try {
      await request<{ deleted: boolean }>(`/api/repositories/${repositoryId}/releases/${release.id}/assets/${asset.id}/delete`, {});
      setAssets(items => items.filter(item => item.id !== asset.id));
      setNotice(`Deleted ${asset.name}.`);
      onChanged();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The file could not be deleted."); }
    finally { setBusy(""); }
  }

  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setNotice(`${label} copied.`); } catch { setNotice("Copy is unavailable. Select the text to copy it."); }
  }

  function drop(event: DragEvent<HTMLElement>) {
    if (!canUpload) return;
    event.preventDefault();
    setDragging(false);
    void send([...event.dataTransfer.files]);
  }

  return <section className={`panel release-assets${dragging ? " is-dragging" : ""}`} aria-labelledby={`assets-${release.id}`}
    onDragOver={event => { if (canUpload && event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={drop}>
    <div className="panel-header release-assets-header">
      <h2 id={`assets-${release.id}`}>Files<span className="release-assets-count">{assets.length}</span></h2>
      <div className="release-assets-tools">
        {usage && available && <span className="release-assets-usage">{byteLabel(usage.usedBytes)} of {byteLabel(usage.limitBytes)}<InfoTip label="release file storage">Up to {byteLabel(usage.maxAssetBytes)} per file and {usage.maxAssetsPerRelease} files per release. Storage is shared by every release in this repository.</InfoTip></span>}
        {usage && !available && <span className="release-assets-usage">Uploads unavailable<InfoTip label="release file uploads">This installation has no storage bucket for release files. An administrator can add one.</InfoTip></span>}
        {canLand && available && <>
          <input ref={input} type="file" multiple hidden onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ""; void send(files); }} />
          <Button variant="secondary" size="sm" icon={UploadSimpleIcon} disabled={!canUpload} loading={!!upload} onClick={() => input.current?.click()}>Upload</Button>
        </>}
      </div>
    </div>
    {upload && <div className="release-asset-progress" role="status" aria-live="polite">
      <span>{upload.hashing ? "Checksumming" : "Uploading"} {upload.name}</span>
      <progress max={upload.total || 1} value={upload.hashing ? undefined : upload.loaded} aria-label={`Upload progress for ${upload.name}`} />
      <span>{upload.hashing ? "" : `${upload.total ? Math.round(upload.loaded / upload.total * 100) : 0}%`}</span>
    </div>}
    {error && <div className="panel-body release-assets-message"><div className="error-notice" role="alert">{error}</div></div>}
    {notice && <p className="release-assets-notice" role="status">{notice}</p>}
    {assets.length ? <ul className="release-asset-list" aria-label="Files">
      {assets.map(asset => <li key={asset.id}>
        <FileIcon size={18} aria-hidden="true" />
        <div className="release-asset-main">
          <a href={asset.downloadUrl} download={asset.name}>{asset.name}</a>
          <small><span>{byteLabel(asset.size)}</span><code title={`SHA-256 ${asset.sha256}`}>sha256:{shortHash(asset.sha256)}</code></small>
        </div>
        <div className="release-asset-actions">
          <Button variant="ghost" size="sm" shape="square" icon={CopyIcon} aria-label={`Copy SHA-256 of ${asset.name}`} title="Copy SHA-256" onClick={() => void copy(asset.sha256, "SHA-256")} />
          {asset.publicUrl && <Button variant="ghost" size="sm" shape="square" icon={LinkIcon} aria-label={`Copy public link to ${asset.name}`} title="Copy public link" onClick={() => void copy(asset.publicUrl!, "Public link")} />}
          <a className="release-asset-download" href={asset.downloadUrl} download={asset.name} aria-label={`Download ${asset.name}`} title="Download"><DownloadSimpleIcon size={16} aria-hidden="true" /></a>
          {canLand && <Button variant="ghost" size="sm" shape="square" icon={TrashIcon} aria-label={`Delete ${asset.name}`} title="Delete" loading={busy === asset.id} disabled={!!busy || !!upload} onClick={() => void remove(asset)} />}
        </div>
      </li>)}
    </ul> : <p className="release-assets-empty">{canLand && available ? "Drop files here or upload binaries, archives and checksums." : "No files attached."}</p>}
    {confirmDialog}
  </section>;
}
