import { useEffect, useState } from "react";
import { Switch } from "@cloudflare/kumo/components/switch";
import { BellSlashIcon, BookBookmarkIcon, CheckCircleIcon, UserIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo/components/button";
import type { SubscriptionEntry, SubscriptionList } from "../shared/types";
import { EMAIL_MODES, NOTIFICATION_REASONS, REASON_LABELS, type EmailMode, type NotificationReason, type NotificationSettings as Settings } from "../shared/notifications";
import { request, RequestError } from "./api";
import { ErrorNotice } from "./components";
import InfoTip from "./InfoTip";
import { MODE_LABELS, REASON_TIPS, sentTodayLabel, setReasonMode } from "./inbox-data";
import { RouteProgress } from "./WorkspaceLoader";
import "./inbox.css";

export function Subscriptions() {
  const [items, setItems] = useState<SubscriptionEntry[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    let active = true;
    request<SubscriptionList>("/api/subscriptions").then(value => { if (active) setItems(value.items); }, failure => {
      if (!active) return;
      if (failure instanceof RequestError && (failure.code === "HOSTED_ONLY" || failure.status === 403)) setHidden(true);
      else setError(failure instanceof Error ? failure.message : "Subscriptions could not be loaded.");
    });
    return () => { active = false; };
  }, []);
  async function unsubscribe(entry: SubscriptionEntry) {
    const key = `${entry.kind}:${entry.handle}/${entry.repository ?? ""}`;
    setBusy(key); setError("");
    try {
      await request("/api/subscriptions", { kind: entry.kind, handle: entry.handle, ...(entry.repository ? { repository: entry.repository } : {}), on: false });
      setItems(current => current ? current.filter(item => item !== entry) : current);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The subscription could not be removed."); }
    finally { setBusy(""); }
  }
  if (hidden) return null;
  return <section className="panel">
    <div className="panel-header"><h2>Subscriptions</h2><InfoTip label="subscriptions">A daily digest of landed revisions and releases from the people and public repositories you subscribe to. Subscribe from any profile or public repository page.</InfoTip></div>
    {error && <div className="form-error" role="alert">{error}</div>}
    {items === null ? <div className="panel-body"><p className="people-muted" role="status">Loading subscriptions…</p></div>
      : !items.length ? <div className="panel-body"><p className="people-muted">No subscriptions yet.</p></div>
      : <ul className="notification-reasons subscription-list" aria-label="Subscriptions">{items.map(entry => {
        const key = `${entry.kind}:${entry.handle}/${entry.repository ?? ""}`;
        return <li key={key}>
          <a className="subscription-target" href={entry.url}>{entry.kind === "person" ? <UserIcon size={15} aria-hidden="true" /> : <BookBookmarkIcon size={15} aria-hidden="true" />}<span>{entry.kind === "person" ? `@${entry.handle}` : `${entry.handle}/${entry.repository}`}</span></a>
          <Button variant="ghost" size="sm" icon={BellSlashIcon} loading={busy === key} disabled={!!busy} onClick={() => void unsubscribe(entry)}>Unsubscribe</Button>
        </li>;
      })}</ul>}
  </section>;
}

export default function NotificationSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoadError("");
    request<Settings>("/api/notifications/settings").then(value => { if (active) setSettings(value); }, failure => { if (active) setLoadError(failure instanceof Error ? failure.message : "Notification settings could not be loaded."); });
    return () => { active = false; };
  }, [attempt]);

  async function save(key: string, body: { email?: boolean; reasons?: Partial<Record<NotificationReason, EmailMode>> }, optimistic: Settings) {
    if (!settings || busy) return;
    const previous = settings;
    setSettings(optimistic);
    setBusy(key);
    setError("");
    try { setSettings(await request<Settings>("/api/notifications/settings", body)); }
    catch (failure) { setSettings(previous); setError(failure instanceof Error ? failure.message : "The change could not be saved."); }
    finally { setBusy(""); }
  }

  if (loadError) return <ErrorNotice message={loadError} onRetry={() => setAttempt(value => value + 1)} />;
  if (!settings) return <RouteProgress />;
  const { preferences, email } = settings;
  const canEmail = email.configured && !!email.address;
  const quiet = [preferences.email ? sentTodayLabel(email.sentToday, email.dailyLimit) : "", preferences.email && email.nextDigestAt ? `Next digest ${new Date(email.nextDigestAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""].filter(Boolean).join(" · ");
  return <>
    {error && <div className="form-error" role="alert">{error}</div>}
    <section className="panel notification-email">
      <div className="panel-header">
        <h2>Email</h2>
        <Switch label="Email notifications" checked={preferences.email} disabled={!canEmail || !!busy} onCheckedChange={checked => void save("email", { email: checked }, { ...settings, preferences: { ...preferences, email: checked } })} />
      </div>
      <div className="panel-body">
        {!email.configured ? <p className="people-muted">Email is not set up on this installation.</p>
          : !email.address ? <p className="people-muted">Add an email address to your account to receive email.</p>
          : <p className="notification-address"><span>{email.address}</span>{email.verified
            ? <span className="account-method-on"><CheckCircleIcon size={15} weight="fill" aria-hidden="true" />Verified</span>
            : <span className="notification-unverified"><WarningCircleIcon size={15} aria-hidden="true" />Not verified<InfoTip label="unverified email">Verify this address from your profile before email can be sent.</InfoTip></span>}</p>}
        {quiet && <small className="notification-quiet">{quiet}</small>}
      </div>
    </section>
    <section className="panel">
      <div className="panel-header"><h2>What to email</h2><InfoTip label="email reasons">Everything still appears in your inbox. These choices only change email.</InfoTip></div>
      <ul className="notification-reasons">
        {NOTIFICATION_REASONS.map(reason => <li key={reason}>
          <span className="notification-reason-label">{REASON_LABELS[reason]}<InfoTip label={REASON_LABELS[reason]}>{REASON_TIPS[reason]}</InfoTip></span>
          <div className="notification-modes" role="radiogroup" aria-label={`${REASON_LABELS[reason]} email`}>
            {EMAIL_MODES.map(mode => <label key={mode}><input type="radio" name={`email-${reason}`} value={mode} checked={preferences.reasons[reason] === mode} disabled={!preferences.email || !!busy} onChange={() => void save(reason, { reasons: { [reason]: mode } }, { ...settings, preferences: setReasonMode(preferences, reason, mode) })} /><span>{MODE_LABELS[mode]}</span></label>)}
          </div>
        </li>)}
      </ul>
    </section>
    <Subscriptions />
  </>;
}
