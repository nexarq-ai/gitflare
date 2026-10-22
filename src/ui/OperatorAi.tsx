import { useEffect, useState } from "react";
import type { OperatorAiStatus } from "../shared/types";
import { request } from "./api";
import { relativeTime } from "./components";
import InfoTip from "./InfoTip";
import { PageLoading } from "./WorkspaceLoader";

export default function OperatorAi() {
  const [data, setData] = useState<OperatorAiStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    request<OperatorAiStatus>("/api/admin/operator-ai").then(value => { if (active) setData(value); }, (failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "Platform-funded AI could not be loaded."); });
    return () => { active = false; };
  }, []);
  return <section className="panel">
    <div className="panel-header"><h2>Platform-funded AI</h2><InfoTip label="platform-funded AI">Workspaces in OPERATOR_MODEL_WORKSPACES, or with a reviewer grant, may have agent triage paid by this installation, up to the daily cap per repository. Fix requests and agent reviews are never platform-funded.</InfoTip></div>
    {error ? <div className="panel-body"><div className="error-notice" role="alert">{error}</div></div> : !data ? <PageLoading /> : <>
      <dl className="general-facts admin-facts">
        <dt>Granted workspaces</dt><dd>{data.workspaces.length ? <span className="admin-scopes">{data.workspaces.map(id => <code key={id}>{id}</code>)}</span> : "None"}</dd>
        <dt>Triage cap</dt><dd>{data.triagePerDay} issues a day per repository</dd>
      </dl>
      {data.recent.length ? <ul className="people-list">{data.recent.map(use => <li key={`${use.repositoryId}-${use.issueNumber}-${use.at}`}><div><strong>Issue #{use.issueNumber}</strong><span className="people-muted"> · {use.model} · {relativeTime(use.at)}</span><br /><code>{use.workspaceId}</code></div></li>)}</ul> : <div className="panel-body"><p className="people-muted">No platform-funded triage yet.</p></div>}
    </>}
  </section>;
}
