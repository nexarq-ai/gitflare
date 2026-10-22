import { useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { ArrowUpRightIcon, CheckIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import type { ProfileSettings, PublicProfile } from "../shared/types";
import { request } from "./api";
import InfoTip from "./InfoTip";
import "./profile-settings.css";

export const PROFILE_LIMITS = { displayName: 80, bio: 300, links: 4, linkLength: 200, pinned: 6 } as const;

type Draft = { displayName: string; bio: string; links: string[]; pinned: string[] };

function draftOf(settings: ProfileSettings): Draft {
  return { displayName: settings.displayName, bio: settings.bio, links: settings.links.length ? settings.links : [""], pinned: settings.pinned };
}

function cleanLinks(links: string[]) {
  return links.map(link => link.trim()).filter(Boolean);
}

function linkProblem(link: string): string | null {
  if (link.length > PROFILE_LIMITS.linkLength) return `Use at most ${PROFILE_LIMITS.linkLength} characters.`;
  try {
    if (new URL(link).protocol === "https:") return null;
  } catch {}
  return "Use an https:// address.";
}

function same(left: Draft, right: Draft) {
  return left.displayName.trim() === right.displayName.trim() && left.bio.trim() === right.bio.trim() && cleanLinks(left.links).join("\n") === cleanLinks(right.links).join("\n") && left.pinned.join("\n") === right.pinned.join("\n");
}

export default function ProfileSettingsCard({ scope }: { scope: "user" | "workspace" }) {
  const [settings, setSettings] = useState<ProfileSettings | null>(null);
  const [repositories, setRepositories] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const id = useId();

  useEffect(() => {
    let active = true;
    request<ProfileSettings>(`/api/profile?scope=${scope}`).then(data => {
      if (!active) return;
      setSettings(data); setDraft(draftOf(data));
      if (!data.handle) return;
      request<PublicProfile>(`/api/public/profiles/${encodeURIComponent(data.handle)}`).then(
        profile => { if (active) setRepositories(profile.repositories.map(repository => repository.name)); },
        () => { if (active) setRepositories([]); },
      );
    }, (failure: unknown) => { if (active) setLoadError(failure instanceof Error ? failure.message : "The profile could not be loaded."); });
    return () => { active = false; };
  }, [scope]);

  function update(next: Partial<Draft>) {
    setDraft(current => current && { ...current, ...next });
    setSaved(false); setError("");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy(true); setError(""); setSaved(false);
    try {
      const next = await request<ProfileSettings>("/api/profile", { scope, displayName: draft.displayName.trim(), bio: draft.bio.trim(), links: cleanLinks(draft.links), pinned: draft.pinned });
      setSettings(next); setDraft(draftOf(next)); setSaved(true);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The profile could not be saved."); }
    finally { setBusy(false); }
  }

  const tip = scope === "user" ? "Your display name, bio, links and pinned repositories appear on your public profile next to your public repositories and stars. Your email is never shown." : "The display name, bio, links and pinned repositories appear on this workspace's public page next to its public repositories.";
  const header = <div className="panel-header"><h2 className="field-label">Public profile<InfoTip label="Public profile">{tip}</InfoTip></h2>{settings?.url && <a className="profile-settings-view" href={settings.url}>View<ArrowUpRightIcon size={13} aria-hidden="true" /></a>}</div>;

  if (loadError) return <section className="panel">{header}<div className="panel-body"><div className="form-error" role="alert">{loadError}</div></div></section>;
  if (!settings || !draft) return <section className="panel">{header}<div className="panel-body"><p className="people-muted" role="status">Loading profile…</p></div></section>;
  if (!settings.handle) return <section className="panel">{header}<div className="panel-body"><p className="people-muted">Choose a handle first.</p></div></section>;

  if (!settings.canChange) return <section className="panel">{header}<div className="panel-body">
    <dl className="profile-settings-readonly">
      <div><dt>Display name</dt><dd>{settings.displayName || "—"}</dd></div>
      <div><dt>Bio</dt><dd>{settings.bio || "—"}</dd></div>
      <div><dt>Links</dt><dd>{settings.links.length ? settings.links.map(link => <span key={link}>{link}</span>) : "—"}</dd></div>
      <div><dt>Pinned</dt><dd>{settings.pinned.length ? settings.pinned.join(", ") : "—"}</dd></div>
    </dl>
    <p className="people-muted profile-settings-note">Only an Owner can change this.</p>
  </div></section>;

  const links = draft.links;
  const linkErrors = links.map(link => link.trim() ? linkProblem(link.trim()) : null);
  const invalid = draft.displayName.trim().length > PROFILE_LIMITS.displayName || draft.bio.trim().length > PROFILE_LIMITS.bio || linkErrors.some(Boolean) || draft.pinned.length > PROFILE_LIMITS.pinned;
  const unchanged = same(draft, draftOf(settings));
  const choices = [...new Set([...draft.pinned, ...(repositories ?? [])])];
  const full = draft.pinned.length >= PROFILE_LIMITS.pinned;

  return <section className="panel">
    {header}
    <form className="panel-body profile-settings" onSubmit={event => void save(event)}>
      <div className="form-field">
        <label htmlFor={`${id}-name`}>Display name</label>
        <Input id={`${id}-name`} value={draft.displayName} maxLength={PROFILE_LIMITS.displayName} placeholder={settings.handle} autoComplete="off" onChange={event => update({ displayName: event.target.value })} />
      </div>
      <div className="form-field">
        <span className="profile-settings-label"><label htmlFor={`${id}-bio`}>Bio</label><small aria-live="polite">{draft.bio.length}/{PROFILE_LIMITS.bio}</small></span>
        <textarea id={`${id}-bio`} rows={3} value={draft.bio} maxLength={PROFILE_LIMITS.bio} onChange={event => update({ bio: event.target.value })} />
      </div>
      <fieldset className="form-field profile-settings-links">
        <legend>Links</legend>
        {links.map((link, index) => <div key={index} className="profile-settings-link-row">
          <Input aria-label={`Link ${index + 1}`} type="url" inputMode="url" value={link} maxLength={PROFILE_LIMITS.linkLength} placeholder="https://" aria-invalid={!!linkErrors[index]} onChange={event => update({ links: links.map((item, position) => position === index ? event.target.value : item) })} />
          {(links.length > 1 || link) && <Button type="button" variant="ghost" size="base" shape="square" icon={XIcon} aria-label={`Remove link ${index + 1}`} onClick={() => update({ links: links.length > 1 ? links.filter((_, position) => position !== index) : [""] })} />}
          {linkErrors[index] && <small className="profile-settings-error">{linkErrors[index]}</small>}
        </div>)}
        {links.length < PROFILE_LIMITS.links && <Button type="button" variant="ghost" size="sm" icon={PlusIcon} className="profile-settings-add" onClick={() => update({ links: [...links, ""] })}>Add link</Button>}
      </fieldset>
      <fieldset className="form-field">
        <legend className="profile-settings-label">Pinned repositories<small>{draft.pinned.length}/{PROFILE_LIMITS.pinned}</small></legend>
        {repositories === null ? <p className="people-muted" role="status">Loading repositories…</p>
          : !choices.length ? <p className="people-muted">No public repositories yet.</p>
          : <div className="check-chips" role="group" aria-label="Pinned repositories">{choices.map(name => {
            const on = draft.pinned.includes(name);
            return <button key={name} type="button" className="check-chip" aria-pressed={on} disabled={!on && full} onClick={() => update({ pinned: on ? draft.pinned.filter(item => item !== name) : [...draft.pinned, name] })}>{on && <CheckIcon size={12} weight="bold" aria-hidden="true" />}{name}</button>;
          })}</div>}
      </fieldset>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="profile-settings-actions">
        <Button type="submit" variant="primary" size="base" loading={busy} disabled={busy || unchanged || invalid}>Save</Button>
        {saved && <span className="profile-settings-saved" role="status"><CheckIcon size={14} weight="bold" aria-hidden="true" />Saved</span>}
      </div>
    </form>
  </section>;
}
