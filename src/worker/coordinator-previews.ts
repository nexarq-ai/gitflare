import type { Mission } from '../shared/types';
import { ApiError, assertReplayFingerprint } from './domain';
import { PREVIEW_FAILURE_MAX, type PreviewStep } from '../shared/preview-progress';
import type { PreviewSetupCode } from '../shared/preview-setup';
import type { SqlStore } from './store';
import { candidateKeyPrefix, PREVIEW_LIVE_STATUSES, previewCandidateSha, previewSubject } from './preview-subject';
import type { Principal } from './security';
import { type Receipt, type PreviewCapability, type WorkerPreviewInfo, type PreviewLifetime, type PreviewState, type WorkerPreviewRecord, type PreviewExtension, type StoppedPreview, PREVIEW_LEASE_MS, PREVIEW_READY_MS, WORKER_PREVIEW_TTL_MS, type PreviewFailureRecord, type PreviewEndReason, type LastPreview, type PreviewStatus, PREVIEW_STARTING_MESSAGE, type CoordinatorHost } from './coordinator-types';

function lastPreview(state: PreviewState, reason: PreviewEndReason, endedAt: number): LastPreview {
  return {
    candidateSha: state.candidateSha, epoch: state.epoch, kind: state.worker ? 'worker' : 'container', previewUrl: state.worker?.previewUrl ?? null,
    ...(state.readyAt ? { readyAt: new Date(state.readyAt).toISOString() } : {}),
    expiresAt: new Date(state.expiresAt).toISOString(), endedAt: new Date(reason === 'expired' ? state.expiresAt : endedAt).toISOString(), reason,
  };
}

export class PreviewBook {
  private readonly ctx: DurableObjectState;

  constructor(private readonly host: CoordinatorHost) {
    this.ctx = host.ctx;
  }

  private get store(): SqlStore { return this.host.store; }

  private requiredMission(id: string): Mission { return this.host.requiredMission(id); }
  private ensureDispatchAlarm(when: number): Promise<void> { return this.host.ensureDispatchAlarm(when); }

  private target(id: string): { epoch: number; candidateSha: string | null; live: boolean } {
    const { missionId, runId } = previewSubject(id);
    const mission = this.requiredMission(missionId);
    return { epoch: mission.epoch, candidateSha: previewCandidateSha(mission, runId), live: PREVIEW_LIVE_STATUSES.includes(mission.status) };
  }

  async savePreviewCapability(hash: string, capability: PreviewCapability): Promise<void> {
    this.store.put(`preview:${hash}`, capability);
    await this.ensureDispatchAlarm(capability.expiresAt);
  }

  async getPreviewCapability(hash: string): Promise<PreviewCapability | undefined> {
    const capability = this.store.get<PreviewCapability>(`preview:${hash}`);
    if (capability && capability.expiresAt > Date.now()) return capability;
    await this.prunePreviewCapabilities();
    return undefined;
  }

  async prunePreviewCapabilities(): Promise<void> {
    const now = Date.now();
    let next = Infinity;
    for (const [key, capability] of this.store.entries<PreviewCapability>('preview:')) {
      if (capability.expiresAt <= now) this.store.delete(key);
      else next = Math.min(next, capability.expiresAt);
    }
    if (next !== Infinity) await this.ensureDispatchAlarm(next);
  }

  claimPreview(key: string, id: string, epoch: number, candidateSha: string): { sandboxName?: string; worker?: WorkerPreviewInfo; notes?: string[]; setup?: PreviewSetupCode; claimId: string; claimed: boolean; expiresAt?: number; previous?: string } {
    return this.ctx.storage.transactionSync(() => {
      const target = this.target(id);
      if (target.epoch !== epoch || target.candidateSha !== candidateSha || !target.live) throw new ApiError(409, 'STALE_PREVIEW', 'Only the current verified candidate can be previewed.');
      const fingerprint = JSON.stringify(['preview', id, epoch, candidateSha]);
      const receipt = this.store.get<Receipt<boolean>>(`request:${key}`);
      if (receipt) assertReplayFingerprint(receipt.fingerprint, fingerprint);
      const current = this.store.get<PreviewState>(`preview-state:${id}`);
      if (current?.claimId && current.epoch === epoch && current.candidateSha === candidateSha && current.expiresAt > Date.now()) {
        if (current.worker) return { worker: current.worker, claimId: current.claimId, claimed: false, expiresAt: current.expiresAt };
        return current.sandboxName ? { sandboxName: current.sandboxName, claimId: current.claimId, claimed: false, expiresAt: current.expiresAt, ...(current.notes?.length ? { notes: current.notes } : {}), ...(current.setup ? { setup: current.setup } : {}) } : { claimId: current.claimId, claimed: false };
      }
      if (current?.phase === 'ready') this.rememberPreview(id, current, current.expiresAt <= Date.now() ? 'expired' : 'replaced');
      const claimId = crypto.randomUUID();
      this.store.put(`preview-state:${id}`, { claimId, epoch, candidateSha, phase: 'preparing', startedAt: Date.now(), step: 'queued', expiresAt: Date.now() + PREVIEW_LEASE_MS } satisfies PreviewState);
      this.store.delete(`preview-failure:${id}`);
      this.store.put(`request:${key}`, { fingerprint, result: true });
      return current?.claimId ? { claimId, claimed: true, previous: current.sandboxName ?? `preview-${id}-${current.claimId}` } : { claimId, claimed: true };
    });
  }

  private previewClaim(id: string, epoch: number, candidateSha: string, claimId: string): PreviewState {
    const target = this.target(id);
    const state = this.store.get<PreviewState>(`preview-state:${id}`);
    if (target.epoch !== epoch || target.candidateSha !== candidateSha || !target.live || !state || state.claimId !== claimId || state.epoch !== epoch || state.candidateSha !== candidateSha || state.expiresAt <= Date.now()) throw new ApiError(409, 'STALE_PREVIEW', 'This preview attempt is no longer current.');
    return state;
  }

  renewPreview(id: string, epoch: number, candidateSha: string, claimId: string): void {
    const state = this.previewClaim(id, epoch, candidateSha, claimId);
    if (state.phase !== 'preparing') return;
    this.store.put(`preview-state:${id}`, { ...state, expiresAt: Date.now() + PREVIEW_LEASE_MS });
  }

  previewStep(id: string, epoch: number, candidateSha: string, claimId: string, step: PreviewStep): void {
    this.ctx.storage.transactionSync(() => {
      const state = this.previewClaim(id, epoch, candidateSha, claimId);
      if (state.phase !== 'preparing') throw new ApiError(409, 'STALE_PREVIEW', 'This preview attempt is no longer preparing.');
      this.store.put(`preview-state:${id}`, { ...state, step, expiresAt: Date.now() + PREVIEW_LEASE_MS } satisfies PreviewState);
    });
  }

  previewReady(id: string, epoch: number, candidateSha: string, claimId: string, sandboxName: string, lifetime: PreviewLifetime = { lifetimeMs: PREVIEW_READY_MS, extendMs: PREVIEW_READY_MS }, notes: string[] = [], setup?: PreviewSetupCode): number {
    const state = this.previewClaim(id, epoch, candidateSha, claimId);
    if (sandboxName !== `preview-${id}-${claimId}`) throw new ApiError(409, 'STALE_PREVIEW', 'The preview sandbox does not belong to this attempt.');
    const readyAt = Date.now();
    const expiresAt = readyAt + lifetime.lifetimeMs;
    this.store.put(`preview-state:${id}`, { ...state, phase: 'ready', sandboxName, expiresAt, readyAt, extendMs: lifetime.extendMs, ...(notes.length ? { notes: notes.slice(0, 20).map((note) => note.slice(0, 500)) } : {}), ...(setup ? { setup } : {}) } satisfies PreviewState);
    return expiresAt;
  }

  workerPreviewReady(id: string, epoch: number, candidateSha: string, claimId: string, worker: WorkerPreviewInfo, lifetime: PreviewLifetime = { lifetimeMs: WORKER_PREVIEW_TTL_MS, extendMs: WORKER_PREVIEW_TTL_MS }, principal?: Principal): number {
    return this.ctx.storage.transactionSync(() => {
      const state = this.previewClaim(id, epoch, candidateSha, claimId);
      const readyAt = Date.now();
      const expiresAt = readyAt + lifetime.lifetimeMs;
      this.store.put(`preview-state:${id}`, { ...state, phase: 'ready', worker, expiresAt, readyAt, extendMs: lifetime.extendMs } satisfies PreviewState);
      const previous = this.store.get<WorkerPreviewRecord>(`worker-preview:${id}`);
      const sameHost = previous?.previewName === worker.previewName && previous.host?.accountId === worker.host?.accountId && previous.host?.workerName === worker.host?.workerName;
      const d1DatabaseIds = sameHost ? previous.d1DatabaseIds ?? [] : [];
      this.store.put(`worker-preview:${id}`, { previewName: worker.previewName, claimId, expiresAt, ...(d1DatabaseIds.length ? { d1DatabaseIds } : {}), ...(worker.host ? { host: worker.host } : {}), ...(principal ? { principal } : {}) } satisfies WorkerPreviewRecord);
      return expiresAt;
    });
  }

  extendPreview(id: string): PreviewExtension {
    return this.ctx.storage.transactionSync(() => {
      const target = this.target(id);
      const state = this.store.get<PreviewState>(`preview-state:${id}`);
      if (!state || state.phase !== 'ready' || state.expiresAt <= Date.now() || state.epoch !== target.epoch || state.candidateSha !== target.candidateSha) throw new ApiError(409, 'PREVIEW_NOT_READY', 'Only a ready preview of the current candidate can be extended.');
      if (state.extended) throw new ApiError(409, 'PREVIEW_ALREADY_EXTENDED', 'This preview was already extended once. Prepare a new preview when it expires.');
      const expiresAt = state.expiresAt + (state.extendMs ?? PREVIEW_READY_MS);
      this.store.put(`preview-state:${id}`, { ...state, expiresAt, extended: true } satisfies PreviewState);
      if (state.worker) {
        const record = this.store.get<WorkerPreviewRecord>(`worker-preview:${id}`);
        if (record?.claimId === state.claimId) this.store.put(`worker-preview:${id}`, { ...record, expiresAt } satisfies WorkerPreviewRecord);
        return { expiresAt, kind: 'worker' };
      }
      return { expiresAt, kind: 'container', ...(state.sandboxName ? { sandboxName: state.sandboxName } : {}) };
    });
  }

  workerPreview(id: string): WorkerPreviewRecord | undefined { return this.store.get<WorkerPreviewRecord>(`worker-preview:${id}`); }

  retireWorkerPreview(id: string, claimId?: string): WorkerPreviewRecord | null {
    return this.ctx.storage.transactionSync(() => {
      const record = this.store.get<WorkerPreviewRecord>(`worker-preview:${id}`);
      if (!record || (claimId && record.claimId !== claimId)) return null;
      this.store.delete(`worker-preview:${id}`);
      const state = this.store.get<PreviewState>(`preview-state:${id}`);
      if (state?.worker) {
        if (state.phase === 'ready') this.rememberPreview(id, state, state.expiresAt <= Date.now() ? 'expired' : 'retired');
        this.store.delete(`preview-state:${id}`);
      }
      return record;
    });
  }

  stopPreview(id: string): StoppedPreview {
    return this.ctx.storage.transactionSync(() => {
      const record = this.store.get<WorkerPreviewRecord>(`worker-preview:${id}`);
      const state = this.store.get<PreviewState>(`preview-state:${id}`);
      if (record) {
        this.store.delete(`worker-preview:${id}`);
        if (state?.worker || state?.claimId === record.claimId) {
          if (state.phase === 'ready') this.rememberPreview(id, state, state.expiresAt <= Date.now() ? 'expired' : 'retired');
          this.store.delete(`preview-state:${id}`);
        }
        return { kind: 'worker', record };
      }
      if (!state) return { kind: 'none' };
      const sandboxName = state.sandboxName ?? `preview-${id}-${state.claimId}`;
      if (state.phase !== 'ready') {
        this.store.delete(`preview-state:${id}`);
        return { kind: 'container', sandboxName };
      }
      this.rememberPreview(id, state, state.expiresAt <= Date.now() ? 'expired' : 'retired');
      this.store.delete(`preview-state:${id}`);
      return { kind: 'container', sandboxName };
    });
  }

  private rememberPreview(id: string, state: PreviewState, reason: PreviewEndReason): void {
    this.store.put(`preview-last:${id}`, lastPreview(state, reason, Date.now()) satisfies LastPreview);
  }

  previewFailed(id: string, claimId: string, message?: string, setup?: PreviewSetupCode): boolean {
    return this.ctx.storage.transactionSync(() => {
      const state = this.store.get<PreviewState>(`preview-state:${id}`);
      if (state?.claimId !== claimId) return false;
      this.store.delete(`preview-state:${id}`);
      if (message) this.store.put(`preview-failure:${id}`, { claimId, epoch: state.epoch, candidateSha: state.candidateSha, message: message.slice(0, PREVIEW_FAILURE_MAX), failedAt: new Date().toISOString(), ...(setup ? { setup } : {}) } satisfies PreviewFailureRecord);
      return true;
    });
  }

  previewStatus(id: string): PreviewStatus {
    const mission = this.target(id);
    const current = (entry?: { epoch: number; candidateSha: string }) => !!entry && entry.epoch === mission.epoch && entry.candidateSha === mission.candidateSha;
    const state = this.store.get<PreviewState>(`preview-state:${id}`);
    if (current(state) && state!.expiresAt > Date.now()) {
      if (state!.phase !== 'ready') return { status: 'starting', candidateSha: mission.candidateSha, message: PREVIEW_STARTING_MESSAGE, ...(state!.startedAt ? { startedAt: new Date(state!.startedAt).toISOString() } : {}), step: state!.step ?? 'queued' };
      const ready = state!;
      return {
        status: 'ready', candidateSha: mission.candidateSha, expiresAt: new Date(ready.expiresAt).toISOString(),
        ...(ready.readyAt ? { readyAt: new Date(ready.readyAt).toISOString() } : {}),
        extended: !!ready.extended, extendable: !ready.extended,
        ...(ready.worker ? { kind: 'worker' as const, worker: ready.worker, access: ready.worker.host?.access ?? 'link' } : { kind: 'container' as const, access: 'members' as const, ...(ready.notes?.length ? { notes: ready.notes } : {}), ...(ready.setup ? { setup: ready.setup } : {}) }),
      };
    }
    const expired = state?.phase === 'ready' && state.expiresAt <= Date.now() ? lastPreview(state, 'expired', Date.now()) : undefined;
    const last = expired ?? this.store.get<LastPreview>(`preview-last:${id}`);
    const history = last ? { last } : {};
    const failure = this.store.get<PreviewFailureRecord>(`preview-failure:${id}`);
    if (current(failure)) return { status: 'failed', candidateSha: mission.candidateSha, error: failure!.message, ...(failure!.setup ? { setup: failure!.setup } : {}), ...history };
    return { status: 'none', candidateSha: mission.candidateSha, ...history };
  }

  candidatePreviewKeys(missionId: string): string[] {
    const keys = new Set<string>();
    for (const prefix of ['preview-state:', 'worker-preview:']) {
      const scope = `${prefix}${candidateKeyPrefix(missionId)}`;
      for (const [key] of this.store.entries(scope)) keys.add(key.slice(prefix.length));
    }
    return [...keys];
  }
}
