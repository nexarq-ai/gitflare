import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { RobotIcon, SparkleIcon } from "@phosphor-icons/react";
import type { AgentMissionEntry, AgentMissionState, FixQuote, FixRequest, FixRequests, MissionStatus } from "../shared/types";
import { request } from "./api";
import { relativeTime } from "./components";
import { useConfirm } from "./ConfirmDialog";
import type { ConfirmFact } from "./deploy-progress";
import InfoTip from "./InfoTip";
import "./fix-requests.css";

const STATE_LABELS: Record<AgentMissionState, string> = { planning: "Planning", waiting: "Waiting for a maintainer", running: "Agents working", review: "In review", landed: "Landed", closed: "Closed", failed: "Failed" };
const ABOUT = "An agent proposes a change for the maintainers to review. Uses this project's community AI pool or your own key.";

function requester(entry: AgentMissionEntry): string {
  return entry.requester.handle ? `@${entry.requester.handle}` : entry.requester.name;
}

export function AgentState({ state }: { state: AgentMissionState }) {
  return <span className={`fix-state fix-state-${state}`}>{STATE_LABELS[state]}</span>;
}

function failure(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function quoteFacts(quote: FixQuote): ConfirmFact[] {
  return [
    { label: "Paid by", value: quote.source === "pool" ? "This project's community AI pool" : "Your AI key" },
    ...(quote.model ? [{ label: "Model", value: quote.model.label }] : []),
    { label: "Starts", value: quote.waitsForMaintainer ? "When a maintainer starts it" : "Right away" },
    ...(quote.remainingToday !== null ? [{ label: "Left today", value: String(quote.remainingToday) }] : []),
  ];
}

function useQuote(api: string, query: string, reload: number) {
  const [data, setData] = useState<FixRequests | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    request<FixRequests>(`${api}/fix-requests?${query}`).then(value => { if (active) { setData(value); setError(""); } }, (cause: unknown) => { if (active) setError(failure(cause, "Fix requests could not be loaded.")); });
    return () => { active = false; };
  }, [api, query, reload]);
  return { data, error };
}

export function RequestFix({ api, issueNumber, open, signIn }: { api: string; issueNumber: number; open: boolean; signIn: ReactNode }) {
  const [reload, setReload] = useState(0);
  const { data, error } = useQuote(api, `issue=${issueNumber}&quote=1`, reload);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirm, dialog] = useConfirm();
  const key = useRef(crypto.randomUUID());
  const quote = data?.quote;

  async function start() {
    if (!quote?.available) return;
    const accepted = await confirm({ title: "Request a fix?", description: "An agent plans the change now; agents then work in an isolated fork without secrets. Maintainers review and decide whether it lands.", facts: quoteFacts(quote), confirmLabel: "Request fix" });
    if (!accepted) return;
    setBusy(true); setMessage("");
    try {
      const result = await request<{ waitingForMaintainer: boolean }>(`${api}/fix-requests`, { issueNumber }, key.current);
      key.current = crypto.randomUUID();
      setMessage(result.waitingForMaintainer ? "Requested. It starts when a maintainer starts it." : "Requested. Agents are working on it.");
      setReload(value => value + 1);
    } catch (cause) { setMessage(failure(cause, "The fix could not be requested.")); key.current = crypto.randomUUID(); }
    finally { setBusy(false); }
  }

  const action = !quote ? null
    : !quote.signedIn ? signIn
    : !quote.available ? <span className="fix-action"><Button variant="secondary" size="sm" icon={SparkleIcon} disabled>{quote.reason.startsWith("Add an AI key") ? "Add an AI key to request fixes" : "Request fix"}</Button><InfoTip label="requesting fixes">{quote.reason}</InfoTip></span>
    : open ? <span className="fix-action"><Button variant="secondary" size="sm" icon={SparkleIcon} loading={busy} onClick={() => void start()}>Request fix</Button><InfoTip label="requesting fixes">{ABOUT} {quote.reason}</InfoTip></span>
    : null;

  if (!data && !error) return null;
  return <section className="fix-requests" aria-label="Agent fixes">
    <div className="fix-requests-head"><RobotIcon size={16} aria-hidden="true" /><strong>Agent fixes</strong>{action}</div>
    {error && <p className="fix-requests-note" role="alert">{error}</p>}
    {message && <p className="fix-requests-note" role="status">{message}</p>}
    {data && data.missions.length > 0 && <ul className="fix-list">{data.missions.map(entry => <li key={entry.id}><span className="fix-title">{entry.title}</span><span className="fix-meta">{requester(entry)} · {relativeTime(entry.createdAt)}</span><AgentState state={entry.state} /></li>)}</ul>}
    {dialog}
  </section>;
}

export function AgentMissions({ api, issueLink }: { api: string; issueLink: (number: number) => ReactNode }) {
  const { data, error } = useQuote(api, "", 0);
  if (error) return <section className="repo-panel"><div className="repo-panel-padding"><div className="error-notice" role="alert">{error}</div></div></section>;
  if (!data) return <section className="repo-panel" aria-busy="true"><p className="repo-panel-padding" role="status">Loading…</p></section>;
  return <section className="repo-panel">
    <div className="repo-panel-heading"><h2><RobotIcon size={16} aria-hidden="true" />Agent work</h2><InfoTip label="agent work">Changes people asked agents to make. Each one is a proposal that a maintainer reviews before it lands.</InfoTip></div>
    {data.missions.length ? <ul className="fix-list fix-list-page">{data.missions.map(entry => <li key={entry.id}>
      <span className="fix-title">{entry.title}</span>
      <span className="fix-meta">{entry.issueNumber ? <>{issueLink(entry.issueNumber)} · </> : null}requested by {requester(entry)} · {relativeTime(entry.createdAt)} · {entry.source === "pool" ? "community pool" : "requester's key"}</span>
      <AgentState state={entry.state} />
    </li>)}</ul> : <p className="repo-panel-padding fix-requests-note">No agent work requested yet.</p>}
  </section>;
}

export function RequestChange({ api, authenticated, signIn }: { api: string; authenticated: boolean; signIn: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const [quote, setQuote] = useState<FixQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const key = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!open) return;
    let active = true;
    setQuote(null); setError(""); setDone("");
    request<FixRequests>(`${api}/fix-requests?quote=1`).then(value => { if (active) setQuote(value.quote); }, (cause: unknown) => { if (active) setError(failure(cause, "This project could not be checked.")); });
    return () => { active = false; };
  }, [api, open]);

  async function submit() {
    setBusy(true); setError("");
    try {
      const result = await request<{ waitingForMaintainer: boolean }>(`${api}/fix-requests`, { goal: goal.trim() }, key.current);
      key.current = crypto.randomUUID();
      setDone(result.waitingForMaintainer ? "Requested. It starts when a maintainer starts it." : "Requested. Agents are working on it.");
      setGoal("");
    } catch (cause) { setError(failure(cause, "The change could not be requested.")); key.current = crypto.randomUUID(); }
    finally { setBusy(false); }
  }

  if (!authenticated) return <div className="fix-change">{signIn}</div>;
  return <div className="fix-change">
    <Button variant="secondary" size="sm" icon={SparkleIcon} onClick={() => setOpen(true)}>Request a change</Button>
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog size="sm" className="dialog-content">
        <Dialog.Title className="dialog-title">Request a change</Dialog.Title>
        <Dialog.Description className="dialog-description">{ABOUT}</Dialog.Description>
        {quote && (quote.available
          ? <dl className="confirm-facts">{quoteFacts(quote).map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>
          : <p className="fix-requests-note" role="status">{quote.reason}</p>)}
        <div className="form-field"><label htmlFor="fix-goal">What should change?</label><textarea id="fix-goal" className="fix-goal" rows={5} maxLength={4000} value={goal} disabled={busy || !quote?.available} onChange={event => setGoal(event.target.value)} placeholder="Describe the change and how to tell it works." /></div>
        {error && <div className="error-notice" role="alert">{error}</div>}
        {done && <p className="fix-requests-note" role="status">{done}</p>}
        <div className="dialog-actions">
          <Button variant="secondary" size="base" type="button" onClick={() => setOpen(false)}>Close</Button>
          <Button variant="primary" size="base" type="button" loading={busy} disabled={!quote?.available || goal.trim().length < 10} onClick={() => void submit()}>Request change</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  </div>;
}

export function FixRequestNote({ fix, status }: { fix: FixRequest; status: MissionStatus }) {
  const who = fix.requester.handle ? `@${fix.requester.handle}` : fix.requester.name;
  return <div className="alert info fix-note">
    <RobotIcon size={16} aria-hidden="true" />
    <div className="alert-text">
      Requested by {who}{fix.issueNumber ? ` for issue #${fix.issueNumber}` : ""} · paid by {fix.source === "pool" ? "this repository's community pool" : "the requester's AI key"} · {fix.model}
      {fix.waiting && status === "draft" ? ". Start it to run the agents." : "."}
      <InfoTip label="requested fixes">Agents run in isolated forks without secrets, with checks from this repository's base. The requester cannot approve or land it.</InfoTip>
    </div>
  </div>;
}
