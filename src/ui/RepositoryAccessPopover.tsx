import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { CaretDownIcon } from "@phosphor-icons/react";
import type { Repository } from "../shared/types";
import { repositoryLabel } from "../shared/repository-names";

export default function RepositoryAccessPopover({ label, memberName, repositoryIds, repositories, disabled, onSave }: { label: string; memberName: string; repositoryIds?: string[]; repositories: Repository[]; disabled?: boolean; onSave: (repositoryIds: string[] | null) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"all" | "selected">(repositoryIds ? "selected" : "all");
  const [selected, setSelected] = useState<string[]>(repositoryIds ?? []);
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => { if (open) { setMode(repositoryIds ? "selected" : "all"); setSelected(repositoryIds ?? []); } }, [open]);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLInputElement>("input")?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const close = (event: Event) => { if (!(event.target instanceof Node && root.current?.contains(event.target))) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); };
  }, [open]);

  const unchanged = mode === "all" ? !repositoryIds : !!repositoryIds && repositoryIds.length === selected.length && selected.every(item => repositoryIds.includes(item));
  async function save() {
    setBusy(true);
    const ok = await onSave(mode === "all" ? null : selected);
    setBusy(false);
    if (ok) { setOpen(false); trigger.current?.focus(); }
  }

  return <div className="repo-access" ref={root} onKeyDown={event => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
    <button type="button" ref={trigger} className="repo-access-trigger" disabled={disabled} aria-expanded={open} aria-controls={id} aria-label={`Repository access for ${memberName}: ${label}`} onClick={() => { const rect = trigger.current?.getBoundingClientRect(); if (rect) setPosition({ top: rect.bottom + 6, left: Math.max(16, Math.min(rect.left, window.innerWidth - 296)) }); setOpen(value => !value); }}>{label}<CaretDownIcon size={12} aria-hidden="true" /></button>
    {open && <div className="repo-access-panel" id={id} role="dialog" style={position} aria-label={`Repository access for ${memberName}`}>
      <fieldset>
        <legend>What can {memberName} see?</legend>
        <label><input type="radio" name={`${id}-mode`} checked={mode === "all"} onChange={() => setMode("all")} />All repositories</label>
        <label><input type="radio" name={`${id}-mode`} checked={mode === "selected"} onChange={() => setMode("selected")} />Only these repositories</label>
      </fieldset>
      {mode === "selected" && <div className="repo-access-list" role="group" aria-label="Repositories">
        {repositories.map(repo => <label key={repo.id}><input type="checkbox" checked={selected.includes(repo.id)} onChange={event => setSelected(current => event.target.checked ? [...current, repo.id] : current.filter(item => item !== repo.id))} />{repositoryLabel(repo)}</label>)}
      </div>}
      {mode === "selected" && !selected.length && <p className="repo-access-hint">Choose at least one repository, or remove them from the workspace instead.</p>}
      <div className="repo-access-actions"><Button variant="ghost" size="sm" type="button" onClick={() => { setOpen(false); trigger.current?.focus(); }}>Cancel</Button><Button variant="primary" size="sm" type="button" loading={busy} disabled={unchanged || mode === "selected" && !selected.length} onClick={() => void save()}>Save</Button></div>
    </div>}
  </div>;
}
