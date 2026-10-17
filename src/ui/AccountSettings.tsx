import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { ShieldCheckIcon, UserCircleIcon } from "@phosphor-icons/react";
import type { AccessSnapshot } from "../shared/types";
import { request, RequestError } from "./api";
import { VerifyEmailNotice, type AuthConfig } from "./AuthScreen";
import { RouteProgress } from "./WorkspaceLoader";
import "./account-settings.css";

type Challenge = { challengeId: string; secret?: string; expiresAt: number };
export default function AccountSettings({ section, config, onChanged }: { section: "profile" | "security"; config: AuthConfig; onChanged: () => Promise<void> }) {
  const [data, setData] = useState<AccessSnapshot | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  async function load() { try { setData(await request<AccessSnapshot>("/api/access")); setError(""); } catch (failure) { setError(failure instanceof Error ? failure.message : "Your account could not be loaded."); } }
  useEffect(() => { void load(); }, []);
  useEffect(() => { setChallenge(null); setRecoveryCodes([]); setNotice(""); setError(""); }, [section]);
  async function revoke(id: string) {
    setBusy(true); setError(""); setNotice("");
    try { await request("/api/access/session-revoke", { id }); await load(); setNotice("Session revoked."); await onChanged(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The session could not be revoked."); }
    finally { setBusy(false); }
  }
  async function enroll() {
    setBusy(true); setError(""); setNotice("");
    try { setChallenge(await request<Challenge>("/api/access/mfa-enroll", {})); }
    catch (failure) { if (failure instanceof RequestError && failure.code === "MFA_ALREADY_ENABLED") setNotice("Your Gitflare authenticator is already enabled."); else setError(failure instanceof Error ? failure.message : "Authenticator setup could not be started."); }
    finally { setBusy(false); }
  }
  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!challenge) return;
    const fields = new FormData(event.currentTarget); setBusy(true); setError("");
    try { const result = await request<{ recoveryCodes?: string[] }>("/api/mfa/verify", { challengeId: challenge.challengeId, code: fields.get("code") }); setRecoveryCodes(result.recoveryCodes ?? []); setChallenge(null); setNotice("Authenticator enabled. Save your recovery codes before leaving this page."); await load(); await onChanged(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The code could not be verified."); }
    finally { setBusy(false); }
  }
  const user = data?.user;
  const email = user && "email" in user ? user.email : undefined;
  const linked = user && "cloudflareLinked" in user && user.cloudflareLinked;
  return <section className="account-settings" aria-labelledby="account-heading">
    <div className="account-page-heading"><span className="account-page-icon">{section === "profile" ? <UserCircleIcon size={26}/> : <ShieldCheckIcon size={26}/>}</span><div><h1 id="account-heading">{section === "profile" ? "Your profile" : "Account security"}</h1><p>{section === "profile" ? "Your identity and workspace membership." : "Manage your sign-in and active sessions."}</p></div></div>
    <nav className="account-page-nav" aria-label="Account settings"><a href="/account/profile" aria-current={section === "profile" ? "page" : undefined}>Profile</a><a href="/account/security" aria-current={section === "security" ? "page" : undefined}>Security</a></nav>
    {error && <div className="form-error" role="alert">{error}{!data && <Button variant="ghost" onClick={() => void load()}>Retry</Button>}</div>}
    {notice && <p className="account-notice" role="status">{notice}</p>}
    {!data ? !error && <RouteProgress/> : section === "profile" ? <>
      <section className="account-card"><h2>Identity</h2><dl className="account-details"><dt>Name</dt><dd>{data.user.name}</dd><dt>Email</dt><dd>{email ?? "Owner token session"}</dd><dt>Email verification</dt><dd>{data.user.emailVerified ? "Verified" : email ? "Unverified" : "Not applicable"}</dd><dt>Sign-in connection</dt><dd>{linked ? "Cloudflare linked" : email ? "Gitflare account" : "Installation owner token"}</dd></dl>{email && <VerifyEmailNotice user={{ email, emailVerified: data.user.emailVerified }}/>}<p className="account-hint">Profile changes are not available in Gitflare. Your current account details are shown above.</p></section>
      <section className="account-card"><h2>Workspace membership</h2><dl className="account-details"><dt>Workspace</dt><dd>{data.workspace?.name ?? "Gitflare workspace"}</dd><dt>Your role</dt><dd>{data.role}</dd></dl><a className="account-inline-link" href="/settings">Open workspace settings</a></section>
    </> : <>
      <section className="account-card"><h2>Sign-in protection</h2>{email ? <><p>{linked ? "Your Cloudflare login is linked to this account. Manage its password and two-factor authentication in Cloudflare." : "Email sign-in uses your Gitflare password and any enrolled authenticator."}</p>{!linked && config.passwordReset && <a className="account-inline-link" href="/forgot-password">Reset your password</a>}<div className="account-card-divider"/><h3>Gitflare authenticator</h3><p>Enroll a time-based authenticator for Gitflare email sign-in. Existing authenticator enrollment remains in place.</p>{!challenge && !recoveryCodes.length && <Button variant="secondary" disabled={busy} onClick={() => void enroll()}>Set up authenticator</Button>}{challenge && <form onSubmit={event => void verify(event)} className="account-enrollment"><p>Add this setup key to your authenticator as a time-based account for {email}. It expires at {new Date(challenge.expiresAt).toLocaleTimeString()}.</p><code>{challenge.secret}</code><label>Authenticator code<input name="code" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code"/></label><div className="account-form-actions"><Button variant="primary" type="submit" disabled={busy}>Verify and enable</Button><Button variant="ghost" type="button" disabled={busy} onClick={() => setChallenge(null)}>Cancel</Button></div></form>}{recoveryCodes.length > 0 && <div className="account-recovery"><h3>Recovery codes</h3><p>Keep these single-use codes somewhere private. They are only shown once.</p><div>{recoveryCodes.map(code => <code key={code}>{code}</code>)}</div><Button variant="secondary" onClick={() => setRecoveryCodes([])}>I have saved these codes</Button></div>}</> : <p>This session uses an installation owner token. Account password and authenticator settings require a personal account.</p>}</section>
      <section className="account-card"><h2>Your sessions</h2><p>Revoke access for a browser or AI client. Revoking this browser’s session signs you out.</p>{data.sessions.length ? <ul className="account-session-list">{data.sessions.map(session => <li key={session.id}><div><strong>{session.client || "Browser session"}</strong><span>Expires {new Date(session.expiresAt).toLocaleString()}</span><span>{session.revoked ? "Revoked" : "Active"}</span></div><Button variant="secondary" disabled={busy || session.revoked} onClick={() => void revoke(session.id)}>Revoke</Button></li>)}</ul> : <p className="account-hint">No personal sessions to show.</p>}<a className="account-inline-link" href="/connect">Manage AI client connections</a></section>
    </>}
  </section>;
}
