import type { AgentAssistSettings, CommunityAiModel, CommunityPool, CommunityPoolUsage, FixRequest, ModelConnection } from '../shared/types';
import { ownModelAccess, ownModelRoute, type AiAccessOptions, type AiCredentials } from './ai-keys';
import { ApiError } from './domain';
import type { ModelRoute } from './gateway-routing';
import { assertPinnedModel } from './model-config';
import type { Principal } from './security';

export const POOL_LIMITS = { models: 5, missionsPerDay: 200, draftsPerDay: 1000, perUserPerDay: 20 } as const;
export const OPERATOR_TRIAGE_PER_DAY = 50;
export const REQUESTER_FIXES_PER_DAY = 10;
export interface StoredPool extends CommunityPool { authority: Principal }
export type PoolKind = 'request' | 'mission' | 'draft';
export interface PoolStore { get<T>(key: string): T | undefined; put<T>(key: string, value: T): void; delete(key: string): void }
interface DayUsage { missions: string[]; drafts: string[]; requests: { id: string; userId: string }[] }

const POOL_KEY = 'community-pool';
const ASSIST_KEY = 'agent-assist';
const usageKey = (day: string) => `pool-usage:${day}`;
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

export function hostedOnly(env: { EDITION?: string; DEMO_MODE?: string }, what = 'Community AI'): void {
  if (env.EDITION === 'self-hosted' || env.DEMO_MODE === 'true') throw new ApiError(403, 'HOSTED_ONLY', `${what} is part of hosted Gitflare.`);
}

export function publicPool(pool: StoredPool | null | undefined): CommunityPool | null {
  if (!pool) return null;
  const { authority: _authority, ...rest } = pool;
  return rest;
}

export function readPool(store: PoolStore): StoredPool | null { return store.get<StoredPool>(POOL_KEY) ?? null; }

export function writePool(store: PoolStore, pool: StoredPool | null): void {
  if (pool) store.put(POOL_KEY, pool);
  else store.delete(POOL_KEY);
}

export function readAssist(store: PoolStore): AgentAssistSettings { return store.get<AgentAssistSettings>(ASSIST_KEY) ?? { triage: false, review: false }; }

export function writeAssist(store: PoolStore, settings: AgentAssistSettings): AgentAssistSettings { store.put(ASSIST_KEY, settings); return settings; }

function dayUsage(store: PoolStore, day: string): DayUsage { return store.get<DayUsage>(usageKey(day)) ?? { missions: [], drafts: [], requests: [] }; }

export function poolUsage(store: PoolStore, now = Date.now()): CommunityPoolUsage {
  const day = utcDay(now), usage = dayUsage(store, day);
  return { day, missions: usage.missions.length, drafts: usage.drafts.length, requests: usage.requests.length };
}

export function requesterRemaining(store: PoolStore, pool: CommunityPool, userId: string, now = Date.now()): number {
  const usage = dayUsage(store, utcDay(now));
  const own = usage.requests.filter(entry => entry.userId === userId).length;
  return Math.max(0, Math.min(pool.perUserPerDay - own, pool.missionsPerDay - usage.missions.length));
}

export function reservePool(store: PoolStore, kind: PoolKind, id: string, userId: string | null, now = Date.now()): { allowed: boolean; reason: string } {
  const pool = readPool(store);
  if (!pool) return { allowed: false, reason: 'This repository has no community AI pool.' };
  const day = utcDay(now);
  store.delete(usageKey(utcDay(now - 86_400_000)));
  const usage = dayUsage(store, day);
  if (kind === 'draft') {
    if (usage.drafts.includes(id)) return { allowed: true, reason: '' };
    if (usage.drafts.length >= pool.draftsPerDay) return { allowed: false, reason: `The community pool has used its ${pool.draftsPerDay} agent answers for today (UTC).` };
    usage.drafts.push(id);
  } else if (kind === 'mission') {
    if (usage.missions.includes(id)) return { allowed: true, reason: '' };
    if (usage.missions.length >= pool.missionsPerDay) return { allowed: false, reason: `The community pool has funded its ${pool.missionsPerDay} agent runs for today (UTC).` };
    usage.missions.push(id);
  } else {
    if (usage.requests.some(entry => entry.id === id)) return { allowed: true, reason: '' };
    if (!userId) return { allowed: false, reason: 'Sign in to request a fix.' };
    if (usage.requests.filter(entry => entry.userId === userId).length >= pool.perUserPerDay) return { allowed: false, reason: `You have used this project's ${pool.perUserPerDay} funded fix requests for today (UTC).` };
    if (usage.missions.length >= pool.missionsPerDay) return { allowed: false, reason: `The community pool has funded its ${pool.missionsPerDay} agent runs for today (UTC).` };
    usage.requests.push({ id, userId });
  }
  store.put(usageKey(day), usage);
  return { allowed: true, reason: '' };
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new ApiError(400, 'INVALID_INPUT', `${field} must be a whole number from ${min} to ${max}.`);
  return value as number;
}

export function poolModelChoices(pool: Pick<CommunityPool, 'models'>, models: ModelConnection[], credentials: AiCredentials): ModelConnection[] {
  return pool.models.flatMap(id => models.filter(model => model.id === id && model.verification?.status === 'verified' && ownModelAccess(credentials, model)));
}

export function eligiblePoolModels(models: ModelConnection[], credentials: AiCredentials): CommunityAiModel[] {
  return models.filter(model => model.verification?.status === 'verified' && ownModelAccess(credentials, model)).map(({ id, label }) => ({ id, label }));
}

export function requesterModelChoices(models: ModelConnection[], defaultModel: string | null, credentials: AiCredentials): ModelConnection[] {
  const usable = models.filter(model => ownModelAccess(credentials, model));
  return [...usable.filter(model => model.id === defaultModel), ...usable.filter(model => model.id !== defaultModel)];
}

export function poolInput(body: Record<string, unknown>, models: ModelConnection[], credentials: AiCredentials): Pick<CommunityPool, 'models' | 'missionsPerDay' | 'draftsPerDay' | 'perUserPerDay'> {
  if (!Array.isArray(body.models) || !body.models.length || body.models.length > POOL_LIMITS.models || body.models.some(id => typeof id !== 'string')) throw new ApiError(400, 'INVALID_INPUT', `Choose one to ${POOL_LIMITS.models} models for the pool.`);
  const ids = [...new Set(body.models as string[])];
  for (const id of ids) {
    const model = models.find(entry => entry.id === id);
    if (!model) throw new ApiError(400, 'POOL_MODEL_UNAVAILABLE', `${id.slice(0, 120)} is not enabled in this workspace.`);
    if (model.verification?.status !== 'verified') throw new ApiError(400, 'POOL_MODEL_UNAVAILABLE', `${model.label} is not verified. Verify it in Settings > AI models first.`);
    if (!ownModelAccess(credentials, model)) throw new ApiError(400, 'POOL_MODEL_UNAVAILABLE', `${model.label} needs this workspace's own AI key or AI Gateway. The pool never uses platform-funded AI.`);
  }
  return {
    models: ids,
    missionsPerDay: integer(body.missionsPerDay, 'Agent runs a day', 0, POOL_LIMITS.missionsPerDay),
    draftsPerDay: integer(body.draftsPerDay, 'Agent answers a day', 0, POOL_LIMITS.draftsPerDay),
    perUserPerDay: integer(body.perUserPerDay, 'Fix requests per person a day', 1, POOL_LIMITS.perUserPerDay),
  };
}

export function assistInput(body: Record<string, unknown>): Pick<AgentAssistSettings, 'triage' | 'review'> {
  if (typeof body.triage !== 'boolean' || typeof body.review !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', 'Set triage and review to true or false.');
  return { triage: body.triage, review: body.review };
}

export interface FundingCatalog { getModelConnections(): Promise<ModelConnection[]>; getAiCredentials(): Promise<AiCredentials> }
export interface FixModelAccess { models(): Promise<ModelConnection[]>; assertModelAllowed(model: ModelConnection): Promise<void>; modelAccess(model: ModelConnection): Promise<ModelRoute> }

export function fixModelAccess(env: AiAccessOptions, fix: FixRequest, catalog: FundingCatalog, pool: () => Promise<CommunityPool | null>): FixModelAccess {
  const models = async () => {
    const registry = await catalog.getModelConnections();
    return registry.filter(model => model.id === fix.model);
  };
  const assertModelAllowed = async (model: ModelConnection) => {
    if (model.id !== fix.model) throw new ApiError(409, 'MODEL_CONNECTION_CHANGED', `This fix request is pinned to ${fix.model}.`);
    assertPinnedModel(await catalog.getModelConnections(), model);
    if (fix.source === 'pool' && !(await pool())?.models.includes(model.id)) throw new ApiError(409, 'POOL_UNAVAILABLE', 'The community AI pool no longer funds this model.');
  };
  return {
    models,
    assertModelAllowed,
    async modelAccess(model) {
      await assertModelAllowed(model);
      return ownModelRoute(env, fix.fundingWorkspaceId, await catalog.getAiCredentials(), model);
    },
  };
}
