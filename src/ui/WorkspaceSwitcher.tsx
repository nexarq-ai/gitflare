import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import { CaretUpDownIcon, CheckIcon, EnvelopeSimpleIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { request, RequestError } from "./api";
import "./workspace-switcher.css";

export type WorkspaceEntry = { id: string; name: string; role?: string | null; repositoryScoped?: boolean };

export function invitationCode(value: string): string | null {
  return /(?:^|token=)([a-f0-9]{64})(?:$|[&\s])/i.exec(value.trim())?.[1]?.toLowerCase() ?? null;
}

export function joinErrorMessage(failure: unknown): string {
  if (failure instanceof RequestError && ["INVITATION_IDENTITY", "INVITE_EMAIL_MISMATCH"].includes(failure.code ?? "")) return "This invitation is for a different email address.";
  if (failure instanceof RequestError && failure.code === "ALREADY_MEMBER") return "You already belong to this workspace.";
  return failure instanceof Error ? failure.message : "The invitation could not be accepted.";
}

type Props = {
  workspaces: WorkspaceEntry[];
  currentId: string;
  currentName: string;
  role: string;
  menu: boolean;
  canCreate: boolean;
  canJoin: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSwitch: (id: string) => Promise<void>;
  onCreated: (workspace: { id: string; name: string }) => Promise<void>;
  onJoined: (workspaceId: string) => Promise<void>;
};

export default function WorkspaceSwitcher({ workspaces, currentId, currentName, role, menu, canCreate, canJoin, open, onOpenChange, onSwitch, onCreated, onJoined }: Props) {
  const [dialog, setDialog] = useState<"create" | "join" | null>(null);
  const [pending, setPending] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const others = workspaces.filter(item => item.id !== currentId);
  const interactive = menu && (others.length > 0 || canCreate || canJoin);

  function close(restore = false) { onOpenChange(false); if (restore) trigger.current?.focus(); }
  function items() { return Array.from(panel.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []); }

  useEffect(() => {
    if (!open) return;
    const list = items();
    (list.find(item => item.getAttribute("aria-checked") === "true") ?? list[0])?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  function keyboard(event: KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === "Tab") { close(); return; }
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
      list[next]?.focus();
      return;
    }
    if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
    const now = Date.now();
    typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + event.key.toLowerCase(), at: now };
    const match = list.find((item, position) => position > index - (typed.current.text.length > 1 ? 1 : 0) && (item.dataset.label ?? "").toLowerCase().startsWith(typed.current.text)) ?? list.find(item => (item.dataset.label ?? "").toLowerCase().startsWith(typed.current.text));
    match?.focus();
  }

  async function choose(id: string) {
    if (id === currentId) { close(true); return; }
    setPending(id);
    try { await onSwitch(id); close(); }
    finally { setPending(""); }
  }

  if (!interactive) return <div className="workspace-switcher workspace-switcher-label"><span className="workspace-switcher-name">{currentName}</span>{role && <span className="workspace-switcher-role">{role}</span>}</div>;

  return <div className="workspace-switcher" ref={root} onBlur={event => { if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) close(); }}>
    <button type="button" ref={trigger} className="workspace-switcher-trigger" aria-label={`Switch workspace, current: ${currentName}`} aria-haspopup="menu" aria-expanded={open} aria-controls="workspace-switcher-menu" onClick={() => onOpenChange(!open)} onKeyDown={event => { if (["ArrowDown", "ArrowUp"].includes(event.key) && !open) { event.preventDefault(); onOpenChange(true); } }}>
      <span className="workspace-switcher-name">{currentName}</span>
      {role && <span className="workspace-switcher-role">{role}</span>}
      <CaretUpDownIcon size={14} aria-hidden="true" className="workspace-switcher-caret" />
    </button>
    {open && <div className="workspace-switcher-menu" id="workspace-switcher-menu" role="menu" aria-label="Workspaces" ref={panel} onKeyDown={keyboard}>
      <div className="workspace-switcher-heading" role="presentation">Workspaces</div>
      {workspaces.map(item => <button key={item.id} type="button" role="menuitemradio" aria-checked={item.id === currentId} data-label={item.name} disabled={!!pending} onClick={() => void choose(item.id)}>
        <span className="workspace-switcher-check" aria-hidden="true">{item.id === currentId && <CheckIcon size={14} weight="bold" />}</span>
        <span className="workspace-switcher-item"><strong>{item.name}</strong><small>{[item.role, item.repositoryScoped ? "Some repositories" : ""].filter(Boolean).join(" · ")}{pending === item.id ? " · Switching…" : ""}</small></span>
      </button>)}
      {(canCreate || canJoin) && <div className="workspace-switcher-separator" role="separator" />}
      {canCreate && <button type="button" role="menuitem" data-label="Create workspace" onClick={() => { close(); setDialog("create"); }}><PlusIcon size={16} aria-hidden="true" />Create workspace…</button>}
      {canJoin && <button type="button" role="menuitem" data-label="Join with an invitation code" onClick={() => { close(); setDialog("join"); }}><EnvelopeSimpleIcon size={16} aria-hidden="true" />Join with an invitation code…</button>}
    </div>}
    <CreateWorkspaceDialog open={dialog === "create"} onClose={() => { setDialog(null); trigger.current?.focus(); }} onCreated={async workspace => { setDialog(null); await onCreated(workspace); }} />
    <JoinWorkspaceDialog open={dialog === "join"} onClose={() => { setDialog(null); trigger.current?.focus(); }} onJoined={async id => { setDialog(null); await onJoined(id); }} />
  </div>;
}

function CreateWorkspaceDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (workspace: { id: string; name: string }) => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef("");
  useEffect(() => { if (open) { setName(""); setError(""); key.current = crypto.randomUUID(); } }, [open]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError("");
    try { const result = await request<{ workspace: { id: string; name: string } }>("/api/workspaces/create", { name: name.trim() }, key.current); await onCreated(result.workspace); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The workspace could not be created."); }
    finally { setBusy(false); }
  }
  return <Dialog.Root open={open} onOpenChange={value => { if (!value && !busy) onClose(); }}>
    <Dialog size="lg" className="dialog-content">
      <div className="dialog-title-row"><Dialog.Title className="dialog-title">New workspace</Dialog.Title><Button variant="ghost" size="base" shape="square" icon={XIcon} aria-label="Close dialog" disabled={busy} onClick={onClose} /></div>
      <Dialog.Description className="dialog-description">A separate place with its own people, repositories and Cloudflare accounts. People in all your workspaces join it automatically.</Dialog.Description>
      <form onSubmit={event => void submit(event)}>
        <div className="form-field"><label htmlFor="workspace-create-name">Name</label><Input id="workspace-create-name" aria-label="Name" required maxLength={100} autoFocus value={name} onChange={event => setName(event.target.value)} /></div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="dialog-actions"><Button variant="secondary" size="base" type="button" disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" size="base" type="submit" loading={busy} disabled={!name.trim()}>Create</Button></div>
      </form>
    </Dialog>
  </Dialog.Root>;
}

function JoinWorkspaceDialog({ open, onClose, onJoined }: { open: boolean; onClose: () => void; onJoined: (workspaceId: string) => Promise<void> }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (open) { setCode(""); setError(""); } }, [open]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    const token = invitationCode(code);
    if (!token) { setError("Paste the whole invitation link or code from your email."); return; }
    setBusy(true); setError("");
    try { const result = await request<{ workspaceId: string }>("/api/access/accept-invite", { token }); setCode(""); await onJoined(result.workspaceId); }
    catch (failure) { setError(joinErrorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <Dialog.Root open={open} onOpenChange={value => { if (!value && !busy) onClose(); }}>
    <Dialog size="lg" className="dialog-content">
      <div className="dialog-title-row"><Dialog.Title className="dialog-title">Join a workspace</Dialog.Title><Button variant="ghost" size="base" shape="square" icon={XIcon} aria-label="Close dialog" disabled={busy} onClick={onClose} /></div>
      <Dialog.Description className="dialog-description">Paste the invitation code from your email.</Dialog.Description>
      <form onSubmit={event => void submit(event)}>
        <div className="form-field"><label htmlFor="workspace-join-code">Invitation code or link</label><Input id="workspace-join-code" aria-label="Invitation code or link" required autoComplete="off" spellCheck={false} autoFocus value={code} onChange={event => setCode(event.target.value)} /></div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="dialog-actions"><Button variant="secondary" size="base" type="button" disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" size="base" type="submit" loading={busy} disabled={!code.trim()}>Join workspace</Button></div>
      </form>
    </Dialog>
  </Dialog.Root>;
}
