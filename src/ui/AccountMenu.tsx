import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { BookOpenIcon, BuildingsIcon, CaretDownIcon, MoonIcon, PlugsConnectedIcon, ShieldCheckIcon, SignOutIcon, SunIcon, UserCircleIcon } from "@phosphor-icons/react";
import type { AccessSnapshot, Workspace } from "../shared/types";
import { setTheme, useTheme } from "./ThemeToggle";
import "./account-settings.css";

export default function AccountMenu({ account, workspace, loaded, installationAdmin = false, signingOut, onSignOut }: { account: AccessSnapshot | null; workspace: Workspace; loaded: boolean; installationAdmin?: boolean; signingOut: boolean; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const theme = useTheme();
  const name = account?.user.name || "Your account";
  const email = account && "email" in account.user ? account.user.email : "Owner token session";
  const initials = name.split(/\s+/).map(word => word[0]).slice(0, 2).join("").toUpperCase();
  function close(restore = false) { setOpen(false); if (restore) trigger.current?.focus(); }
  function focusItem(last = false) { const items = panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]'); (last ? items?.[items.length - 1] : items?.[0])?.focus(); }
  useEffect(() => {
    if (!open) return;
    focusItem(focusLast.current);
    focusLast.current = false;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  function keyboard(event: KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    if (event.key === "Tab") { close(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
  return <div className="account-menu" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close(); }}>
    <button className="account-menu-trigger" type="button" ref={trigger} aria-label="Profile menu" aria-haspopup="menu" aria-expanded={open} aria-controls="account-menu-panel" onClick={() => setOpen(value => !value)} onKeyDown={event => { if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); if (open) focusItem(event.key === "ArrowUp"); else { focusLast.current = event.key === "ArrowUp"; setOpen(true); } } }}><span className="account-avatar" aria-hidden="true">{initials || "GF"}</span><span>Profile</span><CaretDownIcon size={13} aria-hidden="true"/></button>
    {open && <div className="account-menu-panel" id="account-menu-panel" role="menu" aria-label="Profile" ref={panel} onKeyDown={keyboard}>
      <div className="account-menu-identity" role="presentation"><strong>{name}</strong><span>{email}</span><span className="account-menu-workspace"><i className={`status-dot ${loaded ? "good" : "warn"}`}/>{loaded ? workspace.mode === "local" ? "Local workspace" : "Connected workspace" : "Connecting"}</span></div>
      <a role="menuitem" href="/account/profile" onClick={() => close()}><UserCircleIcon size={18}/>Profile</a>
      <a role="menuitem" href="/account/security" onClick={() => close()}><ShieldCheckIcon size={18}/>Security</a>
      <a role="menuitem" className="ai-only" href="/account/clients" onClick={() => close()}><PlugsConnectedIcon size={18}/>AI clients</a>
      {installationAdmin && <a role="menuitem" href="/admin" onClick={() => close()}><BuildingsIcon size={18}/>Installation admin</a>}
      <a role="menuitem" href="/docs/how-it-works" onClick={() => close()}><BookOpenIcon size={18}/>Documentation</a>
      <button role="menuitem" type="button" onClick={() => { setTheme(theme === "dark" ? "light" : "dark"); close(true); }}>{theme === "dark" ? <SunIcon size={18}/> : <MoonIcon size={18}/>}Switch to {theme === "dark" ? "light" : "dark"} theme</button>
      {workspace.mode === "connected" && <button role="menuitem" className="account-menu-signout" type="button" disabled={signingOut} onClick={() => { close(); onSignOut(); }}><SignOutIcon size={18}/>{signingOut ? "Signing out…" : "Sign out"}</button>}
    </div>}
  </div>;
}
