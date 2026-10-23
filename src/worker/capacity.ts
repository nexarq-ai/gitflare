import { ApiError } from './domain';
import type { SqlStore } from './store';

export const WORKSPACE_MISSION_LIMIT = 2;
export const WORKSPACE_PREVIEW_LIMIT = 2;
export const MISSION_SLOT_GRACE_MS = 3_600_000;

export type CapacityKind = 'mission' | 'preview';
export interface CapacitySlot { id: string; expiresAt: number; repositoryId?: string; epoch?: number }

export function catalogName(workspaceId: string): string { return workspaceId === 'legacy' ? 'catalog:owner' : `catalog:${workspaceId}`; }

export function capacityError(kind: CapacityKind, holders: string[] = []): ApiError {
  const held = holders.length ? ` They belong to mission${holders.length === 1 ? '' : 's'} ${holders.join(', ')}.` : '';
  return kind === 'mission'
    ? new ApiError(429, 'WORKSPACE_MISSION_LIMIT', `This workspace is already running ${WORKSPACE_MISSION_LIMIT} missions, the most it can run at once (each mission runs up to three agents at a time). Wait for one to finish or cancel it, then start again.`)
    : new ApiError(429, 'WORKSPACE_PREVIEW_LIMIT', `This workspace already has live previews for ${WORKSPACE_PREVIEW_LIMIT} missions, the most it can keep at once; every candidate preview of one race counts as one.${held} Stop one (Stop on its mission preview card, or gitflare_preview_mission action stop) or wait for it to expire, then try again.`);
}

export function liveSlots(store: SqlStore, kind: CapacityKind, now = Date.now()): CapacitySlot[] {
  const slots = store.list<CapacitySlot>(`capacity:${kind}:`);
  for (const slot of slots) if (slot.expiresAt <= now) store.delete(`capacity:${kind}:${slot.id}`);
  return slots.filter((slot) => slot.expiresAt > now);
}

export function slotKey(kind: CapacityKind, id: string): string { return `capacity:${kind}:${id}`; }
