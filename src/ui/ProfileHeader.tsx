import type { ReactNode } from "react";
import { GlobeSimpleIcon, LinkIcon, MapPinIcon } from "@phosphor-icons/react";
import type { ProfileFields, PublicHandleKind } from "../shared/types";
import "./profile-header.css";

export function initials(name: string): string {
  return name.split(/[\s_-]+/).filter(Boolean).map(word => word[0]).slice(0, 2).join("").toUpperCase() || "?";
}

export type ProfileHeaderFields = Pick<ProfileFields, "displayName" | "bio" | "links" | "location" | "website"> & { handle: string; kind: PublicHandleKind };

export function linkLabel(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.host.replace(/^www\./, "")}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch { return url; }
}

const secure = (url: string) => /^https:\/\//i.test(url);

export default function ProfileHeader({ profile, actions }: { profile: ProfileHeaderFields; actions?: ReactNode }) {
  const name = profile.displayName.trim() || profile.handle;
  const links = profile.links.filter(secure);
  const website = profile.website.trim();
  const facts = website && secure(website) ? [website] : [];
  return <header className="gfd-profile-head">
    <span className="gfd-avatar" aria-hidden="true">{initials(name)}</span>
    <div className="gfd-profile-body">
      <h1>{name}</h1>
      <p className="gfd-handle">@{profile.handle}{profile.kind === "workspace" && <span className="gfd-pill">Workspace</span>}</p>
      {profile.bio.trim() && <p className="gfd-bio">{profile.bio.trim()}</p>}
      {(profile.location.trim() || facts.length > 0 || links.length > 0) && <ul className="gfd-links">
        {profile.location.trim() && <li className="gfd-fact"><MapPinIcon size={14} aria-hidden="true" /><span>{profile.location.trim()}</span></li>}
        {facts.map(link => <li key={`website-${link}`}><a href={link} target="_blank" rel="noopener noreferrer me"><GlobeSimpleIcon size={14} aria-hidden="true" />{linkLabel(link)}</a></li>)}
        {links.map(link => <li key={link}><a href={link} target="_blank" rel="noopener noreferrer"><LinkIcon size={14} aria-hidden="true" />{linkLabel(link)}</a></li>)}
      </ul>}
    </div>
    {actions && <div className="gfd-profile-actions">{actions}</div>}
  </header>;
}
