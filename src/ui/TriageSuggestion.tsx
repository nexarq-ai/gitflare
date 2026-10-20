import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { RobotIcon } from "@phosphor-icons/react";
import type { AgentAssistSettings, IssueDetail, TriageSuggestion } from "../shared/types";
import { request } from "./api";
import InfoTip from "./InfoTip";
import "./fix-requests.css";

type Reply = { suggestion: TriageSuggestion | null; assist?: AgentAssistSettings; issue?: IssueDetail };

export default function TriageSuggestionPanel({ repositoryId, number, onAccepted }: { repositoryId: string; number: number; onAccepted: (issue: IssueDetail) => void }) {
  const [reply, setReply] = useState<Reply | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const key = useRef(crypto.randomUUID());
  const path = `/api/repositories/${encodeURIComponent(repositoryId)}/issue-triage/${number}`;

  useEffect(() => {
    let active = true;
    request<Reply>(path).then(value => { if (active) setReply(value); }, () => { if (active) setReply(null); });
    return () => { active = false; };
  }, [path]);

  async function act(action: "run" | "accept" | "dismiss") {
    setBusy(action); setError("");
    try {
      const next = await request<Reply>(path, { action }, key.current);
      setReply(current => ({ ...current, ...next }));
      if (next.issue) onAccepted(next.issue);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Triage failed."); }
    finally { key.current = crypto.randomUUID(); setBusy(""); }
  }

  if (!reply || (!reply.suggestion && !reply.assist?.triage)) return null;
  const suggestion = reply.suggestion;
  return <section className="triage-suggestion" aria-label="Triage suggestion">
    <strong><RobotIcon size={14} aria-hidden="true" /> Triage suggestion <InfoTip label="triage suggestions">Written by an agent from the issue text, which anyone can write. Accepting applies the labels and posts the checklist as a Gitflare comment.</InfoTip></strong>
    {error && <div className="error-notice" role="alert">{error}</div>}
    {suggestion ? <>
      {suggestion.summary && <p className="issue-muted">{suggestion.summary}</p>}
      {suggestion.labels.length > 0 && <p className="issue-muted">Labels: {suggestion.labels.join(", ")}</p>}
      {suggestion.duplicates.length > 0 && <p className="issue-muted">Possible duplicates: {suggestion.duplicates.map(value => `#${value}`).join(", ")}</p>}
      {suggestion.checklist.length > 0 && <ul>{suggestion.checklist.map(item => <li key={item}>{item}</li>)}</ul>}
      <div className="triage-suggestion-actions">
        <Button variant="primary" size="sm" loading={busy === "accept"} disabled={!!busy} onClick={() => void act("accept")}>Accept</Button>
        <Button variant="secondary" size="sm" loading={busy === "dismiss"} disabled={!!busy} onClick={() => void act("dismiss")}>Dismiss</Button>
      </div>
    </> : <div className="triage-suggestion-actions"><Button variant="secondary" size="sm" loading={busy === "run"} disabled={!!busy} onClick={() => void act("run")}>Suggest triage</Button></div>}
  </section>;
}
