import { useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { ArrowClockwiseIcon, ArrowSquareOutIcon, CaretDownIcon, CaretRightIcon, GitForkIcon, XCircleIcon } from "@phosphor-icons/react";
import type { PullRequestState, UpstreamProposal } from "../shared/types";
import { request } from "./api";
import { relativeTime } from "./components";
import { useConfirm } from "./ConfirmDialog";
import InfoTip from "./InfoTip";
import { reviewKindLabel } from "./review-summary";
import "./pull-requests.css";

const LABELS: Record<PullRequestState, [string, string]> = { open: ["Open", "running"], needs_review: ["Needs review", "review"], approved: ["Approved", "approved"], landed: ["Landed", "integrated"], closed: ["Closed", "cancelled"] };

export function upstreamStateLabel(proposal: Pick<UpstreamProposal, "state" | "waitingForMaintainer">): [string, string] {
  return proposal.waitingForMaintainer ? ["Waiting for a maintainer", "review"] : LABELS[proposal.state];
}

export default function UpstreamProposals({ repositoryId, canContribute }: { repositoryId: string; canContribute: boolean }) {
  const [proposals, setProposals] = useState<UpstreamProposal[] | null>(null);
  const [open, setOpen] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirm, dialog] = useConfirm();
  const base = `/api/repositories/${encodeURIComponent(repositoryId)}/upstream-proposals`;

  useEffect(() => {
    let active = true;
    request<{ proposals: UpstreamProposal[] }>(base).then(result => { if (active) setProposals(result.proposals); }).catch(failure => { if (active) { setProposals([]); setError(failure instanceof Error ? failure.message : "Proposals sent upstream could not be loaded."); } });
    return () => { active = false; };
  }, [base]);

  async function act(proposal: UpstreamProposal, action: "update" | "close" | "reopen") {
    if (busy) return;
    if (action === "close" && !await confirm({ title: "Close this proposal?", description: `${proposal.upstream.label} stops reviewing it. Your stream is kept and you can reopen it.`, confirmLabel: "Close proposal", tone: "danger" })) return;
    setBusy(`${proposal.id}:${action}`); setError("");
    try {
      const updated = await request<UpstreamProposal>(`${base}/${encodeURIComponent(proposal.id)}`, { action });
      setProposals(current => (current ?? []).map(item => item.id === updated.id ? updated : item));
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The proposal could not be changed."); }
    finally { setBusy(""); }
  }

  if (!proposals?.length && !error) return null;
  return <section className="panel upstream-proposals">
    <div className="panel-header"><h2 className="field-label"><GitForkIcon size={15} />Sent upstream<InfoTip label="proposals sent upstream">Proposals from this fork, reviewed by the upstream maintainers. Update one after pushing to its stream.</InfoTip></h2></div>
    {error && <div className="panel-body"><div className="error-notice" role="alert">{error}</div></div>}
    <ul className="upstream-proposal-list">
      {(proposals ?? []).map(proposal => {
        const [label, tone] = upstreamStateLabel(proposal);
        const expanded = open === proposal.id;
        const active = proposal.state !== "landed" && proposal.state !== "closed";
        const requests = proposal.reviews.filter(review => review.kind === "request_changes" && !review.resolved).length;
        return <li key={proposal.id}>
          <div className="upstream-proposal-row">
            <button type="button" className="upstream-proposal-toggle" aria-expanded={expanded} onClick={() => setOpen(expanded ? "" : proposal.id)}>{expanded ? <CaretDownIcon size={13} /> : <CaretRightIcon size={13} />}<strong>{proposal.title}</strong></button>
            <span className={`pill ${tone}`}><span className="pill-dot" />{label}</span>
            <small className="pull-branches"><code>{proposal.branch}</code><span>→ {proposal.upstream.url ? <a href={proposal.upstream.url} target="_blank" rel="noopener noreferrer">{proposal.upstream.label}<ArrowSquareOutIcon size={11} /></a> : proposal.upstream.label}</span><span>{proposal.checks.length ? `${proposal.checks.filter(check => check.status === "passed").length}/${proposal.checks.length} checks passed` : "No checks yet"}</span>{requests > 0 && <span>{requests} change request{requests === 1 ? "" : "s"}</span>}<span>{relativeTime(proposal.updatedAt)}</span></small>
            <div className="upstream-proposal-actions">
              {active && <Button variant="secondary" size="sm" icon={ArrowClockwiseIcon} loading={busy === `${proposal.id}:update`} disabled={!!busy || !canContribute} onClick={() => void act(proposal, "update")}>Update</Button>}
              {active && <Button variant="ghost" size="sm" icon={XCircleIcon} loading={busy === `${proposal.id}:close`} disabled={!!busy || !canContribute} onClick={() => void act(proposal, "close")}>Close</Button>}
              {proposal.state === "closed" && <Button variant="secondary" size="sm" icon={ArrowClockwiseIcon} loading={busy === `${proposal.id}:reopen`} disabled={!!busy || !canContribute} onClick={() => void act(proposal, "reopen")}>Reopen</Button>}
            </div>
          </div>
          {expanded && <div className="upstream-proposal-detail">
            {proposal.description && <p>{proposal.description}</p>}
            {proposal.reviews.length ? <ul className="upstream-proposal-reviews">{proposal.reviews.map((review, index) => <li key={index} className={review.resolved ? "is-resolved" : undefined}><span>{reviewKindLabel(review.kind)}{review.path ? ` · ${review.path}${review.line ? `:${review.line}` : ""}` : ""}</span><p>{review.body}</p></li>)}</ul> : <p className="upstream-proposal-muted">No review comments yet.</p>}
            {proposal.checks.filter(check => check.status === "failed" && check.output).map(check => <details key={check.name}><summary>{check.name}</summary><pre className="code-output">{check.output}</pre></details>)}
          </div>}
        </li>;
      })}
    </ul>
    {dialog}
  </section>;
}
