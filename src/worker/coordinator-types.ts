import type { Mission, MissionAttempt, MissionEvent, MissionSummary, Repository } from '../shared/types';
import type { PreviewStep } from '../shared/preview-progress';
import type { PreviewSetupCode } from '../shared/preview-setup';
import type { AppEnv } from './env';
import type { SqlStore } from './store';
import type { Principal } from './security';
import type { PreviewD1Database } from './worker-bundle';

export interface Receipt<T> { fingerprint: string; result: T }
export interface ContributorStanding { userId: string; landed: number; firstProposalAt: string; vouchedBy?: Principal }
export interface OutgoingProposal { missionId: string; upstreamWorkspaceId: string; upstreamRepositoryId: string; branch: string; createdAt: string }
export interface MissionSummaryCache { repositoryId: string; summaries: MissionSummary[]; cachedAt: string }
export interface IntegrationClaim { claimId?: string; missionId: string; epoch: number; candidateSha: string; baseSha: string; claimedAt?: number; phase?: 'preparing' | 'pushing'; landedSha?: string }
export const INTEGRATION_PREPARATION_MS = 600_000;
export interface PreviewCapability { workspaceId?: string; principal?: Principal; repositoryId: string; missionId: string; runId?: string; epoch: number; candidateSha: string; sandboxName: string; expiresAt: number; host?: string; isolated?: boolean }
export type PreviewHost =
  | { kind: 'connection'; source: 'repository' | 'workspace'; accountId: string; workerName: string; access: 'link' | 'cloudflare-access' }
  | { kind: 'installation'; accountId: string; workerName: string; access: 'link' };
export interface WorkerPreviewInfo { previewName: string; previewUrl: string | null; deploymentUrl: string | null; notes: string[]; d1Databases?: PreviewD1Database[]; host?: PreviewHost; baseBindings?: { name: string; type: string }[] }
export interface PreviewLifetime { lifetimeMs: number; extendMs: number }
export interface PreviewState { claimId: string; epoch: number; candidateSha: string; phase: 'preparing' | 'ready'; expiresAt: number; startedAt?: number; step?: PreviewStep; sandboxName?: string; worker?: WorkerPreviewInfo; notes?: string[]; setup?: PreviewSetupCode; readyAt?: number; extendMs?: number; extended?: boolean }
export interface WorkerPreviewRecord { previewName: string; claimId: string; expiresAt: number; d1DatabaseIds?: string[]; host?: PreviewHost; principal?: Principal }
export interface PreviewExtension { expiresAt: number; kind: 'worker' | 'container'; sandboxName?: string }
export type StoppedPreview = { kind: 'worker'; record: WorkerPreviewRecord } | { kind: 'container'; sandboxName: string } | { kind: 'none' };
export const PREVIEW_LEASE_MS = 120_000;
export const PREVIEW_HEARTBEAT_MS = 30_000;
export const PREVIEW_READY_MS = 900_000;
export const WORKER_PREVIEW_TTL_MS = 900_000;
export interface PreviewFailureRecord { claimId: string; epoch: number; candidateSha: string; message: string; failedAt: string; setup?: PreviewSetupCode }
export type PreviewEndReason = 'expired' | 'retired' | 'replaced';
export interface LastPreview { candidateSha: string; epoch: number; kind: 'worker' | 'container'; previewUrl: string | null; readyAt?: string; expiresAt: string; endedAt: string; reason: PreviewEndReason }
export interface PreviewStatus { status: 'none' | 'starting' | 'ready' | 'failed'; candidateSha: string | null; last?: LastPreview; expiresAt?: string; readyAt?: string; extended?: boolean; extendable?: boolean; error?: string; message?: string; startedAt?: string; step?: PreviewStep; kind?: 'worker' | 'container'; worker?: WorkerPreviewInfo; notes?: string[]; setup?: PreviewSetupCode; access?: 'link' | 'cloudflare-access' | 'members' }
export interface DispatchIntent { workflowId: string; missionId: string; repositoryId: string; epoch: number; attempts: number; nextAttemptAt: number }
export const DISPATCH_FAST_ATTEMPTS = 8;
export interface MissionWatch { workflowId: string; missionId: string; epoch: number; deliveredAt: number; lastReportAt: number; checkAt: number; misses: number }
export const MISSION_WATCHDOG_MS = 900_000;
export const WATCHDOG_MISSING_LIMIT = 3;
export const WATCHDOG_MISSING_RECHECK_MS = 60_000;
export const ACTIVE_WORKFLOW = ['queued', 'running', 'paused', 'waiting', 'waitingForPause'];
export const TERMINAL_WORKFLOW = ['complete', 'errored', 'terminated'];
export interface ApprovalClear { missionId: string; principal: Principal; queuedAt: string; attempts: number; nextAttemptAt: number }
export const APPROVAL_CLEAR_RETRY_MS = 30_000;
export const APPROVAL_CLEAR_MAX_BACKOFF_MS = 900_000;
export const INTEGRATION_UNCONFIRMED_MESSAGE = 'Landing could not confirm whether the default branch moved to the approved commit, so other proposals in this repository cannot land until it is resolved. Choose Land again to recheck the default branch; it never pushes twice. If the branch does not show the approved commit, ask a workspace Owner to inspect it before landing anything else.';
export const PREVIEW_STARTING_MESSAGE = 'Gitflare is building a preview of this exact revision. It clones the code, installs dependencies and builds it, then publishes it: Cloudflare Workers become a Worker Preview, and other apps run in an isolated preview container. This usually takes about a minute; if a step fails, you see which one and why.';

export interface CoordinatorHost {
  ctx: DurableObjectState;
  env: AppEnv;
  readonly store: SqlStore;
  getMission(id: string): Mission | undefined;
  requiredMission(id: string): Mission;
  saveMission(mission: Mission, message?: string, type?: MissionEvent['type']): Mission;
  archive(mission: Mission, reason: MissionAttempt['reason']): void;
  isMissionActive(id: string, epoch: number): boolean;
  getRepository(id: string): Repository | undefined;
  saveRepository(repository: Repository): void;
  recordContributorLanding(mission: Mission): void;
  recordLinkedIssues(mission: Mission, sha: string): void;
  ensureDispatchAlarm(when: number): Promise<void>;
}
export interface StoredVisualImage { id: string; format: 'png' | 'jpeg'; data: string }
