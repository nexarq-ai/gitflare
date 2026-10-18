import { useState } from "react";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react";
import type { AccessSnapshot, Repository } from "../shared/types";
import { EmptyState } from "./components";
import { auditSentence, isRequestRecord, personName, visibleAudit } from "./people-data";
import "./people-settings.css";

export default function AuditLog({ data, repositories, workspaceName }: { data: AccessSnapshot; repositories: Repository[]; workspaceName: string }) {
  const owner = data.role === "Owner";
  const names = (userId: string) => personName(data, userId);
  const [requests, setRequests] = useState(false);
  const entries = visibleAudit(data.audit, requests);
  return <>
    <div className="page-heading"><div><h1>Audit log</h1><p>Changes to people, access and settings in {workspaceName}.</p></div></div>
    <section className="panel">
      {!owner ? <EmptyState icon={<ClockCounterClockwiseIcon size={25} />} title="Only Owners can read the audit log." description="Ask an Owner of this workspace if you need to know who changed something." />
        : !entries.length && !data.audit.some(isRequestRecord) ? <EmptyState icon={<ClockCounterClockwiseIcon size={25} />} title="Nothing recorded yet." description="Invitations, role changes and settings changes appear here as they happen." />
        : <>
          {data.audit.some(isRequestRecord) && <div className="panel-header audit-filter"><label className="people-check"><input type="checkbox" checked={requests} onChange={event => setRequests(event.target.checked)} />Include every allowed request</label></div>}
          {!entries.length && <p className="people-muted audit-footnote">No access or settings changes among the latest entries.</p>}
          <ol className="audit-list">{entries.map(entry => <li key={entry.id}>
            <span className="audit-sentence">{auditSentence(entry, names, repositories)}</span>
            <time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>
          </li>)}</ol>
          {data.audit.length >= 100 && <p className="people-muted audit-footnote">Showing the latest 100 entries.</p>}
        </>}
    </section>
  </>;
}
