import { useEffect, useState } from "react";
import { Switch } from "@cloudflare/kumo/components/switch";
import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { EMAIL_MODES, NOTIFICATION_REASONS, REASON_LABELS, type EmailMode, type NotificationReason, type NotificationSettings as Settings } from "../shared/notifications";
import { request } from "./api";
import { ErrorNotice } from "./components";
import InfoTip from "./InfoTip";
import { MODE_LABELS, REASON_TIPS, sentTodayLabel, setReasonMode } from "./inbox-data";
import { PageLoading } from "./WorkspaceLoader";
import "./inbox.css";

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
  if (!settings) return <PageLoading />;
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
  </>;
}
