import { repositoryLabel } from "../shared/repository-names";
import { useEffect, useRef, useState } from "react";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  CheckCircleIcon,
  ClockIcon,
  CodeIcon,
  FileCodeIcon,
  GitBranchIcon,
  GitCommitIcon,
  ArrowCounterClockwiseIcon,
  GitMergeIcon,
  InfoIcon,
  PlayIcon,
  RobotIcon,
  ShieldCheckIcon,
  StopIcon,
  UsersThreeIcon,
  WarningCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { AGENT_REVIEWER_ID, type AgentRetryOverride, type Mission, type ModelConnection, type ModelConnectionsSnapshot, type Workspace } from "../shared/types";
import { isUntrustedMission } from "../shared/pull-requests";
import InfoTip from "./InfoTip";
import { FixRequestNote } from "./FixRequests";
import { request, RequestError } from "./api";
import { EmptyState, ErrorNotice, relativeTime, Status } from "./components";
import AgentAssignment from "./AgentAssignment";
import AgentRetry, { AgentLimitsDetails } from "./AgentRetry";
import { retryAgentBody } from "./agent-limits";
import AttemptHistory from "./AttemptHistory";
import { CheckEscalationNote, CheckTimeoutPanel } from "./CheckSettings";
import DiffView, {
  lineAnchor,
  type LineAnchor,
  type LineCommentKind,
} from "./DiffView";
import { PullRequestPanel } from "./PullRequests";
import { DependencyApprovalControl, DependencyChangesPanel } from "./DependencyChanges";
import { navigate as goTo } from "./router";
import { PageLoading } from "./WorkspaceLoader";
import { ContextFiles, MarkdownContent } from "./MissionDocuments";
import { useMissionReplay } from "./DemoReplay";
import { resumePreview, type PreviewProgress, type PreviewStatusLike } from "../shared/preview-progress";
import { isPreviewSetupCode, type PreviewSetupCode } from "../shared/preview-setup";
import { PreviewFailedCard, PreviewReadyCard, PreviewStartingCard, type PreviewAccess, type PreviewHost, type PreviewState } from "./PreviewPanel";
import CommitMessageField, { type CommitDraft } from "./CommitMessageField";
import SubscribeButton from "./SubscribeButton";
import { currentReviewRequests, ownerGroupStatus, reviewKindLabel, submitReviewBody, VERDICT_LABELS, VERDICTS, verdictAvailable, type ApprovalProgress, type OwnerGroupStatus, type ReviewVerdict } from "./review-summary";
import "./inbox.css";
import { commitMessageProblem, normalizeCommitMessage, suggestedCommitMessage } from "../shared/commit-message";

type PreviewResult = { status?: "starting" | "ready"; message?: string; kind?: "worker" | "container"; previewUrl?: string; deploymentUrl?: string | null; notes?: string[]; candidateSha: string; expiresAt?: string; linkExpiresAt?: string; host?: PreviewHost; access?: PreviewAccess; extended?: boolean; setup?: string };

type Props = {
  id: string;
  initialTab: string;
  selectedRunId?: string;
  currentUserId: string;
  onTabChange: (tab: string) => void;
  permissions: string[];
  workspace: Workspace;
  onBack: () => void;
  onUpdate: () => void;
  demo?: boolean;
  installationAdmin?: boolean;
};

export default function MissionDetail({
  id,
  initialTab,
  selectedRunId,
  currentUserId,
  onTabChange,
  permissions: grantedPermissions,
  workspace,
  onBack,
  onUpdate,
  demo = false,
  installationAdmin = false,
}: Props) {
  const [loadedMission, setMission] = useState<Mission>();
  const isActive = !!loadedMission && ["queued", "running", "checking", "integrating"].includes(loadedMission.status);
  const replay = useMissionReplay(id, demo);
  const mission = replay.mission ?? loadedMission;
  const permissions = replay.active ? [] : grantedPermissions;
  const missionActive = useRef(false);
  missionActive.current = isActive;
  const reschedule = useRef(() => {});
  const tab = [
    "overview",
    "changes",
    "checks",
    "agents",
    "discussion",
    "activity",
    "attempts",
  ].includes(initialTab)
    ? initialTab
    : "overview";
  const [reviewBody, setReviewBody] = useState("");
  const [verdict, setVerdict] = useState<ReviewVerdict>("comment");
  const [approval, setApproval] = useState<(ApprovalProgress & { candidateSha: string }) | null>(null);
  const approveFromReview = useRef(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState("");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewProgress, setPreviewProgress] = useState<PreviewProgress | null>(null);
  const [previewFailure, setPreviewFailure] = useState("");
  const [previewSetup, setPreviewSetup] = useState<PreviewSetupCode>();
  const previewStarting = previewProgress !== null;
  const previewRef = useRef<PreviewState | null>(null);
  previewRef.current = preview;
  const mutation = useRef<{ signature: string; key: string } | null>(null);
  const revision = useRef(0);
  const [confirming, setConfirming] = useState<"approve" | "integrate" | null>(null);
  const [commitDraft, setCommitDraft] = useState<CommitDraft>({ subject: "", body: "" });
  const [suggestedMessage, setSuggestedMessage] = useState("");
  const [dependencyAck, setDependencyAck] = useState({ candidateSha: "", checked: false });
  const pollSequence = useRef(0);
  const [retryModels, setRetryModels] = useState<ModelConnection[] | null>(null);
  const needsRetryModels = !!mission && permissions.includes("execute") && mission.runs.some((run) => run.status === "failed");
  const repository = workspace.repositories.find(
    (item) => item.id === mission?.repositoryId,
  );

  useEffect(() => {
    let active = true;
    const load = async () => {
      const startedAt = revision.current;
      const sequence = ++pollSequence.current;
      try {
        const result = await request<Mission>(
          `/api/missions/${encodeURIComponent(id)}`,
        );
        if (active && startedAt === revision.current && sequence === pollSequence.current) {
          revision.current++;
      setMission(result);
          setLoadError("");
        }
      } catch (failure) {
        if (active)
          setLoadError(
            failure instanceof Error
              ? failure.message
              : "Could not load this mission.",
          );
      }
    };
    let timer = 0;
    const schedule = () => {
      window.clearTimeout(timer);
      if (active && document.visibilityState === "visible") timer = window.setTimeout(() => void load().finally(schedule), missionActive.current ? 5000 : 30000);
    };
    const resume = () => { if (document.visibilityState === "visible") void load().finally(schedule); else window.clearTimeout(timer); };
    reschedule.current = schedule;
    void load().finally(schedule);
    document.addEventListener("visibilitychange", resume);
    return () => {
      active = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [id]);

  useEffect(() => { if (isActive) reschedule.current(); }, [isActive]);

  useEffect(() => {
    if (!needsRetryModels || retryModels) return;
    let active = true;
    request<ModelConnectionsSnapshot>("/api/models").then((snapshot) => { if (active) setRetryModels(snapshot.models); }).catch(() => { if (active) setRetryModels([]); });
    return () => { active = false; };
  }, [needsRetryModels, retryModels]);

  async function act(
    action: "start" | "retry-agents" | "drop-failed-agents" | "address-review" | "cancel" | "approve" | "integrate" | "revoke" | "agent-review",
    commitMessage?: string,
    retry?: { runId: string; override?: AgentRetryOverride },
  ) {
    if (!mission || busy) return;
    setBusy(retry ? `retry-agent:${retry.runId}` : action);
    setError("");
    const body =
      action === "approve" || action === "integrate" || action === "revoke"
        ? { candidateSha: mission.candidateSha, baseSha: mission.baseSha, ...(action === "approve" && mission.dependencyChanges?.length ? { approveDependencies: dependenciesAcknowledged } : {}), ...(commitMessage !== undefined && action !== "revoke" ? { commitMessage } : {}) }
        : action === "retry-agents" && retry ? retryAgentBody(retry.runId, retry.override)
        : {};
    const signature = JSON.stringify({
      id,
      epoch: mission.epoch,
      action,
      body,
    });
    if (mutation.current?.signature !== signature)
      mutation.current = { signature, key: crypto.randomUUID() };
    try {
      const result = await request<Mission & { approval?: ApprovalProgress }>(
        `/api/missions/${encodeURIComponent(id)}/${action}`,
        body,
        mutation.current.key,
      );
      revision.current++;
      setMission(result);
      if (action === "approve") recordApproval(result);
      mutation.current = null;
      onUpdate();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The mission could not be updated.",
      );
    } finally {
      setBusy("");
    }
  }

  const commitMessage = normalizeCommitMessage(commitDraft.subject, commitDraft.body);
  const commitProblem = confirming ? commitMessageProblem(commitMessage) : null;

  function recordApproval(result: Mission & { approval?: ApprovalProgress }) {
    setApproval(result.approval && result.candidateSha ? { ...result.approval, candidateSha: result.candidateSha } : null);
  }

  async function submitReview(chosen: ReviewVerdict, commitMessage?: string) {
    if (!mission || busy) return;
    const body = submitReviewBody(chosen, mission, reviewBody, chosen === "approve" ? { ...(mission.dependencyChanges?.length ? { approveDependencies: dependenciesAcknowledged } : {}), ...(commitMessage !== undefined ? { commitMessage } : {}) } : {});
    const signature = JSON.stringify({ id, action: "submit-review", body });
    if (mutation.current?.signature !== signature)
      mutation.current = { signature, key: crypto.randomUUID() };
    setBusy(chosen === "approve" ? "approve" : chosen);
    setError("");
    try {
      const result = await request<Mission & { approval?: ApprovalProgress }>(
        `/api/missions/${encodeURIComponent(id)}/submit-review`,
        body,
        mutation.current.key,
      );
      revision.current++;
      setMission(result);
      if (chosen === "approve") recordApproval(result);
      setReviewBody("");
      setVerdict("comment");
      mutation.current = null;
      onUpdate();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not submit the review.");
    } finally {
      setBusy("");
    }
  }

  function openConfirm(action: "approve" | "integrate", fromReview = false) {
    if (!mission) return;
    approveFromReview.current = action === "approve" && fromReview;
    const suggestion = suggestedCommitMessage(mission);
    setCommitDraft(suggestion);
    setSuggestedMessage(normalizeCommitMessage(suggestion.subject, suggestion.body));
    setConfirming(action);
  }

  async function retryChecks(adjustment: "timeout" | "runner") {
    if (!mission || busy) return;
    setBusy("retry-checks");
    setError("");
    const signature = JSON.stringify({ id, epoch: mission.epoch, action: "retry-checks", adjustment });
    if (mutation.current?.signature !== signature)
      mutation.current = { signature, key: crypto.randomUUID() };
    try {
      const result = await request<Mission>(
        `/api/missions/${encodeURIComponent(id)}/retry-checks`,
        { adjustment },
        mutation.current.key,
      );
      revision.current++;
      setMission(result);
      mutation.current = null;
      onUpdate();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The checks could not be retried.",
      );
    } finally {
      setBusy("");
    }
  }

  async function revert() {
    if (!mission || busy) return;
    setBusy("revert");
    setError("");
    try {
      const started = await request<Mission>(
        `/api/missions/${encodeURIComponent(id)}/revert`,
        {},
        crypto.randomUUID(),
      );
      onUpdate();
      goTo(`mission/${started.id}`);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The restore could not be started.",
      );
    } finally {
      setBusy("");
    }
  }

  async function select(runId: string) {
    if (!mission || busy) return;
    setBusy("select");
    setError("");
    const body = { runId, epoch: mission.epoch };
    const signature = JSON.stringify({ id, action: "select", body });
    if (mutation.current?.signature !== signature)
      mutation.current = { signature, key: crypto.randomUUID() };
    try {
      const result = await request<Mission>(
        `/api/missions/${encodeURIComponent(id)}/select`,
        body,
        mutation.current.key,
      );
      revision.current++;
      setMission(result);
      mutation.current = null;
      onUpdate();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The candidate could not be selected.",
      );
    } finally {
      setBusy("");
    }
  }

  async function review(
    action: "comment" | "request_changes" | "resolve",
    reviewId?: string,
  ) {
    if (!mission || busy) return;
    const body = {
      action,
      body: action === "resolve" ? undefined : reviewBody,
      reviewId,
      epoch: mission.epoch,
      candidateSha: mission.candidateSha,
      baseSha: mission.baseSha,
    };
    const signature = JSON.stringify({ id, action: "review", body });
    if (mutation.current?.signature !== signature)
      mutation.current = { signature, key: crypto.randomUUID() };
    setBusy(action);
    setError("");
    try {
      const result = await request<Mission>(
        `/api/missions/${encodeURIComponent(id)}/review`,
        body,
        mutation.current.key,
      );
      revision.current++;
      setMission(result);
      setReviewBody("");
      mutation.current = null;
      onUpdate();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Could not save review.",
      );
    } finally {
      setBusy("");
    }
  }

  async function commentOnLine(
    anchor: LineAnchor,
    text: string,
    kind: LineCommentKind,
  ) {
    if (!mission) return;
    const body = {
      action: kind,
      body: text,
      epoch: mission.epoch,
      candidateSha: mission.candidateSha,
      baseSha: mission.baseSha,
      ...anchor,
    };
    const signature = JSON.stringify({ id, action: "review", body });
    if (mutation.current?.signature !== signature)
      mutation.current = { signature, key: crypto.randomUUID() };
    const result = await request<Mission>(
      `/api/missions/${encodeURIComponent(id)}/review`,
      body,
      mutation.current.key,
    );
    revision.current++;
    setMission(result);
    mutation.current = null;
    onUpdate();
  }

  async function applyPreviewStatus(candidateSha: string, status: PreviewStatusLike) {
    const resumed = resumePreview(status);
    if (resumed.kind === "preparing") {
      setPreviewFailure("");
      setPreviewProgress(resumed.progress);
      return;
    }
    setPreviewProgress(null);
    if (resumed.kind === "failed") {
      setPreview(null);
      setPreviewFailure(resumed.error);
      setPreviewSetup(resumed.setup);
      return;
    }
    if (resumed.kind === "none") {
      setPreview(null);
      return;
    }
    const known = previewRef.current;
    if (known?.candidateSha === candidateSha && Date.parse(known.expiresAt) > Date.now()) return;
    acceptPreview(candidateSha, await request<PreviewResult>(
      `/api/missions/${encodeURIComponent(id)}/preview`,
      {},
    ));
  }

  const previewCandidate = mission?.candidateSha;
  useEffect(() => {
    if (!previewCandidate) return;
    let active = true;
    const read = async () => {
      try {
        const status = await request<PreviewStatusLike>(`/api/missions/${encodeURIComponent(id)}/preview`);
        if (active) await applyPreviewStatus(previewCandidate, status);
      } catch {
        return;
      }
    };
    const resume = () => { if (document.visibilityState === "visible") void read(); };
    void read();
    document.addEventListener("visibilitychange", resume);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", resume);
    };
  }, [id, previewCandidate]);

  useEffect(() => {
    const candidateSha = mission?.candidateSha;
    if (!previewStarting || !candidateSha) return;
    let active = true;
    let timer = 0;
    const poll = async () => {
      try {
        const status = await request<PreviewStatusLike>(
          `/api/missions/${encodeURIComponent(id)}/preview`,
        );
        if (!active) return;
        await applyPreviewStatus(candidateSha, status);
        if (status.status !== "starting") return;
      } catch (failure) {
        if (!active) return;
        if (failure instanceof TypeError || (failure instanceof DOMException && failure.name === "TimeoutError")) {
          timer = window.setTimeout(poll, 3000);
          return;
        }
        setPreviewProgress(null);
        setError(failure instanceof Error ? failure.message : "The preview could not be prepared.");
        return;
      }
      timer = window.setTimeout(poll, 3000);
    };
    timer = window.setTimeout(poll, 3000);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [previewStarting, id, mission?.candidateSha]);

  function acceptPreview(candidateSha: string, result: PreviewResult) {
    if (
      result.status === "starting" ||
      result.candidateSha !== candidateSha ||
      !result.previewUrl ||
      new URL(result.previewUrl).protocol !== "https:" ||
      !(Date.parse(result.expiresAt ?? "") > Date.now())
    ) {
      throw new Error(
        "The preview does not match this candidate or has expired. Create a new preview.",
      );
    }
    setPreview({
      previewUrl: result.previewUrl,
      candidateSha: result.candidateSha,
      expiresAt: result.expiresAt!,
      ...(result.linkExpiresAt ? { linkExpiresAt: result.linkExpiresAt } : {}),
      extended: !!result.extended,
      access: result.access ?? (result.kind === "worker" ? "link" : "members"),
      ...(result.kind === "worker" ? { worker: { deploymentUrl: result.deploymentUrl ?? null, notes: result.notes ?? [], ...(result.host ? { host: result.host } : {}) } } : { ...(result.notes?.length ? { notes: result.notes } : {}), ...(isPreviewSetupCode(result.setup) ? { setup: result.setup } : {}) }),
    });
  }

  async function extendPreview() {
    if (!preview || busy) return;
    setBusy("preview-extend");
    setError("");
    try {
      const status = await request<{ expiresAt?: string; extended?: boolean }>(
        `/api/missions/${encodeURIComponent(id)}/preview-extend`,
        {},
        crypto.randomUUID(),
      );
      if (status.expiresAt) setPreview({ ...preview, expiresAt: status.expiresAt, extended: true });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The preview could not be extended.");
    } finally {
      setBusy("");
    }
  }

  async function stopPreview() {
    if ((!preview && !previewStarting) || busy) return;
    setBusy("preview-stop");
    setError("");
    try {
      await request(`/api/missions/${encodeURIComponent(id)}/preview-stop`, {}, crypto.randomUUID());
      setPreview(null);
      setPreviewProgress(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The preview could not be stopped.");
    } finally {
      setBusy("");
    }
  }

  async function preparePreview() {
    if (!mission?.candidateSha || busy || previewStarting) return;
    setBusy("preview");
    setError("");
    setPreviewFailure("");
    setPreviewSetup(undefined);
    const signature = JSON.stringify({
      id,
      action: "preview",
      candidateSha: mission.candidateSha,
    });
    if (mutation.current?.signature !== signature)
      mutation.current = { signature, key: crypto.randomUUID() };
    try {
      const result = await request<PreviewResult & PreviewStatusLike>(
        `/api/missions/${encodeURIComponent(id)}/preview`,
        {},
        mutation.current.key,
      );
      mutation.current = null;
      if (result.previewUrl) acceptPreview(mission.candidateSha, result);
      else await applyPreviewStatus(mission.candidateSha, result);
    } catch (failure) {
      if (failure instanceof RequestError && isPreviewSetupCode(failure.code)) {
        setPreviewFailure(failure.message);
        setPreviewSetup(failure.code);
      } else setError(
        failure instanceof Error
          ? failure.message
          : "The preview could not be prepared.",
      );
    } finally {
      setBusy("");
    }
  }

  if (!mission)
    return (
      <>
        <button className="header-back" onClick={onBack}>
          <ArrowLeftIcon size={13} />
          Proposals
        </button>
        {loadError ? (
          <ErrorNotice message={loadError} />
        ) : (
          <PageLoading />
        )}
      </>
    );
  const active = ["queued", "running", "checking"].includes(mission.status);
  const verifiedChecks = mission.raceChecks ?? mission.checks;
  const verifiedRuns = mission.runs.filter((run) => run.status === "completed" && !!run.commitSha && !!run.forkName && verifiedChecks.some((check) => check.runId === run.id && check.status === "passed" && check.candidateSha === run.commitSha) && !run.collision);
  const unfinishedRuns = mission.runs.filter((run) => !verifiedRuns.includes(run));
  const canRetryAgents = mission.epoch > 0 && ["failed", "cancelled"].includes(mission.status) && !mission.skillChange && !mission.revertChange && !mission.branchChange && (unfinishedRuns.length > 0 || mission.mode !== "race");
  const landing = mission.status === "integrating" && !mission.error;
  const overlap = mission.changes.filter((change) => change.runIds.length > 1);
  const unresolvedRequests = (mission.reviews ?? []).filter(
    (review) =>
      review.kind === "request_changes" &&
      !review.resolvedAt &&
      review.epoch === mission.epoch &&
      review.candidateSha === mission.candidateSha &&
      review.baseSha === mission.baseSha,
  );
  const currentLineComments = (mission.reviews ?? []).filter(
    (review) =>
      review.path &&
      review.epoch === mission.epoch &&
      review.candidateSha === mission.candidateSha &&
      review.baseSha === mission.baseSha,
  );
  const canDiscuss =
    ["needs_review", "approved"].includes(mission.status) &&
    !!mission.candidateSha &&
    !!mission.baseSha;
  const isRace = mission.mode === "race";
  const fileOwners = new Map<string, string[]>();
  if (!isRace)
    for (const run of mission.runs)
      for (const path of run.touchedFiles ?? run.changedFiles)
        fileOwners.set(path, [...(fileOwners.get(path) ?? []), run.name]);
  const overlaps = [...fileOwners]
    .filter(([, agents]) => agents.length > 1)
    .map(([path, agents]) => ({ path, agents }));
  const overlapPaths = new Set(overlaps.map((entry) => entry.path));
  const raceChecks = mission.raceChecks ?? mission.checks;
  const raceChanges = mission.raceChanges ?? mission.changes;
  const raceCandidates = isRace
    ? mission.runs
        .filter((run) => run.commitSha || run.status === "failed")
        .map((run) => {
          const check = raceChecks.find((entry) => entry.runId === run.id);
          const changes = raceChanges.filter((change) => change.runIds.includes(run.id));
          return {
            run,
            check,
            files: changes.length,
            additions: changes.reduce((total, change) => total + change.additions, 0),
            deletions: changes.reduce((total, change) => total + change.deletions, 0),
            eligible: run.status === "completed" && check?.status === "passed",
          };
        })
    : [];
  const isOwner = permissions.includes("manage");
  const dependencyGate = !!mission.dependencyChanges?.length;
  const dependenciesAcknowledged = isOwner && dependencyAck.checked && dependencyAck.candidateSha === mission.candidateSha;
  const readyForReview =
    unresolvedRequests.length === 0 &&
    mission.status === "needs_review" &&
    !!mission.candidateSha &&
    !!mission.baseSha &&
    mission.checks.length > 0 &&
    mission.checks.every((check) => check.status === "passed");
  const canPreview =
    ["needs_review", "approved", "integrating", "integrated"].includes(
      mission.status,
    ) &&
    !!mission.candidateSha &&
    mission.checks.length > 0 &&
    mission.checks.every((check) => check.status === "passed");
  const previewViewer = { installationAdmin, owner: permissions.includes("manage") };
  const currentPreview =
    preview &&
    preview.candidateSha === mission.candidateSha &&
    Date.parse(preview.expiresAt) > Date.now()
      ? preview
      : null;
  const passed = mission.checks.filter(
    (check) => check.status === "passed",
  ).length;
  const reviewRequests = currentReviewRequests(mission);
  const currentApproval = approval && approval.candidateSha === mission.candidateSha ? approval : null;
  const ownerGroups = reviewRequests ? ownerGroupStatus(reviewRequests.groups, currentApproval?.missingOwners) : [];
  const reviewContext = { canReview: permissions.includes("review"), canComment: permissions.includes("contribute"), readyForApproval: readyForReview };
  const chosenVerdict = verdictAvailable(verdict, reviewContext) ? verdict : "comment";

  return (
    <>
      <button className="header-back" onClick={onBack}>
        <ArrowLeftIcon size={13} />
        Proposals
      </button>
      <div className="page-heading detail-heading">
        <div>
          <h1>{mission.title}</h1>
          <div className="detail-meta">
            <Status status={mission.status} />
            <span>{mission.branchChange ? "Proposal" : mission.fixRequest ? "Requested fix" : mission.mode === "race" ? "AI race" : "AI mission"}</span>
            <span>
              <GitBranchIcon size={13} />
              {repository ? repositoryLabel(repository) : "Repository"}
            </span>
            <span>
              <ClockIcon size={13} />
              Created {relativeTime(mission.createdAt)}
            </span>
          </div>
        </div>
        <div className="heading-actions detail-actions">
          {!replay.active && <SubscribeButton target={{ kind: "proposal", repositoryId: mission.repositoryId, missionId: mission.id }} />}
          {replay.available && !replay.active && (
            <Button variant="secondary" size="base" icon={PlayIcon} onClick={replay.start}>
              Watch this mission run
            </Button>
          )}
          <LinkButton
            variant="secondary"
            size="base"
            icon={CodeIcon}
            href={`/repository/${encodeURIComponent(mission.repositoryId)}/code`}
            aria-label={repository ? `Open repository ${repositoryLabel(repository)}` : "Open repository"}
          >
            Open repository
          </LinkButton>
          {canPreview && !replay.active && (
            <Button
              variant="secondary"
              size="base"
              icon={ArrowSquareOutIcon}
              loading={busy === "preview" || previewStarting}
              disabled={!!busy || previewStarting}
              onClick={() => void preparePreview()}
            >
              {previewStarting ? "Preparing…" : currentPreview ? "Refresh preview" : "Prepare preview"}
            </Button>
          )}
          {canPreview && !replay.active && previewStarting && permissions.includes("contribute") && (
            <Button
              variant="secondary"
              size="base"
              icon={StopIcon}
              loading={busy === "preview-stop"}
              disabled={!!busy}
              onClick={() => void stopPreview()}
            >
              Stop
            </Button>
          )}
          {!mission.branchChange && ["draft", "failed", "cancelled", "needs_review"].includes(
            mission.status,
          ) && (
            <Button
              variant={
                mission.status === "needs_review" ? "secondary" : "primary"
              }
              size="base"
              icon={PlayIcon}
              loading={busy === "start"}
              disabled={!!busy || !permissions.includes("execute")}
              onClick={() => void act("start")}
            >
              {mission.status === "draft"
                ? "Start agents"
                : mission.status === "needs_review"
                  ? "Rerun on latest base"
                  : "Retry mission"}
            </Button>
          )}
          {canRetryAgents && (
            <Button
              variant="primary"
              size="base"
              icon={ArrowCounterClockwiseIcon}
              loading={busy === "retry-agents"}
              disabled={!!busy || !permissions.includes("execute")}
              onClick={() => void act("retry-agents")}
            >
              {unfinishedRuns.length ? `Retry failed agents (${unfinishedRuns.length})` : "Combine again"}
            </Button>
          )}
          {canRetryAgents && verifiedRuns.length > 0 && unfinishedRuns.length > 0 && (
            <Button
              variant="secondary"
              size="base"
              loading={busy === "drop-failed-agents"}
              disabled={!!busy || !permissions.includes("execute")}
              onClick={() => void act("drop-failed-agents")}
            >
              Continue without failed agents
            </Button>
          )}
          {mission.status === "needs_review" && unresolvedRequests.length > 0 && !mission.skillChange && !mission.revertChange && !mission.branchChange && (mission.mode !== "race" || !!mission.selectedRunId) && (
            <Button
              variant="secondary"
              size="base"
              icon={ArrowCounterClockwiseIcon}
              loading={busy === "address-review"}
              disabled={!!busy || !permissions.includes("execute")}
              onClick={() => void act("address-review")}
            >
              Send changes to agents ({unresolvedRequests.length})
            </Button>
          )}
          {active && (
            <Button
              variant="secondary"
              size="base"
              icon={StopIcon}
              loading={busy === "cancel"}
              disabled={!!busy || !permissions.includes("execute")}
              onClick={() => void act("cancel")}
            >
              Cancel mission
            </Button>
          )}
          {mission.status === "integrated" && (
            <Button
              variant="secondary"
              size="base"
              icon={ArrowCounterClockwiseIcon}
              loading={busy === "revert"}
              disabled={!!busy || !permissions.includes("contribute") || !permissions.includes("execute")}
              onClick={() => void revert()}
            >
              Restore
            </Button>
          )}
          {mission.status === "approved" && (
            <Button
              variant="secondary"
              size="base"
              disabled={!!busy || !permissions.includes("review")}
              loading={busy === "revoke"}
              onClick={() => void act("revoke")}
            >
              Revoke approval
            </Button>
          )}
          {["approved", "integrating"].includes(mission.status) && (
            <Button
              variant="primary"
              size="base"
              icon={GitMergeIcon}
              loading={busy === "integrate" || landing}
              disabled={
                !!busy ||
                landing ||
                !permissions.includes("land") ||
                unresolvedRequests.length > 0
              }
              onClick={() => mission.status === "integrating" ? void act("integrate") : openConfirm("integrate")}
            >
              {landing
                ? "Landing…"
                : mission.status === "integrating"
                  ? "Recheck landing"
                  : "Land approved changes"}
            </Button>
          )}
          {readyForReview && dependencyGate && (
            <DependencyApprovalControl isOwner={isOwner} manifests={mission.dependencyChanges ?? []} checked={dependenciesAcknowledged} onChange={(checked) => setDependencyAck({ candidateSha: mission.candidateSha ?? "", checked })} />
          )}
          {readyForReview && (
            <Button
              variant="primary"
              size="base"
              icon={ShieldCheckIcon}
              loading={busy === "approve"}
              disabled={!!busy || !permissions.includes("review") || (dependencyGate && !dependenciesAcknowledged)}
              title={!permissions.includes("review") ? "You need the Reviewer role or higher to approve." : dependencyGate && !dependenciesAcknowledged ? "Allow the new packages first." : undefined}
              onClick={() => openConfirm("approve")}
            >
              Approve candidate
            </Button>
          )}
        </div>
      </div>
      {replay.bar}
      {mission.fixRequest && <FixRequestNote fix={mission.fixRequest} status={mission.status} />}
      {mission.branchChange && <PullRequestPanel mission={mission} permissions={permissions} onChange={(result) => { revision.current++; setMission(result); onUpdate(); }} />}
      {["needs_review", "approved"].includes(mission.status) && (ownerGroups.length > 0 || (currentApproval && !currentApproval.ready)) && <ReviewRequestsStrip groups={ownerGroups} source={reviewRequests?.source ?? null} approval={currentApproval} />}
      {currentPreview && <PreviewReadyCard preview={currentPreview} viewer={previewViewer} busy={busy} canExtend={permissions.includes("land")} canStop={permissions.includes("contribute")} onExtend={() => void extendPreview()} onStop={() => void stopPreview()} />}
      {previewProgress && <PreviewStartingCard progress={previewProgress} />}
      {previewFailure && !previewStarting && <PreviewFailedCard message={previewFailure} setup={previewSetup} viewer={previewViewer} canRetry={canPreview && !replay.active} busy={busy} onRetry={() => void preparePreview()} />}
      {error && <ErrorNotice message={error} />}
      {loadError && <ErrorNotice message={loadError} />}
      {mission.error && mission.error !== error && (
        <ErrorNotice message={mission.error} />
      )}
      {unresolvedRequests.length > 0 && (
        <div className="alert">
          <WarningCircleIcon size={17} />
          <div className="alert-text">
            {unresolvedRequests.length} unresolved review requests block
            approval and landing for this revision.{" "}
            <button
              className="text-link"
              onClick={() => onTabChange("discussion")}
            >
              View discussion
            </button>
          </div>
        </div>
      )}
      {mission.status === "approved" && (
        <div className="alert info">
          <ShieldCheckIcon size={17} />
          <div className="alert-text">
            Candidate <code>{mission.candidateSha}</code> is approved and ready to land.<InfoTip label="landing an approved candidate">Landing checks the base is unchanged. Revoke approval to run the mission again.</InfoTip>
          </div>
        </div>
      )}
      {mission.status === "integrated" && (
        <div className="alert info">
          <GitMergeIcon size={17} />
          <div className="alert-text">
            The approved candidate has landed in the repository{mission.landedSha && mission.landedSha !== mission.candidateSha ? <> as <code>{mission.landedSha.slice(0, 12)}</code> with the same files</> : null}. Restore creates a
            new revision that undoes it, checked and approved like any change.
          </div>
        </div>
      )}
      {mission.status === "draft" && (
        <div className="alert info">
          <RobotIcon size={17} />
          <div className="alert-text">
            Draft. Nothing runs until you start it.
          </div>
        </div>
      )}
      {overlaps.length > 0 && (
        <div className="alert info" role="status">
          <InfoIcon size={17} />
          <div className="alert-text">
            {overlaps.length === 1 ? "One file" : `${overlaps.length} files`} changed by more than one agent.<InfoTip label="overlapping files">The combined check decides whether the changes fit together.</InfoTip>
            <ul className="overlap-list">
              {overlaps.slice(0, 8).map((entry) => (
                <li key={entry.path}>
                  <code>{entry.path}</code> — {entry.agents.join(", ")}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {isRace && raceCandidates.length > 0 && (
        <section aria-label="Race candidates">
          {mission.status === "needs_review" && !mission.selectedRunId && (
            <div className="alert info">
              <InfoIcon size={17} />
              <div className="alert-text">
                The race is finished. Compare the candidates and select one; only the selected revision can be approved and landed.
              </div>
            </div>
          )}
          <div className="race-grid">
            {raceCandidates.map((candidate) => (
              <article
                className={`race-card${candidate.run.id === mission.selectedRunId ? " selected" : ""}`}
                key={candidate.run.id}
              >
                <h3>
                  {candidate.run.name}
                  <Status status={candidate.check?.status ?? candidate.run.status} />
                </h3>
                <p>{candidate.run.assignment ?? candidate.run.role}</p>
                <div className="race-stats">
                  <span>
                    <code>{candidate.run.commitSha?.slice(0, 12) ?? "No revision"}</code>
                  </span>
                  <span>{candidate.files} files</span>
                  <span>
                    +{candidate.additions} −{candidate.deletions}
                  </span>
                  {candidate.check?.durationMs !== undefined && (
                    <span>tests {Math.round(candidate.check.durationMs / 100) / 10}s</span>
                  )}
                </div>
                {candidate.run.summary && <p>{candidate.run.summary.slice(0, 280)}</p>}
                {candidate.run.error && <p style={{ color: "#b55c45" }}>{candidate.run.error}</p>}
                {candidate.eligible && mission.status === "needs_review" && (
                  <Button
                    variant={candidate.run.id === mission.selectedRunId ? "secondary" : "primary"}
                    size="sm"
                    loading={busy === "select"}
                    disabled={!!busy || !permissions.includes("review") || candidate.run.id === mission.selectedRunId}
                    onClick={() => void select(candidate.run.id)}
                  >
                    {candidate.run.id === mission.selectedRunId ? "Selected for review" : "Select this candidate"}
                  </Button>
                )}
              </article>
            ))}
          </div>
        </section>
      )}
      <dl className="mission-meta">
        <div><dt>Base</dt><dd>{mission.baseSha ? <code title={mission.baseSha}>{mission.baseSha.slice(0, 7)}</code> : "Set at start"}</dd></div>
        <div><dt>Candidate</dt><dd>{mission.candidateSha ? <code title={mission.candidateSha}>{mission.candidateSha.slice(0, 7)}</code> : "None yet"}</dd></div>
        {mission.epoch > 0 && <div><dt>Attempt</dt><dd>{mission.epoch}</dd></div>}
        <div><dt>{mission.skillChange ? "Skill edit" : "Agents"}</dt><dd>{mission.skillChange ? "Trusted" : `${mission.runs.length} ${mission.epoch === 0 ? "planned" : "isolated"}`}</dd></div>
      </dl>
      <div className="page-tabs">
        <Tabs
          variant="underline"
          value={tab}
          onValueChange={onTabChange}
          tabs={[
            { value: "overview", label: "Overview" },
            {
              value: "changes",
              label: `Changes${mission.changes.length ? ` (${mission.changes.length})` : ""}`,
            },
            {
              value: "checks",
              label: `Checks${mission.checks.length ? ` (${passed}/${mission.checks.length})` : ""}`,
            },
            { value: "agents", label: `Agents (${mission.runs.length})` },
            {
              value: "discussion",
              label: `Discussion (${(mission.reviews ?? []).length})`,
            },
            { value: "activity", label: "Activity" },
            { value: "attempts", label: "Attempt history" },
          ]}
        />
      </div>
      {(tab === "overview" || tab === "agents") && (
        <>
          {tab === "overview" && (
          <>
            <DependencyChangesPanel mission={mission} />
            <ContextFiles files={mission.attachments ?? []} />
            <div className="detail-summary">
              <section className="panel">
                <div className="panel-header">
                  <h2>Mission brief</h2>
                  <CodeIcon size={16} color="#8b99ab" />
                </div>
                <div className="panel-body">
                  <MarkdownContent content={mission.prompt} />
                  {!!mission.acceptanceCriteria?.length && (
                    <div style={{ marginTop: 19 }}>
                      <h3 style={{ fontSize: 13 }}>Acceptance criteria</h3>
                      <ul className="acceptance-list">
                        {mission.acceptanceCriteria.map((criterion, index) => (
                          <li key={index}>{criterion}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="summary-grid">
                    <div>
                      <span>Base revision</span>
                      <strong>
                        <code>
                          {mission.baseSha?.slice(0, 12) ??
                            "Assigned when work starts"}
                        </code>
                      </strong>
                    </div>
                    <div>
                      <span>Candidate revision</span>
                      <strong>
                        <code>
                          {mission.candidateSha ??
                            "Waiting for agent work"}
                        </code>
                      </strong>
                    </div>
                  </div>
                </div>
              </section>
              <aside className="panel summary-aside">
                <div className="panel-header">
                  <h2>Review policy</h2>
                  <ShieldCheckIcon size={16} color="#8b99ab" />
                </div>
                <div className="panel-body">
                  <p className="security-note">
                    <GitCommitIcon size={14} />A new revision needs a new review.
                  </p>
                </div>
              </aside>
            </div>
          </>
          )}
          {tab === "agents" && selectedRunId && (
            <p className="mission-prompt">
              <button
                className="text-link"
                onClick={() => onTabChange("agents")}
              >
                ← All agent runs
              </button>
            </p>
          )}
          {tab === "agents" &&
            selectedRunId &&
            !mission.runs.some((run) => run.id === selectedRunId) && (
              <ErrorNotice message="This run was not found in the current attempt. Check Attempt history for earlier runs." />
            )}
          <div className="section-heading">
            <h2>
              Agent work{" "}
              <span className="number-tag">{mission.runs.length}</span>
            </h2>
            <span className="status-strip">
              <span className={`status-dot ${active ? "warn" : ""}`} />
              {active ? "Updates every 5 seconds" : "Recorded execution state"}
            </span>
          </div>
          {mission.runs.length ? (
            <div className="agent-grid">
              {mission.runs
                .filter(
                  (run) =>
                    tab !== "agents" ||
                    !selectedRunId ||
                    run.id === selectedRunId,
                )
                .map((run) => (
                  <article
                    className={tab === "agents" ? "agent-card agent-card-with-footer" : "agent-card"}
                    id={`run-${run.id}`}
                    key={run.id}
                  >
                    <div className="agent-top">
                      <div className="agent-icon">
                        <RobotIcon size={22} />
                      </div>
                      <div>
                        <h3>{run.name}</h3>
                        <small>
                          {run.role}
                          {run.model ? ` / ${run.model}` : ""}
                        </small>
                      </div>
                      <Status
                        status={mission.epoch === 0 ? "draft" : run.status}
                      />
                    </div>
                    <div className="agent-body">
                      <AgentAssignment run={run} mission={mission} />
                      {run.note && (
                        <p className="agent-note">Shared with the team: {run.note}</p>
                      )}
                      {run.reusedFromEpoch !== undefined && run.status === "completed" && (
                        <p className="agent-note">Verified candidate carried over from attempt {run.reusedFromEpoch}; this agent did not run again.</p>
                      )}
                      {run.skipReason && run.status === "skipped" && (
                        <p className="agent-note">Skipped: {run.skipReason}</p>
                      )}
                      {run.usage && run.usage.calls > 0 && (
                        <p className="agent-usage">Usage: {run.usage.calls} {run.usage.calls === 1 ? "call" : "calls"} · input {run.usage.inputTokens.toLocaleString()} · output {run.usage.outputTokens.toLocaleString()} · cache read {run.usage.cacheReadTokens.toLocaleString()} · cache write {run.usage.cacheWriteTokens.toLocaleString()}{run.usage.unreportedCalls > 0 ? ` · ${run.usage.unreportedCalls} without provider counts (unknown)` : ""}</p>
                      )}
                      {run.summary && (
                        <p style={{ marginTop: 12 }}>{run.summary}</p>
                      )}
                      {(run.touchedFiles ?? run.changedFiles).length > 0 && (
                        <div className="touched-files" aria-label={`Files touched by ${run.name}`}>
                          {(run.touchedFiles ?? run.changedFiles).slice(0, 24).map((path) => (
                            <code key={path} className={overlapPaths.has(path) ? "shared" : undefined}>{path}</code>
                          ))}
                        </div>
                      )}
                      {run.error && (
                        <p style={{ marginTop: 12, color: "#b55c45" }}>
                          {run.error}
                        </p>
                      )}
                      {run.status === "failed" && mission.epoch > 0 && !replay.active && !mission.skillChange && !mission.revertChange && !mission.branchChange && (
                        <AgentRetry
                          run={run}
                          status={mission.status}
                          canExecute={permissions.includes("execute")}
                          busy={!!busy}
                          loading={busy === `retry-agent:${run.id}`}
                          models={retryModels}
                          onRetry={(override) => void act("retry-agents", undefined, { runId: run.id, override })}
                        />
                      )}
                      {run.skills !== undefined && (
                        <details className="agent-skill-evidence">
                          <summary>{run.skills.length} repository {run.skills.length === 1 ? "skill" : "skills"} loaded</summary>
                          {run.skills.length ? <ul>{run.skills.map(skill => <li key={skill.path}><strong>{skill.name}</strong><code>{skill.path}</code><small>Source {skill.commitSha.slice(0, 12)} · SHA-256 {skill.sha256.slice(0, 12)}</small></li>)}</ul> : <p>No skills were available at the starting revision.</p>}
                          {run.skillWarnings?.map((warning, index) => <p className="agent-skill-warning" key={index}>{warning}</p>)}
                        </details>
                      )}
                      <dl>
                        <dt>Stream</dt>
                        <dd>
                          <code>{run.branch ?? "Not allocated"}</code>
                        </dd>
                        <dt>Fork</dt>
                        <dd>
                          <code>{run.forkName ?? "Not allocated"}</code>
                        </dd>
                        <dt>Revision</dt>
                        <dd>
                          <code>
                            {run.commitSha?.slice(0, 12) ?? "No revision yet"}
                          </code>
                        </dd>
                        <dt>Started</dt>
                        <dd>
                          {run.startedAt
                            ? new Date(run.startedAt).toLocaleTimeString()
                            : "Waiting"}
                        </dd>
                        <AgentLimitsDetails run={run} />
                      </dl>
                      {tab === "agents" && (
                        <>
                          <h3>Recorded run activity</h3>
                          <ol className="timeline">
                            {mission.events
                              .filter((event) => event.runId === run.id)
                              .map((event) => (
                                <li key={event.id}>
                                  <span className="timeline-marker" />
                                  <p>{event.message}</p>
                                  <small>
                                    {new Date(event.timestamp).toLocaleString()}
                                  </small>
                                </li>
                              ))}
                          </ol>
                          {!mission.events.some(
                            (event) => event.runId === run.id,
                          ) && <p>No run events recorded.</p>}
                        </>
                      )}
                      {run.changedFiles.length > 0 && (
                        <div className="file-tags">
                          {run.changedFiles.map((file) => (
                            <code key={file}>{file}</code>
                          ))}
                        </div>
                      )}
                    </div>
                    {tab === "agents" && <footer className="agent-card-footer"><Button variant="secondary" size="base" icon={FileCodeIcon} onClick={() => onTabChange("changes")}>Inspect saved changes</Button></footer>}
                  </article>
                ))}
            </div>
          ) : (
            <div className="panel">
              <EmptyState
                icon={<RobotIcon size={25} />}
                title="No agents yet"
                description="Agents appear here once you start the mission."
              />
            </div>
          )}
          {tab === "overview" && (
            <section className="panel" style={{ marginTop: 24 }}>
              <div className="panel-header">
                <h2>Latest activity</h2>
                <button
                  className="text-link"
                  onClick={() => onTabChange("activity")}
                >
                  View all activity <ArrowSquareOutIcon size={12} />
                </button>
              </div>
              <div className="panel-body">
                <EventTimeline mission={mission} limit={4} />
              </div>
            </section>
          )}
        </>
      )}
      {tab === "changes" && (
        <>
          <p className="mission-prompt">
            {mission.changes.length} changed files · +
            {mission.changes.reduce(
              (count, change) => count + change.additions,
              0,
            )}{" "}
            / −
            {mission.changes.reduce(
              (count, change) => count + change.deletions,
              0,
            )}{" "}
            · {overlap.length} overlapping paths
          </p>
          {mission.changes.length ? (
            <DiffView
              changes={mission.changes}
              candidateSha={mission.candidateSha}
              comments={currentLineComments}
              canComment={
                canDiscuss &&
                (permissions.includes("contribute") ||
                  permissions.includes("review"))
              }
              canRequestChanges={canDiscuss && permissions.includes("review")}
              onComment={commentOnLine}
              fileMeta={(change) => (
                <div className="repository-work-meta">
                  {change.runIds.map((runId) => (
                    <button
                      key={runId}
                      className="text-link"
                      onClick={() => {
                        goTo(`mission/${mission.id}/agents/${runId}`);
                      }}
                    >
                      {mission.runs.find((run) => run.id === runId)?.name ??
                        runId.slice(0, 8)}
                    </button>
                  ))}
                  {change.runIds.length > 1 && (
                    <strong>Overlapping agent changes</strong>
                  )}
                </div>
              )}
            />
          ) : (
            <div className="panel">
              <EmptyState
                icon={<FileCodeIcon size={25} />}
                title="No changes to review yet"
                description="Changes appear when agents save a revision."
              />
            </div>
          )}
        </>
      )}
      {tab === "checks" && (
        <>
          <p className="mission-prompt">
            Checks on each agent and on the combined result.<InfoTip label="mission checks">Each agent's revision is checked alone. The combined revision is checked again because changes that pass separately can fail together.</InfoTip>
          </p>
          <div className="panel">
            {mission.checks.length ? (
              mission.checks.map((check) => (
                <div key={check.id} className={`check-row ${check.status}`}>
                  {check.status === "passed" ? (
                    <CheckCircleIcon size={20} />
                  ) : check.status === "failed" ? (
                    <XCircleIcon size={20} />
                  ) : (
                    <ClockIcon size={20} />
                  )}
                  <div>
                    <h3>{check.name}</h3>
                    <p>
                      {check.candidateSha === mission.candidateSha &&
                      mission.candidateSha
                        ? "Combined candidate"
                        : check.candidateSha &&
                            mission.runs.some(
                              (run) => run.commitSha === check.candidateSha,
                            )
                          ? "Individual agent revision"
                          : "Combination check"}
                    </p>
                    {check.candidateSha && (
                      <p>
                        Revision <code>{check.candidateSha.slice(0, 12)}</code>
                        {check.durationMs !== undefined &&
                          ` • ${(check.durationMs / 1000).toFixed(1)}s`}
                      </p>
                    )}
                    <CheckEscalationNote check={check} />
                    {check.timeout && check.status === "failed" && (
                      <CheckTimeoutPanel
                        mission={mission}
                        check={{ ...check, timeout: check.timeout }}
                        canRetry={permissions.includes("land")}
                        busy={busy === "retry-checks"}
                        onRetry={(adjustment) => void retryChecks(adjustment)}
                      />
                    )}
                    {check.output && (
                      <details open={check.status === "failed"}>
                        <summary>View check output</summary>
                        <pre
                          className="code-output"
                          style={{ marginTop: 10, padding: 12, fontSize: 13 }}
                        >
                          {check.output}
                        </pre>
                      </details>
                    )}
                  </div>
                  <Status status={check.status} />
                </div>
              ))
            ) : (
              <EmptyState
                icon={<ShieldCheckIcon size={25} />}
                title="Checks have not run"
                description="Checks appear here once agents finish."
              />
            )}
          </div>
          {mission.candidateSha && (
            <div className="security-note">
              <GitMergeIcon size={15} />
              Approval is tied to candidate {mission.candidateSha.slice(
                0,
                12,
              )}{" "}
              and base {mission.baseSha?.slice(0, 12)}. A change to either
              invalidates that approval.
            </div>
          )}
        </>
      )}
      {tab === "discussion" && (
        <section className="panel">
          <div className="panel-header">
            <h2>Review discussion</h2>
            {isUntrustedMission(mission) && mission.status === "needs_review" && permissions.includes("review") && !(mission.reviews ?? []).some((item) => item.authorId === AGENT_REVIEWER_ID && item.candidateSha === mission.candidateSha && item.epoch === mission.epoch) && (
              <span className="fix-action">
                <Button variant="secondary" size="sm" icon={RobotIcon} loading={busy === "agent-review"} disabled={!!busy} onClick={() => void act("agent-review")}>Ask the agent</Button>
                <InfoTip label="agent reviews">One answer from the review agent, paid by the community pool. It comments only; it never approves or lands.</InfoTip>
              </span>
            )}
            <span className="number-tag">
              {unresolvedRequests.length} unresolved requests on this revision
            </span>
          </div>
          {(mission.reviews ?? []).length ? (
            (mission.reviews ?? []).map((item) => {
              const current =
                item.epoch === mission.epoch &&
                item.candidateSha === mission.candidateSha &&
                item.baseSha === mission.baseSha;
              return (
                <article className={`repository-work-item proposal-review-entry${item.summary ? " is-summary" : ""}${item.kind === "approve" ? " is-approved" : ""}`} key={item.id}>
                  <div className="repository-work-title">
                    <strong>
                      {item.kind === "approve" && <ShieldCheckIcon size={14} weight="fill" aria-hidden="true" />}
                      {item.authorId === AGENT_REVIEWER_ID ? "Agent review" : reviewKindLabel(item.kind)}
                      {item.summary && <span className="proposal-review-tag">Review</span>}
                      {item.resolvedAt ? " · Resolved" : ""}
                    </strong>
                    <small>{new Date(item.createdAt).toLocaleString()}</small>
                  </div>
                  <p className="proposal-review-revision">
                    {item.authorId === AGENT_REVIEWER_ID ? "Review agent, not an approval" : `Reviewer ${item.authorId}`} · Attempt {item.epoch} · Candidate{" "}
                    {item.candidateSha.slice(0, 12)} · Base{" "}
                    {item.baseSha.slice(0, 12)}
                    {!current && !item.path ? " · Previous revision" : ""}
                  </p>
                  {item.path && item.line && item.side && (
                    <p className="proposal-review-anchor">
                      {current ? (
                        <a
                          href={`/mission/${encodeURIComponent(mission.id)}/changes#${encodeURI(lineAnchor({ path: item.path, line: item.line, side: item.side }))}`}
                        >
                          <code>
                            {item.path}:{item.line}
                          </code>
                        </a>
                      ) : (
                        <code>
                          {item.path}:{item.line}
                        </code>
                      )}{" "}
                      {item.side === "old" ? "original" : "changed"} line
                      {!current && (
                        <span className="proposal-review-outdated">
                          Outdated
                        </span>
                      )}
                    </p>
                  )}
                  {item.summary ? item.body.trim() && <div className="proposal-review-body"><MarkdownContent content={item.body} /></div> : <p style={{ whiteSpace: "pre-wrap" }}>{item.body}</p>}
                  {item.kind === "request_changes" &&
                    !item.resolvedAt &&
                    current &&
                    canDiscuss &&
                    item.authorId === currentUserId &&
                    permissions.includes("review") && (
                      <Button
                        variant="secondary"
                        disabled={!!busy}
                        onClick={() => void review("resolve", item.id)}
                      >
                        Resolve request
                      </Button>
                    )}
                  {item.resolvedAt && (
                    <small>
                      Resolved by {item.resolvedBy} ·{" "}
                      {new Date(item.resolvedAt).toLocaleString()}
                    </small>
                  )}
                </article>
              );
            })
          ) : (
            <EmptyState
              icon={<ShieldCheckIcon size={25} />}
              title="No review discussion yet"
              description="Comment on or request changes to this revision."
            />
          )}
          {canDiscuss &&
          (permissions.includes("contribute") ||
            permissions.includes("review")) ? (
            <form
              className="proposal-review-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (chosenVerdict === "approve") openConfirm("approve", true);
                else void submitReview(chosenVerdict);
              }}
            >
              <span className="proposal-review-heading">
                <label htmlFor="proposal-review-body">Submit review</label>
                <InfoTip label="this review">Tied to candidate {mission.candidateSha?.slice(0, 12)}, base {mission.baseSha?.slice(0, 12)} and attempt {mission.epoch}. Markdown is supported.</InfoTip>
              </span>
              <textarea
                id="proposal-review-body"
                required={chosenVerdict !== "approve"}
                maxLength={8000}
                value={reviewBody}
                onChange={(event) => setReviewBody(event.target.value)}
                placeholder={chosenVerdict === "approve" ? "Optional summary…" : "Summarize your review…"}
              />
              <div className="proposal-review-verdicts" role="radiogroup" aria-label="Review verdict">
                {VERDICTS.map((option) => (
                  <label key={option} className={verdictAvailable(option, reviewContext) ? undefined : "is-disabled"} title={option === "approve" && !verdictAvailable(option, reviewContext) ? !permissions.includes("review") ? "You need the Reviewer role or higher to approve." : "Approval opens when checks pass and no change requests are open." : undefined}>
                    <input type="radio" name="proposal-review-verdict" value={option} checked={chosenVerdict === option} disabled={!!busy || !verdictAvailable(option, reviewContext)} onChange={() => setVerdict(option)} />
                    {VERDICT_LABELS[option]}
                  </label>
                ))}
              </div>
              {chosenVerdict === "approve" && dependencyGate && (
                <DependencyApprovalControl isOwner={isOwner} manifests={mission.dependencyChanges ?? []} checked={dependenciesAcknowledged} onChange={(checked) => setDependencyAck({ candidateSha: mission.candidateSha ?? "", checked })} />
              )}
              <div className="proposal-review-actions">
                <Button
                  type="submit"
                  variant="primary"
                  icon={chosenVerdict === "approve" ? ShieldCheckIcon : undefined}
                  loading={busy === chosenVerdict}
                  disabled={
                    !!busy ||
                    (chosenVerdict !== "approve" && !reviewBody.trim()) ||
                    (chosenVerdict === "approve" && dependencyGate && !dependenciesAcknowledged)
                  }
                >
                  {chosenVerdict === "approve" ? "Approve…" : chosenVerdict === "request_changes" ? "Request changes" : "Comment"}
                </Button>
              </div>
            </form>
          ) : (
            <div className="panel-body">
              <p className="mission-prompt">
                Discussion opens when a revision is ready for review.
              </p>
            </div>
          )}
        </section>
      )}
      {tab === "activity" && (
        <section className="panel">
          <div className="panel-header">
            <h2>Mission history</h2>
            <span className="number-tag">{mission.events.length} events</span>
          </div>
          <div className="panel-body">
            <EventTimeline mission={mission} />
          </div>
        </section>
      )}
      {tab === "attempts" && (
        <AttemptHistory key={mission.id} mission={mission} attempts={replay.attempts} />
      )}
      <Dialog.Root open={confirming !== null} onOpenChange={(open) => { if (!open) setConfirming(null); }}>
        <Dialog size="sm" className="dialog-content confirm-dialog">
          <Dialog.Title className="dialog-title">
            {confirming === "approve" ? "Approve this candidate?" : "Land these changes?"}
          </Dialog.Title>
          <Dialog.Description className="dialog-description">
            {confirming === "approve"
              ? <>Approve revision <code>{mission.candidateSha?.slice(0, 12)}</code> after {mission.checks.length} passing check{mission.checks.length === 1 ? "" : "s"}. Approval does not change the repository; landing is a separate step.{dependencyGate && <> You also approve the dependency changes listed on the Overview tab.</>}{approveFromReview.current && reviewBody.trim() && <> Your summary is posted with the approval.</>}</>
              : <>Land revision <code>{mission.candidateSha?.slice(0, 12)}</code> on <strong>{repository?.defaultBranch ?? "the main stream"}</strong> of <strong>{repository ? repositoryLabel(repository) : "this repository"}</strong>. You can undo it later with Restore.</>}
          </Dialog.Description>
          {confirming && <CommitMessageField draft={commitDraft} branch={repository?.defaultBranch ?? "the default stream"} problem={commitProblem} onChange={setCommitDraft} />}
          <div className="dialog-actions">
            <Button variant="secondary" size="base" type="button" onClick={() => setConfirming(null)}>Cancel</Button>
            <Button variant="primary" size="base" type="button" icon={confirming === "approve" ? ShieldCheckIcon : GitMergeIcon} disabled={!!commitProblem} onClick={() => { const action = confirming; setConfirming(null); if (!action) return; const message = action === "integrate" || commitMessage !== suggestedMessage ? commitMessage : undefined; if (action === "approve" && approveFromReview.current) void submitReview("approve", message); else void act(action, message); }}>
              {confirming === "approve" ? "Approve" : "Land changes"}
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  );
}

function ReviewRequestsStrip({ groups, source, approval }: { groups: OwnerGroupStatus[]; source: string | null; approval: ApprovalProgress | null }) {
  return (
    <section className="review-requests" aria-label={groups.length ? "Code owner reviews" : "Approvals"}>
      <div className="review-requests-head">
        <UsersThreeIcon size={15} aria-hidden="true" />
        <strong>{groups.length ? "Code owners" : "Approvals"}</strong>
        {groups.length > 0 && <InfoTip label="code owners">Read from {source ?? "CODEOWNERS"} at the base commit. Each group needs an approval from one of its owners on this revision.</InfoTip>}
        {approval && <span className="review-requests-count">{approval.approvals} of {approval.requiredApprovals} approvals</span>}
      </div>
      {groups.length > 0 && (
        <ul>
          {groups.map((group) => (
            <li key={group.handles.join(" ") + group.paths[0]} className={`is-${group.state}`}>
              {group.state === "clear" ? <CheckCircleIcon size={14} weight="fill" aria-label="Approved" /> : group.state === "missing" ? <WarningCircleIcon size={14} aria-label="Needs approval" /> : <ClockIcon size={14} aria-label="Requested" />}
              <span className="review-requests-owners">{group.handles.map((handle) => `@${handle}`).join(" ")}</span>
              <span className="review-requests-paths" title={group.paths.join("\n")}>{group.paths.slice(0, 2).join(", ")}{group.paths.length > 2 ? ` +${group.paths.length - 2}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EventTimeline({
  mission,
  limit,
}: {
  mission: Mission;
  limit?: number;
}) {
  const events = [...mission.events].reverse().slice(0, limit);
  if (!events.length)
    return (
      <p className="mission-prompt" style={{ fontSize: 13 }}>
        No execution events have been recorded.
      </p>
    );
  return (
    <ol className="timeline">
      {events.map((event) => (
        <li key={event.id}>
          <span
            className="timeline-marker"
            style={
              event.type === "error"
                ? { background: "#df9d8b" }
                : event.type === "success"
                  ? { background: "#8dbca0" }
                  : undefined
            }
          />
          <p>{event.message}</p>
          <small>
            {new Date(event.timestamp).toLocaleString()}
            {event.runId ? ` · Agent ${event.runId.slice(0, 8)}` : ""}
          </small>
        </li>
      ))}
    </ol>
  );
}
