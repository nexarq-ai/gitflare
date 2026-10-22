import { useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import type { ContentReport, IssuePerson } from "../shared/types";
import { publicRepositoryPath } from "../shared/handles";
import { request } from "./api";
import { relativeTime } from "./components";
import { useConfirm } from "./ConfirmDialog";
import { siteHref } from "./hosts";
import InfoTip from "./InfoTip";
import { personLabel } from "./IssueLabels";
import { PageLoading } from "./WorkspaceLoader";

type Reports = { reports: ContentReport[]; people: Record<string, IssuePerson> };

function reportLink(report: ContentReport): string {
  const [handle, repository] = report.address.split("/");
  return `${publicRepositoryPath(handle ?? "", repository ?? "")}/issues/${report.issueNumber}`;
}

export default function ContentReports() {
  const [data, setData] = useState<Reports | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [confirm, confirmDialog] = useConfirm();
  useEffect(() => {
    let active = true;
    request<Reports>("/api/admin/reports").then(value => { if (active) setData(value); }, (failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "Reports could not be loaded."); });
    return () => { active = false; };
  }, []);
  async function dismiss(report: ContentReport) {
    if (!await confirm({ title: "Dismiss this report?", description: "It leaves the list. Act on the content first if it needs action.", confirmLabel: "Dismiss" })) return;
    setBusy(report.id); setError("");
    try { setData(await request<Reports>(`/api/admin/reports/${report.id}/dismiss`, {})); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The report could not be dismissed."); }
    finally { setBusy(""); }
  }
  return <section className="panel">
    <div className="panel-header"><h2>Content reports</h2>{data && <span className="number-tag">{data.reports.length}</span>}<InfoTip label="content reports">People report public issues and comments here. Report text is written by them, not by Gitflare.</InfoTip></div>
    {error && <div className="panel-body"><div className="error-notice" role="alert">{error}</div></div>}
    {!data ? !error && <PageLoading label="Loading reports" />
      : data.reports.length ? <ul className="people-list">{data.reports.map(report => <li key={report.id}>
        <div><strong><a href={siteHref(reportLink(report))} target="_blank" rel="noopener noreferrer">{report.address} #{report.issueNumber}{report.commentId ? " · comment" : ""}</a></strong><span className="people-muted">{report.reason} · {personLabel(report.reporterId, data.people)} · {relativeTime(report.createdAt)}{report.detail ? ` · ${report.detail}` : ""}</span></div>
        <Button variant="secondary" size="sm" loading={busy === report.id} disabled={!!busy} onClick={() => void dismiss(report)}>Dismiss</Button>
      </li>)}</ul>
      : <div className="panel-body"><p className="people-muted">No open reports.</p></div>}
    {confirmDialog}
  </section>;
}
