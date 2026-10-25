import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { ArrowSquareOutIcon, CheckCircleIcon, EyeIcon, StopIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { AgentRun, Check, Mission } from "../shared/types";
import { previewProgressLine, resumePreview, type PreviewProgress, type PreviewStatusLike } from "../shared/preview-progress";
import { request, RequestError } from "./api";
import { Status } from "./components";
import InfoTip from "./InfoTip";
import VisualEvidencePanel, { evidenceFor } from "./VisualEvidence";
import { remaining } from "./PreviewPanel";
import "./race-compare.css";

export type RaceCandidate = {
  run: AgentRun;
  check?: Check;
  files: number;
  additions: number;
  deletions: number;
  eligible: boolean;
};

export type CandidatePreview =
  | { status: "none" }
  | { status: "starting"; progress: PreviewProgress }
  | { status: "ready"; url: string; kind: "worker" | "container"; access: "link" | "cloudflare-access" | "members"; expiresAt?: string }
  | { status: "failed"; error: string };

export type PreviewReply = PreviewStatusLike & {
  runId?: string;
  code?: string;
  last?: unknown;
  kind?: "worker" | "container";
  access?: "link" | "cloudflare-access" | "members";
  previewUrl?: string;
  deploymentUrl?: string | null;
  worker?: { previewUrl: string | null; deploymentUrl: string | null };
  expiresAt?: string;
};

type MissionPreviews = PreviewReply & { candidates?: PreviewReply[]; slots?: { limit: number; missions: string[] } };
export type SlotHolder = { id: string; title: string };
export type SlotNotice = { limit: number; holders: SlotHolder[] };

const NEW_TAB_NOTE: Record<"link" | "cloudflare-access" | "members", string> = {
  link: "This preview opens in a new tab.",
  "cloudflare-access": "Cloudflare Access previews open in a new tab.",
  members: "Members-only previews open in a new tab.",
};
const SUMMARY_LINES = 3;
const POLL_MS = 3000;
const SLOT_LIMIT = "WORKSPACE_PREVIEW_LIMIT";

export function summaryPreview(summary: string): { head: string; more: boolean } {
  const lines = summary.trim().split("\n");
  const head = lines.slice(0, SUMMARY_LINES).join("\n");
  return head.length > 320 ? { head: `${head.slice(0, 317)}…`, more: true } : { head, more: lines.length > SUMMARY_LINES };
}

export function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function previewAt(url: string, path: string): string {
  const base = new URL(url);
  const target = new URL(normalizePath(path), base);
  return target.origin === base.origin ? target.href : base.href;
}

export function embeddable(preview: CandidatePreview): boolean {
  if (preview.status !== "ready" || preview.kind !== "worker" || preview.access !== "link") return false;
  const url = new URL(preview.url);
  return url.protocol === "https:" && url.hostname.endsWith(".workers.dev");
}

export function candidatePreview(reply: PreviewReply): CandidatePreview | null {
  const resumed = resumePreview(reply);
  if (resumed.kind === "preparing") return { status: "starting", progress: resumed.progress };
  if (resumed.kind === "failed") return { status: "failed", error: resumed.error };
  if (resumed.kind === "none") return { status: "none" };
  const url = reply.previewUrl ?? reply.worker?.previewUrl ?? reply.worker?.deploymentUrl ?? reply.deploymentUrl ?? null;
  if (!url || new URL(url).protocol !== "https:") return null;
  const kind = reply.kind ?? (reply.worker ? "worker" : "container");
  return { status: "ready", url, kind, access: reply.access ?? (kind === "worker" ? "link" : "members"), ...(reply.expiresAt ? { expiresAt: reply.expiresAt } : {}) };
}

export function shouldAutoStart(status: Mission["status"], eligible: number, replies: PreviewReply[]): boolean {
  return status === "needs_review" && eligible > 1 && replies.length === eligible && replies.every((reply) => reply.status === "none" && !reply.last);
}

function modelName(run: AgentRun): string | null {
  return run.modelConfig?.label ?? run.model ?? null;
}

function host(url: string): string {
  return new URL(url).host;
}

type ViewProps = {
  mission: Pick<Mission, "status" | "selectedRunId"> & Partial<Pick<Mission, "id" | "visual" | "runs" | "raceChecks" | "checks">>;
  candidates: RaceCandidate[];
  previews: Record<string, CandidatePreview>;
  errors: Record<string, string>;
  pending: Record<string, string>;
  path: string;
  draftPath: string;
  canSelect: boolean;
  canStop: boolean;
  busy: string;
  now: number;
  allBusy: boolean;
  slotNotice?: SlotNotice | null;
  freeing?: string;
  onDraftPath: (value: string) => void;
  onApplyPath: () => void;
  onPreviewAll: () => void;
  onPreview: (runId: string) => void;
  onStop: (runId: string) => void;
  onFreeSlot: (missionId: string) => void;
  onSelect: (runId: string) => void;
};

function PreviewArea({ candidate, preview, error, pending, path, canStop, now, onPreview, onStop }: { candidate: RaceCandidate; preview: CandidatePreview; error?: string; pending?: string; path: string; canStop: boolean; now: number; onPreview: () => void; onStop: () => void }) {
  if (!candidate.eligible) return <div className="race-compare-preview empty"><span>No preview: this candidate did not pass its checks.</span></div>;
  const stop = canStop && <Button variant="ghost" size="sm" icon={StopIcon} loading={pending === "stop"} disabled={!!pending} onClick={onStop}>Stop</Button>;
  if (preview.status === "ready") {
    const href = preview.kind === "worker" ? previewAt(preview.url, path) : preview.url;
    return <div className="race-compare-preview ready">
      <div className="race-compare-preview-head">
        <a href={href} target="_blank" rel="noreferrer" className="race-compare-host">{host(preview.url)}</a>
        {preview.expiresAt && <span className="race-compare-left">{remaining(preview.expiresAt, now)} left</span>}
      </div>
      {embeddable(preview)
        ? <iframe className="race-compare-frame" src={href} title={`Preview of ${candidate.run.name}`} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-pointer-lock" allow="fullscreen" loading="lazy" referrerPolicy="no-referrer" />
        : <p className="race-compare-note">{NEW_TAB_NOTE[preview.access]}<InfoTip label="Why a new tab">Only public Worker Previews on workers.dev show inside this page. Sign-in sessions of members-only and Cloudflare Access previews do not work inside another site’s frame.</InfoTip></p>}
      <div className="race-compare-actions">
        <LinkButton variant="secondary" size="sm" href={href} external icon={ArrowSquareOutIcon}>Open preview</LinkButton>
        {stop}
      </div>
    </div>;
  }
  if (preview.status === "starting") return <div className="race-compare-preview starting" role="status">
    <span>{previewProgressLine(preview.progress, now)}</span>
    {stop}
  </div>;
  return <div className="race-compare-preview empty">
    {preview.status === "failed" && <p className="race-compare-error">{preview.error.split("\n")[0]}</p>}
    {error && <p className="race-compare-error" role="alert">{error}</p>}
    <Button variant="secondary" size="sm" icon={EyeIcon} loading={pending === "start"} disabled={!!pending} onClick={onPreview}>{preview.status === "failed" ? "Try again" : "Preview"}</Button>
  </div>;
}

export function RaceCompareView({ mission, candidates, previews, errors, pending, path, draftPath, canSelect, canStop, busy, now, allBusy, slotNotice, freeing, onDraftPath, onApplyPath, onPreviewAll, onPreview, onStop, onFreeSlot, onSelect }: ViewProps) {
  const choosing = mission.status === "needs_review";
  const eligible = candidates.filter((candidate) => candidate.eligible);
  const missing = eligible.filter((candidate) => !["ready", "starting"].includes(previews[candidate.run.id]?.status ?? "none"));
  const submit = (event: FormEvent) => { event.preventDefault(); onApplyPath(); };
  return <section className="race-compare" aria-label="Race candidates">
    <header className="race-compare-head">
      <div>
        <h2>Compare candidates</h2>
        <p>
          {choosing && !mission.selectedRunId ? "Each candidate gets its own live preview. Try them side by side, then choose one." : "Each agent’s candidate, side by side."}
          <InfoTip label="Comparing candidates">Every passing candidate runs at its own preview URL at the same time. All previews of this mission share one of the workspace’s preview slots until you stop them or they expire. Only the chosen candidate can be approved and landed; you can change your choice until approval.</InfoTip>
        </p>
      </div>
      <div className="race-compare-tools">
        {eligible.length > 1 && <Button variant="primary" size="sm" icon={EyeIcon} loading={allBusy} disabled={allBusy || missing.length === 0} onClick={onPreviewAll}>{missing.length === 0 ? "All previews running" : `Preview all ${eligible.length}`}</Button>}
        <form className="race-compare-path" onSubmit={submit}>
          <label htmlFor="race-compare-path">Same path</label>
          <input id="race-compare-path" value={draftPath} placeholder="/" spellCheck={false} autoComplete="off" onChange={(event) => onDraftPath(event.target.value)} />
          <Button type="submit" variant="secondary" size="sm">Show</Button>
          <InfoTip label="Same path">Shows this route, for example /play, in every embedded preview and in Open preview.</InfoTip>
        </form>
      </div>
    </header>
    {slotNotice && <div className="alert error race-compare-slots" role="alert">
      <WarningCircleIcon size={17} />
      <div className="alert-text">
        Other missions are using all {slotNotice.limit} preview slots of this workspace, so these candidates can’t start yet.
        {slotNotice.holders.length > 0 && <div className="race-compare-actions">
          {slotNotice.holders.map((holder) => <Button key={holder.id} variant="secondary" size="sm" icon={StopIcon} loading={freeing === holder.id} disabled={!!freeing} onClick={() => onFreeSlot(holder.id)}>Stop previews of {holder.title}</Button>)}
        </div>}
      </div>
    </div>}
    <div className="race-compare-grid">
      {candidates.map((candidate) => {
        const { run } = candidate;
        const chosen = run.id === mission.selectedRunId;
        const summary = run.summary ? summaryPreview(run.summary) : null;
        const model = modelName(run);
        return <article key={run.id} className={`race-compare-card${chosen ? " chosen" : ""}`} aria-label={`Candidate ${run.name}`}>
          <h3>
            <span className="race-compare-name">{run.name}</span>
            {chosen ? <span className="race-compare-chosen"><CheckCircleIcon size={14} weight="fill" aria-hidden="true" />Chosen</span> : <Status status={candidate.check?.status ?? run.status} />}
          </h3>
          <dl className="race-compare-facts">
            {model && <div><dt>Model</dt><dd>{model}</dd></div>}
            <div><dt>Revision</dt><dd>{run.commitSha ? <code title={run.commitSha}>{run.commitSha.slice(0, 7)}</code> : "None"}</dd></div>
            <div><dt>Files</dt><dd>{candidate.files} <span className="race-compare-add">+{candidate.additions}</span> <span className="race-compare-del">−{candidate.deletions}</span></dd></div>
            <div><dt>Checks</dt><dd>{candidate.check ? `${candidate.check.status}${candidate.check.durationMs !== undefined ? ` · ${Math.round(candidate.check.durationMs / 100) / 10}s` : ""}` : "Not run"}</dd></div>
          </dl>
          {summary && (summary.more
            ? <details className="race-compare-summary"><summary>{summary.head}</summary><p>{run.summary}</p></details>
            : <p className="race-compare-summary">{summary.head}</p>)}
          {run.error && <p className="race-compare-error">{run.error}</p>}
          <PreviewArea candidate={candidate} preview={previews[run.id] ?? { status: "none" }} error={errors[run.id]} pending={pending[run.id]} path={path} canStop={canStop} now={now} onPreview={() => onPreview(run.id)} onStop={() => onStop(run.id)} />
          {mission.id && evidenceFor(mission.visual, run.id, true).length > 0 && <VisualEvidencePanel missionId={mission.id} evidence={evidenceFor(mission.visual, run.id, true)} runs={mission.runs ?? []} checks={mission.raceChecks ?? mission.checks ?? []} compact />}
          {candidate.eligible && choosing && <Button
            variant={chosen ? "secondary" : "primary"}
            size="sm"
            loading={busy === "select"}
            disabled={!!busy || !canSelect || chosen}
            title={canSelect ? undefined : "Choosing a candidate needs review permission."}
            onClick={() => onSelect(run.id)}
          >
            {chosen ? "Chosen for review" : "Choose this one"}
          </Button>}
        </article>;
      })}
    </div>
  </section>;
}

type Props = {
  missionId: string;
  mission: Pick<Mission, "status" | "selectedRunId" | "epoch"> & Partial<Pick<Mission, "id" | "visual" | "runs" | "raceChecks" | "checks">>;
  candidates: RaceCandidate[];
  canSelect: boolean;
  canStop: boolean;
  busy: string;
  missionTitle: (id: string) => string | undefined;
  autoStart: boolean;
  onSelect: (runId: string) => void;
};

function autoStartKey(missionId: string, epoch: number): string {
  return `gitflare:race-previews:${missionId}:${epoch}`;
}

function claimAutoStart(missionId: string, epoch: number): boolean {
  try {
    if (window.localStorage.getItem(autoStartKey(missionId, epoch))) return false;
    window.localStorage.setItem(autoStartKey(missionId, epoch), "1");
    return true;
  } catch {
    return false;
  }
}

export default function RaceCompare({ missionId, mission, candidates, canSelect, canStop, busy, missionTitle, autoStart, onSelect }: Props) {
  const [previews, setPreviews] = useState<Record<string, CandidatePreview>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, string>>({});
  const [draftPath, setDraftPath] = useState("/");
  const [path, setPath] = useState("/");
  const [now, setNow] = useState(Date.now());
  const [allBusy, setAllBusy] = useState(false);
  const [slots, setSlots] = useState<{ limit: number; missions: string[] } | null>(null);
  const [slotBlocked, setSlotBlocked] = useState(false);
  const [freeing, setFreeing] = useState("");
  const keys = useRef<Record<string, string>>({});
  const eligible = candidates.filter((candidate) => candidate.eligible).map((candidate) => candidate.run.id);
  const eligibleKey = eligible.join(",");
  const base = `/api/missions/${encodeURIComponent(missionId)}`;

  const settle = async (runId: string, reply: PreviewReply) => {
    if (reply.code === SLOT_LIMIT) setSlotBlocked(true);
    const next = candidatePreview(reply);
    if (next) { setPreviews((current) => ({ ...current, [runId]: next })); return; }
    const minted = candidatePreview(await request<PreviewReply>(`${base}/preview`, { runId }));
    if (minted) setPreviews((current) => ({ ...current, [runId]: minted }));
  };

  const readAll = async (): Promise<PreviewReply[]> => {
    const status = await request<MissionPreviews>(`${base}/preview`);
    if (status.slots) setSlots(status.slots);
    const replies = (status.candidates ?? []).filter((reply) => reply.runId && eligible.includes(reply.runId));
    await Promise.all(replies.map((reply) => settle(reply.runId!, reply).catch(() => undefined)));
    return replies;
  };

  async function previewAll() {
    setAllBusy(true);
    setSlotBlocked(false);
    keys.current.all ??= crypto.randomUUID();
    try {
      const reply = await request<{ candidates: PreviewReply[] }>(`${base}/preview`, { allCandidates: true }, keys.current.all);
      delete keys.current.all;
      await Promise.all(reply.candidates.map(async (candidate) => {
        if (!candidate.runId) return;
        if (candidate.status === "failed" && candidate.code) {
          if (candidate.code === SLOT_LIMIT) setSlotBlocked(true);
          setErrors((current) => ({ ...current, [candidate.runId!]: candidate.error ?? "The preview could not be started." }));
          return;
        }
        await settle(candidate.runId, candidate).catch(() => undefined);
      }));
      if (reply.candidates.some((candidate) => candidate.code === SLOT_LIMIT)) await readAll().catch(() => undefined);
    } catch (failure) {
      if (failure instanceof RequestError && failure.code === SLOT_LIMIT) { setSlotBlocked(true); await readAll().catch(() => undefined); }
      else setErrors(() => Object.fromEntries(eligible.map((runId) => [runId, failure instanceof Error ? failure.message : "The previews could not be started."])));
    } finally {
      setAllBusy(false);
    }
  }

  useEffect(() => {
    if (!eligibleKey) return;
    let active = true;
    void readAll().then((replies) => {
      if (active && autoStart && shouldAutoStart(mission.status, eligible.length, replies) && claimAutoStart(missionId, mission.epoch)) void previewAll();
    }).catch(() => undefined);
    return () => { active = false; };
  }, [missionId, eligibleKey, mission.epoch]);

  const live = Object.values(previews).some((preview) => preview.status === "starting" || preview.status === "ready");
  const starting = Object.values(previews).some((preview) => preview.status === "starting");
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  useEffect(() => {
    if (!starting) return;
    const timer = window.setInterval(() => void readAll().catch(() => undefined), POLL_MS);
    return () => window.clearInterval(timer);
  }, [starting, eligibleKey]);

  async function act(runId: string, kind: "start" | "stop") {
    setPending((current) => ({ ...current, [runId]: kind }));
    setErrors((current) => ({ ...current, [runId]: "" }));
    const signature = `${kind}:${runId}:${mission.epoch}`;
    keys.current[signature] ??= crypto.randomUUID();
    try {
      const reply = await request<PreviewReply>(`${base}/${kind === "start" ? "preview" : "preview-stop"}`, { runId }, keys.current[signature]);
      delete keys.current[signature];
      if (kind === "stop") setPreviews((current) => ({ ...current, [runId]: { status: "none" } }));
      else await settle(runId, reply);
    } catch (failure) {
      if (failure instanceof RequestError && failure.code === SLOT_LIMIT) { setSlotBlocked(true); void readAll().catch(() => undefined); }
      setErrors((current) => ({ ...current, [runId]: failure instanceof Error ? failure.message : "The preview could not be changed." }));
    } finally {
      setPending((current) => ({ ...current, [runId]: "" }));
    }
  }

  async function freeSlot(holder: string) {
    setFreeing(holder);
    try {
      await request(`/api/missions/${encodeURIComponent(holder)}/preview-stop`, { allCandidates: true }, crypto.randomUUID());
      setSlots((current) => current ? { ...current, missions: current.missions.filter((id) => id !== holder) } : current);
      setSlotBlocked(false);
      await previewAll();
    } catch (failure) {
      setErrors(() => Object.fromEntries(eligible.map((runId) => [runId, failure instanceof Error ? failure.message : "That preview could not be stopped."])));
    } finally {
      setFreeing("");
    }
  }

  const slotNotice: SlotNotice | null = slotBlocked
    ? { limit: slots?.limit ?? 2, holders: (slots?.missions ?? []).filter((id) => id !== missionId).map((id) => ({ id, title: missionTitle(id) ?? id.slice(0, 8) })) }
    : null;

  return <RaceCompareView
    mission={mission}
    candidates={candidates}
    previews={previews}
    errors={errors}
    pending={pending}
    path={path}
    draftPath={draftPath}
    canSelect={canSelect}
    canStop={canStop}
    busy={busy}
    now={now}
    allBusy={allBusy}
    slotNotice={slotNotice}
    freeing={freeing}
    onDraftPath={setDraftPath}
    onApplyPath={() => { const next = normalizePath(draftPath); setDraftPath(next); setPath(next); }}
    onPreviewAll={() => void previewAll()}
    onPreview={(runId) => void act(runId, "start")}
    onStop={(runId) => void act(runId, "stop")}
    onFreeSlot={(id) => void freeSlot(id)}
    onSelect={onSelect}
  />;
}
