import { useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { BellIcon, BellSlashIcon } from "@phosphor-icons/react";
import type { SubscriptionState } from "../shared/notifications";
import { request } from "./api";
import InfoTip from "./InfoTip";
import "./inbox.css";

export type SubscriptionTarget =
  | { kind: "issue"; repositoryId: string; number: number }
  | { kind: "proposal"; repositoryId: string; missionId: string }
  | { kind: "issue"; handle: string; repository: string; number: number };

export function subscriptionQuery(target: SubscriptionTarget): string {
  return new URLSearchParams(Object.entries(target).map(([key, value]) => [key, String(value)])).toString();
}

export function nextSubscription(state: SubscriptionState): SubscriptionState {
  return state === "subscribed" ? "ignored" : "subscribed";
}

export function publicThreadTarget(api: string, number: number): SubscriptionTarget | null {
  const match = /^\/api\/public\/repos\/([^/]+)\/([^/]+)$/.exec(api);
  if (!match) return null;
  try { return { kind: "issue", handle: decodeURIComponent(match[1]!), repository: decodeURIComponent(match[2]!), number }; } catch { return null; }
}

export default function SubscribeButton({ target }: { target: SubscriptionTarget }) {
  const [state, setState] = useState<SubscriptionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const query = subscriptionQuery(target);

  useEffect(() => {
    let active = true;
    setState(null);
    request<{ state: SubscriptionState }>(`/api/notifications/subscription?${query}`).then(result => { if (active) setState(result.state); }, () => {});
    return () => { active = false; };
  }, [query]);

  async function toggle() {
    if (!state || busy) return;
    setBusy(true); setError("");
    try { setState((await request<{ state: SubscriptionState }>("/api/notifications/subscription", { ...target, state: nextSubscription(state) })).state); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The subscription could not be changed."); }
    finally { setBusy(false); }
  }

  if (!state) return null;
  const subscribed = state === "subscribed";
  return <span className="subscribe-control">
    <Button variant="secondary" size="base" icon={subscribed ? BellSlashIcon : BellIcon} loading={busy} disabled={busy} aria-pressed={subscribed} onClick={() => void toggle()}>{subscribed ? "Unsubscribe" : "Subscribe"}</Button>
    <InfoTip label="notifications for this thread">Authors, commenters, reviewers and people mentioned are subscribed automatically. Unsubscribing stops thread updates; mentions and review requests still reach you.</InfoTip>
    {error && <small className="subscribe-error" role="alert">{error}</small>}
  </span>;
}
