import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { ArchiveIcon, ArrowUUpLeftIcon, BellIcon, ChatCircleIcon, CheckCircleIcon, ClockIcon, EnvelopeOpenIcon, EnvelopeSimpleIcon, EyeIcon, PlayIcon, TrayIcon, UserFocusIcon } from "@phosphor-icons/react";
import { INBOX_KINDS, NOTIFICATION_REASONS, REASON_LABELS, type InboxKind, type InboxRow, type InboxView, type NotificationItem, type NotificationList, type NotificationReason } from "../shared/notifications";
import { request } from "./api";
import { EmptyState, ErrorNotice, relativeTime } from "./components";
import { useConfirm } from "./ConfirmDialog";
import InfoTip from "./InfoTip";
import { AGE_OPTIONS, DEFAULT_INBOX_FILTERS, inboxCommand, inboxQuery, KIND_LABELS, moveSelection, notificationLine, notificationsQuery, openTarget, personName, reasonList, rowReference, selectionAfterRemoval, threadFromSearch, threadRoute, withinAge, type InboxFilters, type NotificationFilter } from "./inbox-data";
import type { InboxCounts } from "./inbox-count";
import { navigate } from "./router";
import { RouteProgress } from "./WorkspaceLoader";
import "./inbox.css";

type Props = {
  currentWorkspaceId: string;
  onSwitchWorkspace: (id: string) => Promise<boolean>;
  onCounts: (counts: Partial<InboxCounts>) => void;
};

const KIND_ICONS: Record<InboxKind, typeof EyeIcon> = { review_requested: UserFocusIcon, awaiting_checks: PlayIcon, needs_review: EyeIcon, new_issue: ChatCircleIcon };

function failureText(failure: unknown, fallback: string): string {
  return failure instanceof Error ? failure.message : fallback;
}

export default function Inbox({ currentWorkspaceId, onSwitchWorkspace, onCounts }: Props) {
  const [thread] = useState(() => threadFromSearch(window.location.search));
  const [filters, setFilters] = useState<InboxFilters>(() => thread ? { ...DEFAULT_INBOX_FILTERS, segment: "notifications", filter: "all" } : DEFAULT_INBOX_FILTERS);
  const [work, setWork] = useState<InboxView | null>(null);
  const [notes, setNotes] = useState<NotificationList | null>(null);
  const [repositories, setRepositories] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [selected, setSelected] = useState(-1);
  const [resolving, setResolving] = useState(!!thread);
  const [confirm, confirmDialog] = useConfirm();
  const generation = useRef(0);
  const unfilteredWork = !filters.archived && !filters.kind && !filters.repository && !filters.age;

  const remember = useCallback((entries: [string, string][]) => {
    setRepositories(current => entries.every(([id]) => current.has(id)) ? current : new Map([...current, ...entries]));
  }, []);

  const acceptWork = useCallback((view: InboxView, append = false) => {
    setWork(current => append && current ? { ...view, rows: [...current.rows, ...view.rows] } : view);
    remember(view.repositories.map(item => [item.id, item.name]));
    if (unfilteredWork) onCounts({ work: view.total });
  }, [remember, onCounts, unfilteredWork]);

  const acceptNotes = useCallback((list: NotificationList, append = false) => {
    setNotes(current => append && current ? { ...list, items: [...current.items, ...list.items] } : list);
    remember(list.items.map(item => [item.subject.repositoryId, item.subject.repositoryName]));
    onCounts({ unread: list.unread });
  }, [remember, onCounts]);

  const load = useCallback(async (offset = 0) => {
    const current = ++generation.current;
    setError("");
    try {
      if (filters.segment === "work") {
        const view = await request<InboxView>(`/api/inbox?${inboxQuery(filters, offset)}`);
        if (current === generation.current) acceptWork(view, offset > 0);
      } else {
        const list = await request<NotificationList>(`/api/notifications?${notificationsQuery(filters, offset)}`);
        if (current === generation.current) acceptNotes(list, offset > 0);
      }
    } catch (failure) {
      if (current === generation.current) setError(failureText(failure, "The inbox could not be loaded."));
    }
  }, [filters, acceptWork, acceptNotes]);

  useEffect(() => {
    if (resolving) return;
    if (filters.segment === "work") setWork(null); else setNotes(null);
    setSelected(-1);
    void load();
  }, [load, resolving]);

  const items = filters.segment === "work" ? work?.rows ?? null : notes?.items.filter(item => withinAge(item.updatedAt, filters.age)) ?? null;

  useEffect(() => {
    if (selected >= 0) document.getElementById(`inbox-row-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  async function openNotification(item: NotificationItem): Promise<boolean> {
    if (busy) return false;
    setBusy(`open:${item.id}`);
    if (!item.readAt) await request("/api/notifications", { action: "read", ids: [item.id], filter: filters.filter }).then(result => onCounts({ unread: (result as NotificationList).unread }), () => {});
    const target = openTarget(item, currentWorkspaceId);
    if (target.switchTo && !await onSwitchWorkspace(target.switchTo)) { setBusy(""); return false; }
    setBusy("");
    navigate(target.route);
    return true;
  }

  useEffect(() => {
    if (!thread) return;
    let active = true;
    request<NotificationList>(`/api/notifications?${new URLSearchParams({ filter: "all", limit: "1", thread })}`).then(list => {
      if (!active) return;
      const item = list.items.find(entry => entry.id === thread);
      const stay = () => { window.history.replaceState(null, "", "/inbox"); setResolving(false); };
      if (item) { void openNotification(item).then(opened => { if (!opened && active) stay(); }); return; }
      const route = threadRoute(thread);
      if (route) navigate(route); else stay();
    }, () => { if (active) { window.history.replaceState(null, "", "/inbox"); setResolving(false); } });
    return () => { active = false; };
  }, []);

  async function mutateWork(row: InboxRow) {
    if (busy) return;
    setBusy(`archive:${row.id}`); setError("");
    try {
      const index = work?.rows.indexOf(row) ?? -1;
      const view = await request<InboxView>(`/api/inbox?${inboxQuery(filters)}`, { action: filters.archived ? "unarchive" : "archive", ids: [row.id] });
      acceptWork(view);
      setSelected(selectionAfterRemoval(index, view.rows.length));
    } catch (failure) { setError(failureText(failure, "The item could not be archived.")); }
    finally { setBusy(""); }
  }

  async function runChecks(row: InboxRow) {
    if (busy || !row.missionId) return;
    const confirmed = await confirm({ title: "Run checks on this proposal?", description: "Runs this repository's checks on the proposal's current head, without secrets, databases or Cloudflare bindings.", confirmLabel: "Run checks", facts: [{ label: "Proposal", value: row.title }, { label: "Repository", value: row.repositoryName }] });
    if (!confirmed) return;
    setBusy(`checks:${row.id}`); setError("");
    try { await request(`/api/missions/${encodeURIComponent(row.missionId)}/run-checks`, {}); await load(); }
    catch (failure) { setError(failureText(failure, "Checks could not be started.")); }
    finally { setBusy(""); }
  }

  async function markNotifications(action: "read" | "unread" | "archive" | "unarchive" | "read-all", item?: NotificationItem) {
    if (busy) return;
    setBusy(`${action}:${item?.id ?? "all"}`); setError("");
    try {
      const index = item && notes ? notes.items.indexOf(item) : -1;
      const result = await request<NotificationList & { changed: number }>(`/api/notifications?${notificationsQuery(filters)}`, { action, ids: item ? [item.id] : [], filter: filters.filter });
      acceptNotes(result);
      if (index >= 0) setSelected(selectionAfterRemoval(index, result.items.length));
    } catch (failure) { setError(failureText(failure, "The notification could not be updated.")); }
    finally { setBusy(""); }
  }

  const commands = useRef<(command: ReturnType<typeof inboxCommand>) => void>(() => {});
  commands.current = (command) => {
    if (!items || !command) return;
    const current = items[selected] as InboxRow | NotificationItem | undefined;
    if (command === "next" || command === "previous") { setSelected(moveSelection(selected, items.length, command === "next" ? 1 : -1)); return; }
    if (command === "read-all") { if (filters.segment === "notifications" && notes?.unread) void markNotifications("read-all"); return; }
    if (!current) return;
    if (filters.segment === "work") {
      const row = current as InboxRow;
      if (command === "open") navigate(row.route);
      else if (command === "archive") void mutateWork(row);
      return;
    }
    const item = current as NotificationItem;
    if (command === "open") void openNotification(item);
    else if (command === "archive") void markNotifications(item.archivedAt ? "unarchive" : "archive", item);
    else if (command === "toggle-read") void markNotifications(item.readAt ? "unread" : "read", item);
  };

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const command = inboxCommand(event);
      if (!command) return;
      event.preventDefault();
      commands.current(command);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  function change(patch: Partial<InboxFilters>) { setFilters(current => ({ ...current, ...patch })); }

  if (resolving) return <RouteProgress />;
  const segmentFilter = filters.segment === "work" ? (filters.archived ? "archived" : "open") : filters.filter;
  const filtered = filters.segment === "work" ? !!(filters.kind || filters.repository || filters.age) : !!(filters.reason || filters.repository || filters.age);
  return (
    <div className="inbox">
      <div className="page-heading inbox-heading">
        <h1>Inbox</h1>
        <InfoTip label="keyboard shortcuts">
          <span className="inbox-keys">
            <span><kbd>j</kbd><kbd>k</kbd>Move</span>
            <span><kbd>o</kbd><kbd>Enter</kbd>Open</span>
            <span><kbd>e</kbd>Archive</span>
            <span><kbd>u</kbd>Read or unread</span>
            <span><kbd>Shift</kbd><kbd>I</kbd>Mark all read</span>
            <span><kbd>g</kbd><kbd>i</kbd>Inbox from anywhere</span>
          </span>
        </InfoTip>
      </div>
      <div className="page-tabs">
        <Tabs variant="underline" value={filters.segment} onValueChange={(value) => change({ segment: value as InboxFilters["segment"], repository: "" })} tabs={[
          { value: "work", label: `Work${work && unfilteredWork ? ` (${work.total})` : ""}` },
          { value: "notifications", label: `Notifications${notes?.unread ? ` (${notes.unread})` : ""}` },
        ]} />
      </div>
      <div className="repository-work-toolbar inbox-toolbar">
        <div className="issue-state-toggle" role="group" aria-label={filters.segment === "work" ? "Work state" : "Notification state"}>
          {(filters.segment === "work" ? [["open", "Open"], ["archived", `Archived${work?.archived ? ` (${work.archived})` : ""}`]] : [["unread", "Unread"], ["all", "All"], ["archived", "Archived"]]).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={segmentFilter === value} onClick={() => change(filters.segment === "work" ? { archived: value === "archived" } : { filter: value as NotificationFilter })}>{label}</button>
          ))}
        </div>
        <select aria-label="Repository" value={filters.repository} onChange={(event) => change({ repository: event.target.value })}>
          <option value="">All repositories</option>
          {[...repositories].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        {filters.segment === "work"
          ? <select aria-label="Kind" value={filters.kind} onChange={(event) => change({ kind: event.target.value as InboxFilters["kind"] })}><option value="">Everything</option>{INBOX_KINDS.map(kind => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}</select>
          : <select aria-label="Reason" value={filters.reason} onChange={(event) => change({ reason: event.target.value as NotificationReason | "" })}><option value="">All reasons</option>{NOTIFICATION_REASONS.map(reason => <option key={reason} value={reason}>{REASON_LABELS[reason]}</option>)}</select>}
        <select aria-label="Age" value={filters.age} onChange={(event) => change({ age: event.target.value })}>
          {AGE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        {filters.segment === "notifications" && filters.filter !== "archived" && !!notes?.unread && <Button variant="ghost" size="sm" icon={CheckCircleIcon} loading={busy === "read-all:all"} disabled={!!busy} onClick={() => void markNotifications("read-all")}>Mark all read</Button>}
      </div>
      {error && <ErrorNotice message={error} onRetry={() => void load()} />}
      {!items ? !error && <RouteProgress /> : (
        <section className="panel inbox-panel">
          {!items.length ? (
            filters.segment === "work"
              ? <EmptyState icon={<TrayIcon size={25} />} title={filtered ? "Nothing matches" : filters.archived ? "Nothing archived" : "Nothing waiting on you"} description={filtered ? "Try other filters." : "Reviews, checks and new issues show up here."} />
              : <EmptyState icon={<BellIcon size={25} />} title={filtered ? "Nothing matches" : filters.filter === "unread" ? "All caught up" : filters.filter === "archived" ? "Nothing archived" : "No notifications"} description={filtered ? "Try other filters." : "Mentions, reviews and updates on threads you follow land here."} />
          ) : (
            <ul className="inbox-list">
              {filters.segment === "work"
                ? (items as InboxRow[]).map((row, index) => <WorkRow key={row.id} row={row} index={index} selected={index === selected} archived={filters.archived} busy={busy} onSelect={() => setSelected(index)} onRunChecks={() => void runChecks(row)} onArchive={() => void mutateWork(row)} />)
                : (items as NotificationItem[]).map((item, index) => <NotificationRow key={item.id} item={item} index={index} selected={index === selected} busy={busy} onSelect={() => setSelected(index)} onOpen={() => void openNotification(item)} onToggleRead={() => void markNotifications(item.readAt ? "unread" : "read", item)} onArchive={() => void markNotifications(item.archivedAt ? "unarchive" : "archive", item)} />)}
            </ul>
          )}
          {(filters.segment === "work" ? work?.nextOffset : notes?.nextOffset) != null && <div className="issue-more"><Button variant="secondary" onClick={() => void load((filters.segment === "work" ? work?.nextOffset : notes?.nextOffset) ?? 0)}>Show more</Button></div>}
        </section>
      )}
      {confirmDialog}
    </div>
  );
}

function WorkRow({ row, index, selected, archived, busy, onSelect, onRunChecks, onArchive }: { row: InboxRow; index: number; selected: boolean; archived: boolean; busy: string; onSelect: () => void; onRunChecks: () => void; onArchive: () => void }) {
  const Icon = KIND_ICONS[row.kind];
  const reference = rowReference(row);
  return (
    <li id={`inbox-row-${index}`} className={`inbox-row${selected ? " is-selected" : ""}`} aria-current={selected ? "true" : undefined} onClick={onSelect}>
      <span className={`inbox-icon is-${row.kind}`}><Icon size={16} aria-hidden="true" /></span>
      <div className="inbox-row-main">
        <a className="inbox-row-title" href={`/${row.route}`}>{row.title}{reference && <span> {reference}</span>}</a>
        <small>
          <span className={`inbox-kind is-${row.kind}`}>{KIND_LABELS[row.kind]}</span>
          <span>{row.repositoryName}</span>
          {row.author !== undefined && <span>{personName(row.author)}</span>}
          {row.outside && <span className="inbox-tag">Fork</span>}
          <span><ClockIcon size={11} aria-hidden="true" />{relativeTime(row.updatedAt)}</span>
        </small>
        {row.owners?.length ? <span className="inbox-owners">{row.owners.map(handle => <code key={handle}>@{handle}</code>)}</span> : null}
      </div>
      <div className="inbox-row-actions">
        {row.actions.includes("run_checks") && !archived && <Button variant="secondary" size="sm" icon={PlayIcon} loading={busy === `checks:${row.id}`} disabled={!!busy} onClick={onRunChecks}>Run checks</Button>}
        <Button variant="ghost" size="sm" shape="square" icon={archived ? ArrowUUpLeftIcon : ArchiveIcon} aria-label={archived ? `Move ${row.title} back` : `Archive ${row.title}`} title={archived ? "Move back" : "Archive"} loading={busy === `archive:${row.id}`} disabled={!!busy} onClick={onArchive} />
      </div>
    </li>
  );
}

function NotificationRow({ item, index, selected, busy, onSelect, onOpen, onToggleRead, onArchive }: { item: NotificationItem; index: number; selected: boolean; busy: string; onSelect: () => void; onOpen: () => void; onToggleRead: () => void; onArchive: () => void }) {
  const unread = !item.readAt;
  const reference = item.subject.number ? ` #${item.subject.number}` : "";
  return (
    <li id={`inbox-row-${index}`} className={`inbox-row${selected ? " is-selected" : ""}${unread ? " is-unread" : ""}`} aria-current={selected ? "true" : undefined} onClick={onSelect}>
      <span className="inbox-dot" aria-label={unread ? "Unread" : undefined} />
      <div className="inbox-row-main">
        <a className="inbox-row-title" href={`/${item.route}`} onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); event.stopPropagation(); onOpen(); }}>{item.subject.title}{reference && <span>{reference}</span>}</a>
        <small>
          <span className="inbox-kind">{reasonList(item.reasons)}</span>
          <span>{item.subject.repositoryName}</span>
          <span>{notificationLine(item)}</span>
          <span><ClockIcon size={11} aria-hidden="true" />{relativeTime(item.updatedAt)}</span>
        </small>
        {item.excerpt && <p className="inbox-excerpt">{item.excerpt}</p>}
      </div>
      <div className="inbox-row-actions">
        {!item.archivedAt && <Button variant="ghost" size="sm" shape="square" icon={unread ? EnvelopeOpenIcon : EnvelopeSimpleIcon} aria-label={unread ? "Mark as read" : "Mark as unread"} title={unread ? "Mark as read" : "Mark as unread"} loading={busy === `${unread ? "read" : "unread"}:${item.id}`} disabled={!!busy} onClick={onToggleRead} />}
        <Button variant="ghost" size="sm" shape="square" icon={item.archivedAt ? ArrowUUpLeftIcon : ArchiveIcon} aria-label={item.archivedAt ? "Move back to inbox" : "Archive"} title={item.archivedAt ? "Move back" : "Archive"} loading={busy === `${item.archivedAt ? "unarchive" : "archive"}:${item.id}`} disabled={!!busy} onClick={onArchive} />
      </div>
    </li>
  );
}
