import { useEffect, useState } from "react";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { BellRingingIcon, BellIcon } from "@phosphor-icons/react";
import type { SubscriptionStatus } from "../shared/types";
import { request } from "./api";
import InfoTip from "./InfoTip";
import "./inbox.css";

export type SubscriptionTarget = { kind: "person"; handle: string } | { kind: "repository"; handle: string; repository: string };

export function subscriptionQuery(target: SubscriptionTarget): string {
  return new URLSearchParams(Object.entries(target).map(([key, value]) => [key, String(value)])).toString();
}

export default function SubscriptionButton({ target, session, remote, size = "base" }: { target: SubscriptionTarget; session: boolean; remote?: string; size?: "sm" | "base" }) {
  const [state, setState] = useState<SubscriptionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const query = subscriptionQuery(target);

  useEffect(() => {
    let active = true;
    setState(null);
    if (!session) return;
    request<SubscriptionStatus>(`/api/subscriptions?${query}`).then(result => { if (active) setState(result); }, () => {});
    return () => { active = false; };
  }, [query, session]);

  async function toggle() {
    if (!state || busy) return;
    setBusy(true); setError("");
    try { setState(await request<SubscriptionStatus>("/api/subscriptions", { ...target, on: !state.subscribed })); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The subscription could not be changed."); }
    finally { setBusy(false); }
  }

  const what = target.kind === "person" ? `@${target.handle}` : `${target.handle}/${target.repository}`;
  if (!session && remote) return <span className="subscribe-control"><LinkButton variant="secondary" size={size} icon={BellIcon} href={remote}>Subscribe</LinkButton></span>;
  if (!state) return null;
  return <span className="subscribe-control">
    <Button variant={state.subscribed ? "primary" : "secondary"} size={size} icon={state.subscribed ? BellRingingIcon : BellIcon} loading={busy} disabled={busy} aria-pressed={state.subscribed} onClick={() => void toggle()}>{state.subscribed ? "Subscribed" : "Subscribe"}</Button>
    <InfoTip label={`subscription to ${what}`}>A daily digest of landed revisions and releases{target.kind === "person" ? ` from ${what}'s public repositories` : ""}. Email is opt-in in Account → Notifications.</InfoTip>
    {error && <small className="subscribe-error" role="alert">{error}</small>}
  </span>;
}
