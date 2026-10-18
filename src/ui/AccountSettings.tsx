import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { ArrowSquareOutIcon, CheckCircleIcon, CopyIcon, DesktopIcon, KeyIcon, PlugsConnectedIcon } from "@phosphor-icons/react";
import type { AccountSnapshot } from "../shared/types";
import { request, RequestError } from "./api";
import { VerifyEmailNotice, type AuthConfig } from "./AuthScreen";
import { SettingsLayout } from "./SettingsLayout";
import { RouteProgress } from "./WorkspaceLoader";
import { ErrorNotice } from "./components";
import DemoFeaturePanel from "./DemoFeaturePanel";
import { needsRecentSignIn, signInAgain } from "./reauth";
import { accountSections, browserSessions, clientSessions, describeSession, tokenSessions, type AccountSection } from "./account-data";
import "./account-settings.css";
import "./people-settings.css";

type Props = { section: AccountSection; config: AuthConfig; onChanged: () => Promise<void>; onSwitchWorkspace: (id: string) => Promise<void>; onSignOut: () => void; children?: ReactNode };
type Session = AccountSnapshot["sessions"][number];

export default function AccountSettings({ section, config, onChanged, onSwitchWorkspace, onSignOut, children }: Props) {
  const [data, setData] = useState<AccountSnapshot | null>(null);
  const [error, setError] = useState("");
  async function load() { try { setData(await request<AccountSnapshot>("/api/account")); setError(""); } catch (failure) { setError(failure instanceof Error ? failure.message : "Your account could not be loaded."); } }
  useEffect(() => { void load(); }, []);
  const titles: Record<AccountSection, [string, string]> = {
    profile: ["Profile", "Who you are in Gitflare and where you work."],
    security: ["Security", "How you sign in."],
    sessions: ["Sessions", "Browsers signed in to your account."],
    clients: ["AI clients", "AI clients and personal tokens that act as you."],
  };
  return <SettingsLayout title="Your account" items={accountSections.map(item => ({ href: `/account/${item.id}`, label: item.label, current: item.id === section, ai: item.id === "clients" }))}>
    <div className="page-heading"><div><h1>{titles[section][0]}</h1><p>{titles[section][1]}</p></div></div>
    {error && <ErrorNotice message={error} onRetry={() => void load()} />}
    {!data ? !error && <RouteProgress /> : section === "profile" ? <Profile data={data} config={config} onSwitchWorkspace={onSwitchWorkspace} />
      : config.demo && (section === "security" || section === "sessions") ? <DemoFeaturePanel feature="account-security" />
      : section === "security" ? <Security data={data} config={config} onChanged={async () => { await load(); await onChanged(); }} />
      : section === "sessions" ? <Sessions data={data} reload={load} onSignOut={onSignOut} />
      : <Clients data={data} reload={load}>{children}</Clients>}
  </SettingsLayout>;
}

function Profile({ data, config, onSwitchWorkspace }: { data: AccountSnapshot; config: AuthConfig; onSwitchWorkspace: (id: string) => Promise<void> }) {
  const user = data.user;
  const email = "email" in user ? user.email : undefined;
  const linked = "cloudflareLinked" in user && user.cloudflareLinked;
  const password = "passwordSignIn" in user && user.passwordSignIn;
  const [switching, setSwitching] = useState("");
  return <>
    <section className="panel">
      <div className="panel-header"><h2>Identity</h2></div>
      <div className="panel-body"><div className="people-person"><span className="people-avatar" aria-hidden="true">{user.name.split(/\s+/).map(word => word[0]).slice(0, 2).join("").toUpperCase()}</span><div><strong>{user.name}</strong><small>{email ?? "Installation owner token"}</small></div></div>
        {email && <VerifyEmailNotice user={{ email, emailVerified: user.emailVerified }} />}
      </div>
    </section>
    {email && <section className="panel">
      <div className="panel-header"><h2>Sign-in methods</h2></div>
      <ul className="people-list">
        {(linked || config.cloudflareSignin) && <li><div><strong>Cloudflare</strong><small>{linked ? "Sign in with Cloudflare is linked to this account." : "Not linked. Sign in with Cloudflare using this email to link it."}</small></div>{linked ? <span className="account-method-on"><CheckCircleIcon size={16} weight="fill" aria-hidden="true" />Linked</span> : <span className="people-muted">Not linked</span>}</li>}
        {password && <li><div><strong>Email and password</strong><small>{email}</small></div>{config.passwordReset ? <a className="account-inline-link" href="/forgot-password">Reset password</a> : <span className="account-method-on"><CheckCircleIcon size={16} weight="fill" aria-hidden="true" />On</span>}</li>}
      </ul>
    </section>}
    <section className="panel">
      <div className="panel-header"><h2>Workspaces</h2><span className="number-tag">{data.workspaces.length}</span></div>
      <ul className="people-list">{data.workspaces.map(item => <li key={item.id}>
        <div><strong>{item.name}{item.current && <span className="people-tag">Current</span>}</strong><small>{item.repositoryScoped ? "Some repositories" : "All repositories"}</small></div>
        <span className="people-role-text">{item.role}</span>
        {!item.current && config.edition !== "self-hosted" && <Button variant="ghost" size="sm" loading={switching === item.id} disabled={!!switching} onClick={() => { setSwitching(item.id); void onSwitchWorkspace(item.id).finally(() => setSwitching("")); }}>Switch</Button>}
      </li>)}</ul>
    </section>
  </>;
}

type Challenge = { challengeId: string; secret?: string; expiresAt: number };
function Security({ data, config, onChanged }: { data: AccountSnapshot; config: AuthConfig; onChanged: () => Promise<void> }) {
  const user = data.user;
  const email = "email" in user ? user.email : undefined;
  const linked = "cloudflareLinked" in user && user.cloudflareLinked;
  const password = "passwordSignIn" in user && user.passwordSignIn;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reauth, setReauth] = useState(false);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  async function enroll() {
    setBusy(true); setError(""); setReauth(false);
    try { setChallenge(await request<Challenge>("/api/access/mfa-enroll", {})); }
    catch (failure) { if (needsRecentSignIn(failure)) setReauth(true); else if (failure instanceof RequestError && failure.code === "MFA_ALREADY_ENABLED") await onChanged(); else setError(failure instanceof Error ? failure.message : "Authenticator setup could not be started."); }
    finally { setBusy(false); }
  }
  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!challenge) return;
    const fields = new FormData(event.currentTarget); setBusy(true); setError("");
    try { const result = await request<{ recoveryCodes?: string[] }>("/api/mfa/verify", { challengeId: challenge.challengeId, code: fields.get("code") }); setRecoveryCodes(result.recoveryCodes ?? []); setChallenge(null); await onChanged(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The code was not accepted."); }
    finally { setBusy(false); }
  }
  if (!email) return <section className="panel"><div className="panel-body"><p className="people-muted">This session uses the installation owner token. Passwords, authenticators and sessions belong to personal accounts.</p></div></section>;
  return <>
    {linked && <section className="panel">
      <div className="panel-header"><h2>Cloudflare sign-in</h2><span className="account-method-on"><CheckCircleIcon size={16} weight="fill" aria-hidden="true" />Linked</span></div>
      <div className="panel-body">
        <p className="people-muted">{password ? "You can also sign in with Cloudflare." : "You sign in with Cloudflare. Password and two-factor are managed in your Cloudflare account."}</p>
        <a className="account-inline-link" href="https://dash.cloudflare.com/profile/authentication" target="_blank" rel="noreferrer">Open Cloudflare sign-in settings <ArrowSquareOutIcon size={13} aria-hidden="true" /></a>
      </div>
    </section>}
    {password && <section className="panel">
      <div className="panel-header"><h2>Password</h2></div>
      <div className="panel-body"><p className="people-muted">You can sign in with {email} and a Gitflare password.</p>{config.passwordReset && <a className="account-inline-link" href="/forgot-password">Reset your password</a>}</div>
    </section>}
    {password && <section className="panel">
      <div className="panel-header"><h2>Authenticator</h2>{data.mfaEnabled && <span className="account-method-on"><CheckCircleIcon size={16} weight="fill" aria-hidden="true" />On</span>}</div>
      <div className="panel-body">
        {recoveryCodes.length > 0 ? <div className="account-recovery"><h3>Recovery codes</h3><p className="people-muted">Keep these single-use codes somewhere private. They are shown once.</p><div>{recoveryCodes.map(code => <code key={code}>{code}</code>)}</div><Button variant="secondary" size="base" onClick={() => setRecoveryCodes([])}>I have saved these codes</Button></div>
          : data.mfaEnabled ? <p className="people-muted">Email sign-in asks for a code from your authenticator app.</p>
          : challenge ? <form onSubmit={event => void verify(event)} className="account-enrollment"><p className="people-muted">Add this setup key to your authenticator as a time-based account for {email}. It expires at {new Date(challenge.expiresAt).toLocaleTimeString()}.</p><code>{challenge.secret}</code><label>Code from the app<input name="code" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" /></label><div className="account-form-actions"><Button variant="primary" type="submit" loading={busy}>Turn on</Button><Button variant="ghost" type="button" disabled={busy} onClick={() => setChallenge(null)}>Cancel</Button></div></form>
          : <><p className="people-muted">Ask for a code from an authenticator app when you sign in with your password.</p><Button variant="secondary" size="base" loading={busy} onClick={() => void enroll()}>Set up authenticator</Button></>}
        {reauth && <div className="people-reauth" role="alert"><p>Sign in again first. Setting up an authenticator needs a sign-in from the last five minutes.</p><Button variant="primary" size="sm" onClick={() => void signInAgain("account/security")}>Sign in again</Button></div>}
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
    </section>}
  </>;
}

function SessionRow({ session, current, busy, onSignOut }: { session: Session; current: boolean; busy: boolean; onSignOut: () => void }) {
  const info = describeSession(session);
  return <li>
    <DesktopIcon size={20} aria-hidden="true" className="account-session-icon" />
    <div><strong>{info.title}{current && <span className="people-tag">This device</span>}</strong><small>{[info.location, info.workspace, info.signedIn].filter(Boolean).join(" · ")}</small></div>
    <Button variant="ghost" size="sm" loading={busy} onClick={onSignOut}>Sign out</Button>
  </li>;
}

function Sessions({ data, reload, onSignOut }: { data: AccountSnapshot; reload: () => Promise<void>; onSignOut: () => void }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const sessions = browserSessions(data);
  const current = sessions.find(item => item.id === data.currentSessionId);
  const others = sessions.filter(item => item.id !== data.currentSessionId);
  async function act(key: string, path: string, body: unknown, done: string) {
    setBusy(key); setError(""); setNotice("");
    try { await request(path, body); setNotice(done); await reload(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The session could not be signed out."); }
    finally { setBusy(""); }
  }
  return <>
    {error && <div className="form-error" role="alert">{error}</div>}
    {notice && <p className="people-notice" role="status">{notice}</p>}
    <section className="panel">
      <div className="panel-header"><h2>Signed in</h2>{others.length > 0 && <Button variant="secondary" size="sm" loading={busy === "others"} disabled={!!busy} onClick={() => void act("others", "/api/account/sessions/revoke-others", {}, "Signed out everywhere else.")}>Sign out everywhere else</Button>}</div>
      <ul className="people-list account-sessions">
        {current && <SessionRow session={current} current busy={false} onSignOut={onSignOut} />}
        {others.map(session => <SessionRow key={session.id} session={session} current={false} busy={busy === session.id} onSignOut={() => void act(session.id, "/api/access/session-revoke", { id: session.id }, "Signed out that session.")} />)}
      </ul>
      <div className="panel-body"><p className="people-muted">{others.length ? "" : "No other browsers are signed in. "}AI clients and personal tokens are listed under <a href="/account/clients">AI clients</a>.</p></div>
    </section>
  </>;
}

function Clients({ data, reload, children }: { data: AccountSnapshot; reload: () => Promise<void>; children?: ReactNode }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [reauth, setReauth] = useState(false);
  const [secret, setSecret] = useState("");
  const [copied, setCopied] = useState(false);
  const clients = clientSessions(data);
  const tokens = tokenSessions(data);
  const current = data.workspaces.find(item => item.current);
  async function act(key: string, path: string, body: unknown) {
    setBusy(key); setError(""); setReauth(false);
    try { const result = await request<{ token?: string }>(path, body); if (result.token) { setSecret(result.token); setCopied(false); } await reload(); }
    catch (failure) { if (needsRecentSignIn(failure)) setReauth(true); else setError(failure instanceof Error ? failure.message : "The change could not be saved."); }
    finally { setBusy(""); }
  }
  return <>
    {error && <div className="form-error" role="alert">{error}</div>}
    <section className="panel">
      <div className="panel-header"><h2>Connected AI clients</h2><span className="number-tag">{clients.length}</span></div>
      {clients.length ? <ul className="people-list">{clients.map(session => <li key={session.id}><PlugsConnectedIcon size={20} aria-hidden="true" className="account-session-icon" /><div><strong>{session.client}</strong><small>{[session.workspaceName, `Expires ${new Date(session.expiresAt).toLocaleDateString()}`].filter(Boolean).join(" · ")}</small></div><Button variant="ghost" size="sm" loading={busy === session.id} disabled={!!busy} onClick={() => void act(session.id, "/api/access/session-revoke", { id: session.id })}>Revoke</Button></li>)}</ul>
        : <div className="panel-body"><p className="people-muted">No AI client is connected. Follow the steps below to connect one.</p></div>}
      <div className="panel-body"><p className="people-muted">Connected AI clients act in the workspace you chose when you connected them{current ? ` (now ${current.name})` : ""}. To use another workspace, connect the client again from that workspace.</p></div>
    </section>
    <section className="panel">
      <div className="panel-header"><h2>Personal tokens</h2><Button variant="secondary" size="sm" loading={busy === "token"} disabled={!!busy} onClick={() => void act("token", "/api/access/session-create", {})}>Create token</Button></div>
      {secret && <div className="panel-body"><div className="people-secret" role="region" aria-label="New personal token"><strong>New personal token</strong><p>Use it as a bearer token for MCP clients without OAuth, or as the Git password. Copy it now; it is shown once.</p><code>{secret}</code><div><Button variant="secondary" size="sm" icon={CopyIcon} onClick={() => void navigator.clipboard.writeText(secret).then(() => setCopied(true)).catch(() => {})}>{copied ? "Copied" : "Copy"}</Button><Button variant="ghost" size="sm" onClick={() => setSecret("")}>Dismiss</Button></div></div></div>}
      {reauth && <div className="panel-body"><div className="people-reauth" role="alert"><p>Sign in again first. New tokens need a sign-in from the last few minutes.</p><Button variant="primary" size="sm" onClick={() => void signInAgain("account/clients")}>Sign in again</Button></div></div>}
      {tokens.length ? <ul className="people-list">{tokens.map(session => <li key={session.id}><KeyIcon size={20} aria-hidden="true" className="account-session-icon" /><div><strong>Personal token</strong><small>{[session.workspaceName, session.authenticatedAt ? `Created ${new Date(session.authenticatedAt).toLocaleString()}` : "", `Expires ${new Date(session.expiresAt).toLocaleString()}`].filter(Boolean).join(" · ")}</small></div><Button variant="ghost" size="sm" loading={busy === session.id} disabled={!!busy} onClick={() => void act(session.id, "/api/access/session-revoke", { id: session.id })}>Revoke</Button></li>)}</ul>
        : !secret && <div className="panel-body"><p className="people-muted">No personal tokens. Most clients connect with OAuth and do not need one.</p></div>}
    </section>
    {children}
  </>;
}
