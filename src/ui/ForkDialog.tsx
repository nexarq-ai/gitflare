import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import { XIcon } from "@phosphor-icons/react";
import type { Repository } from "../shared/types";
import { request } from "./api";
import { appHref } from "./hosts";
import InfoTip from "./InfoTip";
import { navigate } from "./router";
import type { WorkspaceEntry } from "./WorkspaceSwitcher";
import "./forks.css";

export function forkTargets(workspaces: (WorkspaceEntry & { current?: boolean })[]): WorkspaceEntry[] {
  const owned = workspaces.filter(item => item.role === "Owner");
  return [...owned.filter(item => item.id.startsWith("personal-")), ...owned.filter(item => !item.id.startsWith("personal-"))];
}

export default function ForkDialog({ handle, repository, authenticated, open, onClose }: { handle: string; repository: string; authenticated: boolean; open: boolean; onClose: () => void }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[] | null>(null);
  const [target, setTarget] = useState("");
  const [name, setName] = useState(repository);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef<{ signature: string; key: string } | null>(null);

  useEffect(() => {
    if (!open || !authenticated) return;
    let active = true;
    setError(""); setName(repository);
    request<{ workspaces: (WorkspaceEntry & { current?: boolean })[] }>("/api/workspaces")
      .then(result => { if (!active) return; const targets = forkTargets(result.workspaces); setWorkspaces(targets); setTarget(current => current || targets[0]?.id || ""); })
      .catch(failure => { if (active) { setWorkspaces([]); setError(failure instanceof Error ? failure.message : "Your workspaces could not be loaded."); } });
    return () => { active = false; };
  }, [open, authenticated, repository]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !target) return;
    const body = { handle, repository, ...(name.trim() && name.trim() !== repository ? { name: name.trim() } : {}) };
    const signature = JSON.stringify([target, body]);
    if (key.current?.signature !== signature) key.current = { signature, key: crypto.randomUUID() };
    setBusy(true); setError("");
    try {
      const created = await request<Repository>("/api/forks", body, key.current.key, target);
      key.current = null;
      onClose();
      navigate(`repository/${created.id}/code`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The fork could not be created.");
    } finally { setBusy(false); }
  }

  const close = () => { if (!busy) onClose(); };
  return <Dialog.Root open={open} onOpenChange={value => { if (!value) close(); }}>
    <Dialog size="lg" className="dialog-content fork-dialog">
      <div className="dialog-title-row"><Dialog.Title className="dialog-title">Fork {handle}/{repository}</Dialog.Title><Button variant="ghost" size="base" shape="square" icon={XIcon} aria-label="Close dialog" disabled={busy} onClick={close} /></div>
      <Dialog.Description className="dialog-description">Your own copy to work in.<InfoTip label="forks">Copies the default branch into a private repository you own, linked to {handle}/{repository}. Push streams there, then propose them upstream. Up to 1 GiB.</InfoTip></Dialog.Description>
      {!authenticated ? <div className="dialog-actions"><Button variant="secondary" size="base" type="button" onClick={close}>Cancel</Button><a className="fork-signin" href={appHref("/signin")}>Sign in to fork</a></div>
        : <form onSubmit={event => void submit(event)}>
          {workspaces && !workspaces.length && !error && <p className="fork-empty">You need a workspace you own. <a href={appHref("/account/profile")}>Choose a handle</a> to get a personal one.</p>}
          {!!workspaces?.length && <>
            <div className="form-field"><label htmlFor="fork-workspace">Into</label><select id="fork-workspace" disabled={busy} value={target} onChange={event => setTarget(event.target.value)}>{workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
            <div className="form-field"><label htmlFor="fork-name">Name</label><Input id="fork-name" maxLength={64} disabled={busy} value={name} onChange={event => setName(event.target.value)} /></div>
          </>}
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="dialog-actions"><Button variant="secondary" size="base" type="button" disabled={busy} onClick={close}>Cancel</Button><Button variant="primary" size="base" type="submit" loading={busy} disabled={busy || !target || !workspaces?.length}>Fork</Button></div>
        </form>}
    </Dialog>
  </Dialog.Root>;
}
