import { useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { GlobeHemisphereWestIcon, LockSimpleIcon } from "@phosphor-icons/react";
import type { HandleStatus, Repository, RepositoryLicense, RepositoryVisibility, RepositoryVisibilityKind } from "../shared/types";
import { publicRepositoryPath } from "../shared/handles";
import { repositoryLabel } from "../shared/repository-names";
import { request, RequestError } from "./api";
import { useConfirm } from "./ConfirmDialog";
import { pageHostOrigins } from "./hosts";
import InfoTip from "./InfoTip";
import "./public-settings.css";
import { PageLoading } from "./WorkspaceLoader";

type Props = { repository: Repository; onChanged: () => Promise<void> | void; onNotify: (message: string) => void };

function licenseLabel(license: RepositoryLicense | null): string {
  if (!license) return "None";
  return license.spdx ?? (license.path ? `${license.path} (unrecognized)` : "Unrecognized");
}

export function unsavedVisibility(requested: RepositoryVisibilityKind, saved: RepositoryVisibility, name: string): string | null {
  return saved.visibility === requested ? null : `Gitflare did not save this change. ${name} is still ${saved.visibility}. Try again.`;
}

function displayAddress(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

export default function RepositoryVisibilityCard({ repository, onChanged, onNotify }: Props) {
  const name = repositoryLabel(repository);
  const [state, setState] = useState<RepositoryVisibility | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [licenseRequired, setLicenseRequired] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [handleSettings, setHandleSettings] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, dialog] = useConfirm();

  const path = `/api/repositories/${encodeURIComponent(repository.id)}/visibility`;

  useEffect(() => {
    let active = true;
    request<RepositoryVisibility>(path).then(
      data => { if (active) { setState(data); setLoadError(""); } },
      (failure: unknown) => { if (active) setLoadError(failure instanceof Error ? failure.message : "Visibility could not be loaded."); },
    );
    return () => { active = false; };
  }, [path]);

  async function resync() {
    try { setState(await request<RepositoryVisibility>(path)); } catch {}
  }

  async function requireHandle() {
    let target = "/settings";
    try { if ((await request<HandleStatus>("/api/handles")).workspace.personal) target = "/account/profile"; } catch {}
    setHandleSettings(target);
  }

  async function change(visibility: RepositoryVisibilityKind) {
    setBusy(true); setError(""); setHandleSettings("");
    try {
      const next = await request<RepositoryVisibility>(path, { visibility, ...(visibility === "public" && acknowledged ? { acknowledgeNoLicense: true } : {}) });
      setState(next);
      const unsaved = unsavedVisibility(visibility, next, name);
      if (unsaved) { setError(unsaved); return; }
      setLicenseRequired(false); setAcknowledged(false);
      onNotify(visibility === "public" ? `${name} is public.` : `${name} is private.`);
      await onChanged();
    } catch (failure) {
      if (failure instanceof RequestError && failure.code === "LICENSE_REQUIRED") { setLicenseRequired(true); setError(failure.message); }
      else if (failure instanceof RequestError && failure.code === "HANDLE_REQUIRED") { setError(failure.message); await requireHandle(); }
      else { setError(failure instanceof Error ? failure.message : "Visibility could not be changed."); await resync(); }
    } finally { setBusy(false); }
  }

  const address = state?.url ?? (state?.handle ? `${pageHostOrigins()?.site ?? window.location.origin}${publicRepositoryPath(state.handle, name)}` : null);

  async function makePublic() {
    if (!state) return;
    setError("");
    if (!state.handle) { setError("Set a handle for this workspace first."); await requireHandle(); return; }
    const ok = await confirm({
      title: `Make ${name} public?`,
      description: "Anyone can read and clone its code, revisions, streams and checkpoints, read its issues, and open issues once signed in. Proposals, missions, secrets and previews stay private.",
      facts: [...(address ? [{ label: "Address", value: displayAddress(address), code: true }] : []), { label: "License", value: licenseLabel(state.license) }],
      tone: "danger",
      confirmLabel: "Make public",
    });
    if (ok) await change("public");
  }

  async function makePrivate() {
    const ok = await confirm({ title: `Make ${name} private?`, description: "Only workspace members will see it. Existing clones keep their copy.", tone: "primary", confirmLabel: "Make private" });
    if (ok) await change("private");
  }

  const isPublic = state?.visibility === "public";
  const needsAcknowledgement = !!state && !isPublic && state.canChange && (licenseRequired || !state.license);

  return <section className="panel visibility-card">
    <div className="panel-header"><h2>Visibility</h2>{state && <span className={`visibility-pill${isPublic ? " is-public" : ""}`}>{isPublic ? <GlobeHemisphereWestIcon size={13} aria-hidden="true" /> : <LockSimpleIcon size={13} aria-hidden="true" />}{isPublic ? "Public" : "Private"}</span>}</div>
    <div className="panel-body">
      {loadError ? <div className="form-error" role="alert">{loadError}</div>
        : !state ? <PageLoading label="Loading visibility" />
        : <>
          <div className="visibility-row">
            <p className="visibility-state">{isPublic ? <>Public — anyone can read and clone.{address && <> <a href={address} target="_blank" rel="noopener noreferrer">{displayAddress(address)}</a></>}</> : "Private — only workspace members can see it."}</p>
            {state.canChange && (isPublic
              ? <Button variant="secondary" size="base" loading={busy} onClick={() => void makePrivate()}>Make private</Button>
              : <Button variant="secondary" size="base" loading={busy} disabled={needsAcknowledgement && !acknowledged} onClick={() => void makePublic()}>Make public</Button>)}
          </div>
          {needsAcknowledgement && <div className="visibility-license">
            <p className="people-muted">Making it public needs a license so others know how they may use the code.</p>
            <label className="people-check"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />Publish without a license<InfoTip label="Publish without a license">Without a license others can read the code but have no rights to use it.</InfoTip></label>
          </div>}
          {error && <div className="form-error" role="alert">{error}{handleSettings && <> <a href={handleSettings}>Set a handle</a></>}</div>}
        </>}
    </div>
    {dialog}
  </section>;
}
