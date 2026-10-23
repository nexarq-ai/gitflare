import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { RobotIcon, SparkleIcon } from "@phosphor-icons/react";
import { aiSetupPath, REQUEST_CHANGE_PARAM } from "../shared/ai-setup";
import type { AgentMissionEntry, AgentMissionState, FixQuote, FixRequest, FixRequests, MissionStatus } from "../shared/types";
import { request } from "./api";
import { relativeTime } from "./components";
import { useConfirm } from "./ConfirmDialog";
import { appHref } from "./hosts";
import { pageLocation } from "./page-context";
import { fixRequestsRequest } from "./public-requests";
import { useSeed } from "./use-seed";
import type { ConfirmFact } from "./deploy-progress";
import InfoTip from "./InfoTip";
import "./fix-requests.css";
import { PageLoading } from "./WorkspaceLoader";

const STATE_LABELS: Record<AgentMissionState, string> = { planning: "Planning", waiting: "Waiting for a maintainer", running: "Agents working", review: "In review", landed: "Landed", closed: "Closed", failed: "Failed" };
const ABOUT = "An agent drafts the change in an isolated fork without secrets. Maintainers review it and decide whether it lands.";

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
  const url = fixRequestsRequest(api, query);
  const [seed, fromSeed] = useSeed<FixRequests>(url);
  const [data, setData] = useState<FixRequests | null>(seed?.data ?? null);
  const [error, setError] = useState(seed?.error?.message ?? "");
  useEffect(() => {
    if (fromSeed()) return;
    let active = true;
    request<FixRequests>(url).then(value => { if (active) { setData(value); setError(""); } }, (cause: unknown) => { if (active) setError(failure(cause, "Fix requests could not be loaded.")); });
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
    : !quote.available ? quote.setup
      ? <span className="fix-action"><LinkButton variant="secondary" size="sm" icon={SparkleIcon} href={appHref(aiSetupPath(`${pageLocation().pathname}${pageLocation().search}`, quote.setup.handleRequired))}>Connect AI model</LinkButton><InfoTip label="requesting fixes">{quote.reason}</InfoTip></span>
      : <span className="fix-action"><span className="fix-requests-note">Fix requests aren't available</span><InfoTip label="requesting fixes">{quote.reason}</InfoTip></span>
    : open ? <span className="fix-action"><Button variant="secondary" size="sm" icon={SparkleIcon} loading={busy} onClick={() => void start()}>Request fix</Button><InfoTip label="requesting fixes">{ABOUT} {quote.reason}</InfoTip></span>
    : null;

  if (!data && !error) return null;
  return <section className="fix-requests" aria-label="Agent fixes">
    <div className="fix-requests-head"><RobotIcon size={16} aria-hidden="true" /><strong>Agent fixes</strong>{action}</div>
    {error && <p className="fix-requests-note" role="alert">{error}</p>}
    {message && <p className="fix-requests-note" role="status">{message}</p>}
    {data && data.missions.length > 0 && <ul className="fix-list">{data.missions.map(entry => <li key={entry.id}><span className="fix-title">{entry.title}</span><span className="fix-meta" suppressHydrationWarning>{requester(entry)} · {relativeTime(entry.createdAt)}</span><AgentState state={entry.state} /></li>)}</ul>}
    {dialog}
  </section>;
}

export function AgentMissions({ api, issueLink }: { api: string; issueLink: (number: number) => ReactNode }) {
  const { data, error } = useQuote(api, "", 0);
  if (error) return <section className="repo-panel"><div className="repo-panel-padding"><div className="error-notice" role="alert">{error}</div></div></section>;
  if (!data) return <section className="repo-panel" aria-busy="true"><PageLoading /></section>;
  return <section className="repo-panel">
    <div className="repo-panel-heading"><h2><RobotIcon size={16} aria-hidden="true" />Agent work</h2><InfoTip label="agent work">Changes people asked agents to make. Each one is a proposal that a maintainer reviews before it lands.</InfoTip></div>
    {data.missions.length ? <ul className="fix-list fix-list-page">{data.missions.map(entry => <li key={entry.id}>
      <span className="fix-title">{entry.title}</span>
      <span className="fix-meta" suppressHydrationWarning>{entry.issueNumber ? <>{issueLink(entry.issueNumber)} · </> : null}requested by {requester(entry)} · {relativeTime(entry.createdAt)} · {entry.source === "pool" ? "community pool" : "requester's key"}</span>
      <AgentState state={entry.state} />
    </li>)}</ul> : <p className="repo-panel-padding fix-requests-note">No agent work requested yet.</p>}
  </section>;
}

const CHANGE_BODY = "What should change:\n\n\nHow to tell it works:\n";

export function changeTitle(quote: FixQuote | null): string {
  if (!quote || quote.available) return "Request a change";
  if (!quote.signedIn) return "Sign in to request a change";
  return quote.setup ? "Connect an AI model to request changes" : "Requests aren't available here";
}

export function paidBy(quote: FixQuote): string {
  return quote.source === "pool" ? "this project's AI pool" : `your AI key${quote.model ? ` (${quote.model.label})` : ""}`;
}

export function askMaintainersHref(api: string): string {
  const repository = api.replace(/^\/api\/public\/repos/, "");
  return `${repository}/issues/new?${new URLSearchParams({ body: CHANGE_BODY })}`;
}

function openedFromReturn(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get(REQUEST_CHANGE_PARAM) !== "1") return false;
  params.delete(REQUEST_CHANGE_PARAM);
  const query = params.toString();
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  return true;
}

interface ChangeBodyProps {
  api: string;
  quote: FixQuote | null;
  error: string;
  done: string;
  goal: string;
  busy: boolean;
  first?: Ref<HTMLElement>;
  onGoal: (goal: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export function RequestChangeBody({ api, quote, error, done, goal, busy, first, onGoal, onSubmit, onClose }: ChangeBodyProps) {
  const ask = askMaintainersHref(api);
  if (!quote) return error
    ? <><p className="fix-change-line" role="alert">{error}</p><div className="dialog-actions"><Button ref={first as Ref<HTMLButtonElement>} variant="secondary" size="base" type="button" onClick={onClose}>Close</Button></div></>
    : <div className="fix-change-loading" aria-busy="true"><PageLoading label="Checking who pays" /></div>;
  if (!quote.signedIn) return <>
    <p className="fix-change-line">An agent drafts the change; maintainers review it.</p>
    <div className="dialog-actions"><Button variant="secondary" size="base" type="button" onClick={onClose}>Cancel</Button><LinkButton ref={first as Ref<HTMLAnchorElement>} variant="primary" size="base" href={appHref("/signin")}>Sign in</LinkButton></div>
  </>;
  if (!quote.available) return <>
    <p className="fix-change-line">{quote.reason}{quote.setup && <InfoTip label="connecting an AI model">Your key stays in your personal workspace and pays only for your own requests. Maintainers still review every change.</InfoTip>}</p>
    <div className="dialog-actions">{quote.setup
      ? <><LinkButton variant="secondary" size="base" href={ask}>Ask maintainers instead</LinkButton><LinkButton ref={first as Ref<HTMLAnchorElement>} variant="primary" size="base" href={quote.setup.url}>Connect AI model</LinkButton></>
      : <><Button variant="secondary" size="base" type="button" onClick={onClose}>Close</Button><LinkButton ref={first as Ref<HTMLAnchorElement>} variant="primary" size="base" href={ask}>Ask maintainers instead</LinkButton></>}</div>
  </>;
  return <form onSubmit={event => { event.preventDefault(); onSubmit(); }}>
    <p className="fix-change-line">Paid by {paidBy(quote)}.<InfoTip label="requested changes">{ABOUT} {quote.waitsForMaintainer ? "It starts when a maintainer starts it." : "Agents start right away."}{quote.remainingToday !== null ? ` ${quote.remainingToday} left today.` : ""}</InfoTip></p>
    <div className="form-field fix-change-field"><label htmlFor="fix-goal">What should change?</label><textarea ref={first as Ref<HTMLTextAreaElement>} id="fix-goal" className="fix-goal" rows={5} maxLength={4000} value={goal} disabled={busy} onChange={event => onGoal(event.target.value)} placeholder="Describe the change and how to tell it works." /></div>
    {error && <div className="error-notice" role="alert">{error}</div>}
    {done && <p className="fix-change-line" role="status">{done}</p>}
    <div className="dialog-actions">
      <Button variant="secondary" size="base" type="button" onClick={onClose}>{done ? "Close" : "Cancel"}</Button>
      <Button variant="primary" size="base" type="submit" loading={busy} disabled={goal.trim().length < 10}>Request change</Button>
    </div>
  </form>;
}

export function RequestChange({ api, authenticated, signIn }: { api: string; authenticated: boolean; signIn: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const [quote, setQuote] = useState<FixQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const key = useRef(crypto.randomUUID());
  const first = useRef<HTMLElement>(null);

  useEffect(() => { if (authenticated && openedFromReturn()) setOpen(true); }, [authenticated]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setQuote(null); setError(""); setDone("");
    request<FixRequests>(`${api}/fix-requests?quote=1`).then(value => { if (active) setQuote(value.quote); }, (cause: unknown) => { if (active) setError(failure(cause, "This project could not be checked.")); });
    return () => { active = false; };
  }, [api, open]);

  useEffect(() => {
    if (!open || (!quote && !error)) return;
    const frame = requestAnimationFrame(() => first.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, quote, error]);

  async function submit() {
    if (busy || goal.trim().length < 10) return;
    setBusy(true); setError(""); setDone("");
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
    <Dialog.Root open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <Dialog size="sm" className="dialog-content fix-change-dialog">
        <Dialog.Title className="dialog-title fix-change-title">{changeTitle(quote)}</Dialog.Title>
        <RequestChangeBody api={api} quote={quote} error={error} done={done} goal={goal} busy={busy} first={first} onGoal={setGoal} onSubmit={() => void submit()} onClose={() => setOpen(false)} />
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
