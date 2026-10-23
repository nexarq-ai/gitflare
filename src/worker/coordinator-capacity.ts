import type { Mission, Repository } from '../shared/types';
import type { AppEnv } from './env';
import type { SqlStore } from './store';
import { capacityError, catalogName, liveSlots, MISSION_SLOT_GRACE_MS, slotKey, WORKSPACE_MISSION_LIMIT, WORKSPACE_PREVIEW_LIMIT, type CapacitySlot } from './capacity';
import { missionStepTimeoutMs } from './budgets';
import { previewSubject } from './preview-subject';
import type { CoordinatorHost } from './coordinator-types';

export class CapacityBook {
  private readonly ctx: DurableObjectState;
  private readonly env: AppEnv;

  constructor(private readonly host: CoordinatorHost) {
    this.ctx = host.ctx;
    this.env = host.env;
  }

  private get store(): SqlStore { return this.host.store; }

  private getMission(id: string): Mission | undefined { return this.host.getMission(id); }
  private getRepository(id: string): Repository | undefined { return this.host.getRepository(id); }

  async releaseOnFailure<T>(release: (() => Promise<void>) | undefined, operation: () => T | Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) { await release?.().catch(() => {}); throw error; }
  }

  async reserveMissionCapacity(key: string, id: string, authorization?: NonNullable<Mission['authorization']>): Promise<(() => Promise<void>) | undefined> {
    const mission = this.getMission(id);
    if (!mission || this.store.get(`request:${key}`) || ['queued', 'running', 'checking'].includes(mission.status)) return undefined;
    const workspaceId = authorization?.workspaceId ?? mission.authorization?.workspaceId ?? this.getRepository(mission.repositoryId)?.workspaceId ?? 'legacy';
    return this.reserveWorkspaceMission(workspaceId, id, mission.repositoryId, mission.epoch + 1, missionStepTimeoutMs(mission));
  }

  // Without a coordinator namespace there is no workspace catalog to count against

  async reserveWorkspaceMission(workspaceId: string, missionId: string, repositoryId: string, epoch: number, timeoutMs: number): Promise<(() => Promise<void>) | undefined> {
    if (!this.env?.GITFLARE_COORDINATOR) return undefined;
    const catalog = this.env.GITFLARE_COORDINATOR.getByName(catalogName(workspaceId));
    const reserved = await catalog.reserveMissionSlot(missionId, repositoryId, epoch, Date.now() + timeoutMs + MISSION_SLOT_GRACE_MS);
    return reserved ? () => catalog.releaseMissionSlot(missionId, epoch) : undefined;
  }

  async reserveMissionSlot(missionId: string, repositoryId: string, epoch: number, expiresAt: number): Promise<boolean> {
    const claim = () => this.ctx.storage.transactionSync(() => {
      const existing = this.store.get<CapacitySlot>(slotKey('mission', missionId));
      if (existing && existing.expiresAt > Date.now()) {
        this.store.put(slotKey('mission', missionId), { ...existing, repositoryId, epoch, expiresAt: Math.max(existing.expiresAt, expiresAt) } satisfies CapacitySlot);
        return false;
      }
      if (liveSlots(this.store, 'mission').length >= WORKSPACE_MISSION_LIMIT) return undefined;
      this.store.put(slotKey('mission', missionId), { id: missionId, repositoryId, epoch, expiresAt } satisfies CapacitySlot);
      return true;
    });
    const first = claim();
    if (first !== undefined) return first;
    for (const slot of liveSlots(this.store, 'mission')) {
      let active = false;
      if (slot.repositoryId && slot.epoch !== undefined) {
        try { active = await this.env.GITFLARE_COORDINATOR.getByName(`repository:${slot.repositoryId}`).isMissionActive(slot.id, slot.epoch); }
        catch { active = true; }
      }
      if (!active && this.store.get<CapacitySlot>(slotKey('mission', slot.id))?.epoch === slot.epoch) this.store.delete(slotKey('mission', slot.id));
    }
    const second = claim();
    if (second === undefined) throw capacityError('mission');
    return second;
  }

  releaseMissionSlot(missionId: string, epoch: number): void {
    const slot = this.store.get<CapacitySlot>(slotKey('mission', missionId));
    if (slot && (slot.epoch === undefined || slot.epoch <= epoch)) this.store.delete(slotKey('mission', missionId));
  }

  reservePreviewSlot(key: string, expiresAt: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      const slots = liveSlots(this.store, 'preview');
      if (slots.some((slot) => slot.id === key)) return false;
      const holders = new Set(slots.map((slot) => previewSubject(slot.id).missionId));
      if (!holders.has(previewSubject(key).missionId) && holders.size >= WORKSPACE_PREVIEW_LIMIT) throw capacityError('preview', [...holders]);
      this.store.put(slotKey('preview', key), { id: key, expiresAt } satisfies CapacitySlot);
      return true;
    });
  }

  previewSlotHolders(): string[] {
    return [...new Set(liveSlots(this.store, 'preview').map((slot) => previewSubject(slot.id).missionId))];
  }

  holdPreviewSlot(missionId: string, expiresAt: number): void {
    this.store.put(slotKey('preview', missionId), { id: missionId, expiresAt } satisfies CapacitySlot);
  }

  releasePreviewSlot(missionId: string): void { this.store.delete(slotKey('preview', missionId)); }
}
