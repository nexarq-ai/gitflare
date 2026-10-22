import { useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { ArrowUpRightIcon, CheckCircleIcon, CheckIcon, CircleIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import type { ProfileSettings, ProfileShowcase, PublicProfile, ShowcaseOptions } from "../shared/types";
import { PROFILE_FILES, PROFILE_LIMITS } from "../shared/handles";
import { request } from "./api";
import InfoTip from "./InfoTip";
import ProfileHeader from "./ProfileHeader";
import "./profile-settings.css";
import { PageLoading } from "./WorkspaceLoader";

export { PROFILE_LIMITS };

type Draft = { displayName: string; bio: string; links: string[]; pinned: string[]; location: string; website: string; showcase: ProfileShowcase | null };

function draftOf(settings: ProfileSettings): Draft {
  return { displayName: settings.displayName, bio: settings.bio, links: settings.links.length ? settings.links : [""], pinned: settings.pinned, location: settings.location, website: settings.website, showcase: settings.showcase };
}

function cleanLinks(links: string[]) {
  return links.map(link => link.trim()).filter(Boolean);
}

function linkProblem(link: string, max: number = PROFILE_LIMITS.linkLength): string | null {
  if (link.length > max) return `Use at most ${max} characters.`;
  try {
    if (new URL(link).protocol === "https:") return null;
  } catch {}
  return "Use an https:// address.";
}

function showcaseKey(showcase: ProfileShowcase | null) {
  return showcase ? showcase.kind === "repository" ? `repository:${showcase.name}` : `mission:${showcase.repository}:${showcase.missionId}` : "";
}

function same(left: Draft, right: Draft) {
  return left.displayName.trim() === right.displayName.trim() && left.bio.trim() === right.bio.trim() && cleanLinks(left.links).join("\n") === cleanLinks(right.links).join("\n") && left.pinned.join("\n") === right.pinned.join("\n")
    && left.location.trim() === right.location.trim() && left.website.trim() === right.website.trim() && showcaseKey(left.showcase) === showcaseKey(right.showcase);
}

export type ProfileTip = { id: string; label: string; done: boolean; tip: string };

export function profileTips(draft: Pick<Draft, "bio" | "pinned" | "showcase" | "links" | "website">, handle: string, hasReadme: boolean, hasMissions: boolean): ProfileTip[] {
  return [
    { id: "bio", label: "Say what you build", done: !!draft.bio.trim(), tip: "One or two lines. Visitors read the bio before anything else." },
    { id: "pinned", label: `Pin up to ${PROFILE_LIMITS.pinned} repositories`, done: draft.pinned.length > 0, tip: "Pinned repositories come first on your profile, in the order you pin them." },
    { id: "readme", label: `Add ${PROFILE_FILES[0]} to a repository named ${handle}`, done: hasReadme, tip: `A public repository named ${handle} with ${PROFILE_FILES[0]} (or PROFILE.md at its root) renders on your profile. Markdown, images as placeholders, up to 64 KB.` },
    { id: "showcase", label: hasMissions ? "Feature a landed mission" : "Feature a repository", done: !!draft.showcase, tip: "The featured card sits above your repositories: one public repository, or one mission agents and people landed together." },
    { id: "links", label: "Add a website or links", done: !!draft.website.trim() || cleanLinks(draft.links).length > 0, tip: "Your website gets a globe icon; up to four more https links follow it." },
  ];
}

export default function ProfileSettingsCard({ scope }: { scope: "user" | "workspace" }) {
  const [settings, setSettings] = useState<ProfileSettings | null>(null);
  const [options, setOptions] = useState<ShowcaseOptions | null>(null);
  const [hasReadme, setHasReadme] = useState(false);
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
      request<ShowcaseOptions>(`/api/profile/showcase-options?scope=${scope}`).then(value => { if (active) setOptions(value); }, () => { if (active) setOptions({ repositories: [], missions: [] }); });
      request<PublicProfile>(`/api/public/profiles/${encodeURIComponent(data.handle)}`).then(profile => { if (active) setHasReadme(!!profile.readme); }, () => {});
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
      const next = await request<ProfileSettings>("/api/profile", { scope, displayName: draft.displayName.trim(), bio: draft.bio.trim(), links: cleanLinks(draft.links), pinned: draft.pinned, location: draft.location.trim(), website: draft.website.trim(), showcase: draft.showcase });
      setSettings(next); setDraft(draftOf(next)); setSaved(true);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The profile could not be saved."); }
    finally { setBusy(false); }
  }

  const tip = scope === "user" ? "Your display name, bio, location, website, links, pinned repositories and featured work appear on your public profile next to your public repositories and stars. Your email is never shown." : "The display name, bio, location, website, links, pinned repositories and featured work appear on this workspace's public page next to its public repositories.";
  const header = <div className="panel-header"><h2 className="field-label">Public profile<InfoTip label="Public profile">{tip}</InfoTip></h2>{settings?.url && <a className="profile-settings-view" href={settings.url}>View<ArrowUpRightIcon size={13} aria-hidden="true" /></a>}</div>;

  if (loadError) return <section className="panel">{header}<div className="panel-body"><div className="form-error" role="alert">{loadError}</div></div></section>;
  if (!settings || !draft) return <section className="panel">{header}<div className="panel-body"><PageLoading label="Loading profile" /></div></section>;
  if (!settings.handle) return <section className="panel">{header}<div className="panel-body"><p className="people-muted">Choose a handle first.</p></div></section>;

  if (!settings.canChange) return <section className="panel">{header}<div className="panel-body">
    <dl className="profile-settings-readonly">
      <div><dt>Display name</dt><dd>{settings.displayName || "—"}</dd></div>
      <div><dt>Bio</dt><dd>{settings.bio || "—"}</dd></div>
      <div><dt>Location</dt><dd>{settings.location || "—"}</dd></div>
      <div><dt>Website</dt><dd>{settings.website || "—"}</dd></div>
      <div><dt>Links</dt><dd>{settings.links.length ? settings.links.map(link => <span key={link}>{link}</span>) : "—"}</dd></div>
      <div><dt>Pinned</dt><dd>{settings.pinned.length ? settings.pinned.join(", ") : "—"}</dd></div>
      <div><dt>Featured</dt><dd>{settings.showcase ? settings.showcase.kind === "repository" ? settings.showcase.name : `${settings.showcase.repository} · mission ${settings.showcase.missionId.slice(0, 8)}` : "—"}</dd></div>
    </dl>
    <p className="people-muted profile-settings-note">Only an Owner can change this.</p>
  </div></section>;

  const handle = settings.handle;
  const links = draft.links;
  const linkErrors = links.map(link => link.trim() ? linkProblem(link.trim()) : null);
  const websiteError = draft.website.trim() ? linkProblem(draft.website.trim(), PROFILE_LIMITS.website) : null;
  const invalid = draft.displayName.trim().length > PROFILE_LIMITS.displayName || draft.bio.trim().length > PROFILE_LIMITS.bio || draft.location.trim().length > PROFILE_LIMITS.location || linkErrors.some(Boolean) || !!websiteError || draft.pinned.length > PROFILE_LIMITS.pinned;
  const unchanged = same(draft, draftOf(settings));
  const choices = [...new Set([...draft.pinned, ...(options?.repositories ?? [])])];
  const full = draft.pinned.length >= PROFILE_LIMITS.pinned;
  const missions = options?.missions ?? [];
  const tips = profileTips(draft, handle, hasReadme, missions.length > 0);
  const done = tips.filter(item => item.done).length;
  const current = showcaseKey(draft.showcase);

  return <section className="panel">
    {header}
    <form className="panel-body profile-settings" onSubmit={event => void save(event)}>
      <div className="profile-settings-columns">
        <div className="profile-settings-fields">
          <div className="form-field">
            <label htmlFor={`${id}-name`}>Display name</label>
            <Input id={`${id}-name`} value={draft.displayName} maxLength={PROFILE_LIMITS.displayName} placeholder={handle} autoComplete="off" onChange={event => update({ displayName: event.target.value })} />
          </div>
          <div className="form-field">
            <span className="profile-settings-label"><label htmlFor={`${id}-bio`}>Bio</label><small aria-live="polite">{draft.bio.length}/{PROFILE_LIMITS.bio}</small></span>
            <textarea id={`${id}-bio`} rows={3} value={draft.bio} maxLength={PROFILE_LIMITS.bio} onChange={event => update({ bio: event.target.value })} />
          </div>
          <div className="profile-settings-pair">
            <div className="form-field">
              <label htmlFor={`${id}-location`}>Location</label>
              <Input id={`${id}-location`} value={draft.location} maxLength={PROFILE_LIMITS.location} placeholder="City, country" autoComplete="off" onChange={event => update({ location: event.target.value })} />
            </div>
            <div className="form-field">
              <label htmlFor={`${id}-website`}>Website</label>
              <Input id={`${id}-website`} type="url" inputMode="url" value={draft.website} maxLength={PROFILE_LIMITS.website} placeholder="https://" aria-invalid={!!websiteError} onChange={event => update({ website: event.target.value })} />
              {websiteError && <small className="profile-settings-error">{websiteError}</small>}
            </div>
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
            {options === null ? <PageLoading label="Loading repositories" />
              : !choices.length ? <p className="people-muted">No public repositories yet.</p>
              : <div className="check-chips" role="group" aria-label="Pinned repositories">{choices.map(name => {
                const on = draft.pinned.includes(name);
                return <button key={name} type="button" className="check-chip" aria-pressed={on} disabled={!on && full} onClick={() => update({ pinned: on ? draft.pinned.filter(item => item !== name) : [...draft.pinned, name] })}>{on && <CheckIcon size={12} weight="bold" aria-hidden="true" />}{name}</button>;
              })}</div>}
          </fieldset>
          <fieldset className="form-field">
            <legend className="profile-settings-label"><span>Featured<InfoTip label="Featured">One public repository or one landed mission, shown above your repositories.</InfoTip></span></legend>
            {options === null ? <PageLoading label="Loading" />
              : !options.repositories.length ? <p className="people-muted">No public repositories yet.</p>
              : <div className="profile-settings-showcase">
                <select aria-label="Featured" value={current} onChange={event => {
                  const value = event.target.value;
                  const mission = missions.find(item => `mission:${item.repository}:${item.missionId}` === value);
                  update({ showcase: !value ? null : mission ? { kind: "mission", repository: mission.repository, missionId: mission.missionId } : { kind: "repository", name: value.slice("repository:".length) } });
                }}>
                  <option value="">Nothing featured</option>
                  <optgroup label="Repositories">{options.repositories.map(name => <option key={name} value={`repository:${name}`}>{name}</option>)}</optgroup>
                  {missions.length > 0 && <optgroup label="Landed missions">{missions.map(mission => <option key={mission.missionId} value={`mission:${mission.repository}:${mission.missionId}`}>{mission.repository} · {mission.title}</option>)}</optgroup>}
                </select>
              </div>}
          </fieldset>
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="profile-settings-actions">
            <Button type="submit" variant="primary" size="base" loading={busy} disabled={busy || unchanged || invalid}>Save</Button>
            {saved && <span className="profile-settings-saved" role="status"><CheckIcon size={14} weight="bold" aria-hidden="true" />Saved</span>}
          </div>
        </div>
        <aside className="profile-settings-side">
          <div className="profile-settings-preview" aria-label="Profile preview">
            <span className="profile-settings-preview-label">Preview</span>
            <ProfileHeader profile={{ handle, kind: scope, displayName: draft.displayName, bio: draft.bio, links: cleanLinks(draft.links), location: draft.location, website: draft.website }} />
          </div>
          <div className="profile-settings-guide">
            <span className="profile-settings-preview-label">Make your profile great<small>{done}/{tips.length}</small></span>
            <ul className="profile-settings-tips" aria-label="Profile tips">{tips.map(item => <li key={item.id} data-done={item.done}>
              {item.done ? <CheckCircleIcon size={16} weight="fill" aria-label="Done" /> : <CircleIcon size={16} aria-label="To do" />}
              <span>{item.label}</span><InfoTip label={item.label}>{item.tip}</InfoTip>
            </li>)}</ul>
          </div>
        </aside>
      </div>
    </form>
  </section>;
}
