import { timingSafeEqual } from 'node:crypto';
import { ApiError } from './domain';
import type { AccessLevel } from './client-access';
import type { BuiltDemoHistory } from './demo-git';
import { demoSeedPlan, type DemoRecord, type DemoSeedPlan } from './demo-seed';
import { demoDisabled, type DemoDisabled, type DemoExamples, type DemoFeatureId } from '../shared/demo-features';

export { DEMO_FEATURES, demoDisabled, type DemoDisabled, type DemoFeatureId } from '../shared/demo-features';

export const DEMO_RESET_CRON = '0 3 * * *';
export const DEMO_RESET_TIME = '03:00 UTC';
export const DEMO_RESET_PATH = '/api/demo/reset';
export const DEMO_STATUS_PATH = '/api/demo';
export const DEMO_CONTROL = 'demo:control';
export const DEMO_RESET_STALE_MS = 15 * 60_000;
export const DEMO_WRITE_LIMIT = { max: 20, windowMs: 3_600_000 };
export const SELF_HOSTED_INSTALL_URL = 'https://gitflare.io/docs/install';

export function demoMode(env: { DEMO_MODE?: string }): boolean { return env.DEMO_MODE === 'true'; }

export function assertDemoMode(env: { DEMO_MODE?: string }): void {
  if (!demoMode(env)) throw new ApiError(404, 'NOT_FOUND', 'This API route could not be found.');
}

export interface DemoRestriction { code: 'DEMO_DISABLED'; feature: string; message: string }

export function demoRestriction(feature: string): DemoRestriction {
  return { code: 'DEMO_DISABLED', feature, message: `${feature} is disabled in the demo. The demo is shared by every visitor and resets nightly at ${DEMO_RESET_TIME}. Install the self-hosted edition to use it on your own Cloudflare account: ${SELF_HOSTED_INSTALL_URL}` };
}

export const DEMO_ALLOWED_WRITES: readonly RegExp[] = [
  /^\/api\/session\/logout$/,
  /^\/api\/repositories\/[a-zA-Z0-9-]+\/issues$/,
  /^\/api\/repositories\/[a-zA-Z0-9-]+\/issues\/\d{1,6}\/comment$/,
  /^\/api\/repositories\/[a-zA-Z0-9-]+\/branches$/,
  /^\/api\/missions$/,
];

const FEATURES: [RegExp, string][] = [
  [/^\/api\/(auth\/cloudflare|cloudflare)(\/|$)|\/cloudflare(\/|$)/, 'Connecting Cloudflare'],
  [/\/deployments(\/|$)/, 'Deploying to Cloudflare'],
  [/\/secrets(\/|$)/, 'Managing secrets'],
  [/\/github-mirror(\/|$)/, 'GitHub mirroring'],
  [/^\/api\/(ai-keys|ai-gateway|models|settings\/ai)(\/|$)/, 'Entering AI keys and changing models'],
  [/^\/api\/(access\/invite|invitations)(\/|$)/, 'Sending invitations'],
  [/^\/api\/auth\/(resend-verification|password-reset)/, 'Sending email'],
  [/^\/api\/(access|users|mfa|setup|signup|login|session)(\/|$)/, 'Changing accounts and access'],
  [/^\/api\/missions\/draft$|^\/api\/missions\/[a-zA-Z0-9-]+\/(start|retry-agents|drop-failed-agents|address-review|revert|retry-checks)$/, 'Running AI agents'],
  [/^\/api\/missions\/[a-zA-Z0-9-]+\/(preview|preview-extend)$/, 'Starting previews'],
  [/^\/api\/missions\/[a-zA-Z0-9-]+\/(approve|integrate|revoke|select|pull)$/, 'Approving and landing changes'],
  [/\/(import|url-import)(\/|$)|^\/api\/repositories\/connect$/, 'Importing repositories'],
  [/\/releases(\/|$)/, 'Publishing releases'],
  [/\/(branch-protection|check-settings|agent-settings|preview-settings)$/, 'Changing repository settings'],
  [/\/skills$/, 'Editing agent skills'],
];

function feature(pathname: string): string {
  return FEATURES.find(([pattern]) => pattern.test(pathname))?.[1] ?? 'Changing workspace data';
}

const OUTBOUND_GETS = [/^\/api\/cloudflare\/callback$/, /^\/api\/auth\/cloudflare\/callback$/];

export function demoRouteRestriction(method: string, pathname: string): DemoRestriction | null {
  if (method === 'GET' || method === 'HEAD') return OUTBOUND_GETS.some((pattern) => pattern.test(pathname)) ? demoRestriction('Connecting Cloudflare') : null;
  if (method === 'OPTIONS') return null;
  if (DEMO_ALLOWED_WRITES.some((pattern) => pattern.test(pathname))) return null;
  return demoRestriction(feature(pathname));
}

export function demoGitRestriction(method: string, url: URL): DemoRestriction | null {
  return (method === 'POST' && url.pathname.endsWith('/git-receive-pack')) || url.searchParams.get('service') === 'git-receive-pack' ? demoRestriction('Pushing with Git') : null;
}

export const DEMO_ALLOWED_TOOLS: ReadonlySet<string> = new Set(['gitflare_create_issue', 'gitflare_comment_issue', 'gitflare_create_branch', 'gitflare_create_mission']);

const TOOL_FEATURES: [RegExp, string][] = [
  [/cloudflare/, 'Connecting Cloudflare'], [/deploy/, 'Deploying to Cloudflare'], [/secret/, 'Managing secrets'], [/github_mirror/, 'GitHub mirroring'],
  [/ai_key|ai_gateway|model_connection|ai_settings/, 'Entering AI keys and changing models'], [/manage_access/, 'Changing accounts, access and invitations'],
  [/start_mission|draft_mission|cancel_mission|revert_mission|retry_checks/, 'Running AI agents'], [/preview/, 'Starting previews'],
  [/approve|integrate|revoke|select_candidate|review_mission/, 'Approving and landing changes'], [/import|connect_repository|create_repository/, 'Importing and creating repositories'],
  [/release/, 'Publishing releases'], [/skill/, 'Editing agent skills'], [/branch|pull_request/, 'Changing branches and pull requests'], [/issue/, 'Changing issues'],
];

export function demoToolRestriction(name: string, required: AccessLevel): DemoRestriction | null {
  if (required === 'read' || DEMO_ALLOWED_TOOLS.has(name)) return null;
  return demoRestriction(TOOL_FEATURES.find(([pattern]) => pattern.test(name))?.[1] ?? 'Changing workspace data');
}

export interface DemoDisabledRoute { feature: DemoFeatureId; mode: 'replace' | 'merge'; field?: string; repositoryId?: string }

const REPOSITORY = '\\/api\\/repositories\\/([a-zA-Z0-9-]+)';
const DISABLED_ROUTES: [RegExp, DemoFeatureId, DemoDisabledRoute['mode'], string?][] = [
  [/^\/api\/cloudflare\/installation-credential$/, 'installation-credential', 'replace'],
  [/^\/api\/cloudflare(?:\/(?:status|accounts|resources))?$/, 'cloudflare', 'replace'],
  [new RegExp(`^${REPOSITORY}\\/cloudflare\\/connection(?:\\/(?:accounts|resources))?$`), 'cloudflare', 'replace'],
  [new RegExp(`^${REPOSITORY}\\/cloudflare(?:\\/usage)?$`), 'cloudflare-resources', 'replace'],
  [new RegExp(`^${REPOSITORY}\\/deployments(?:\\/detect)?$`), 'deployments', 'replace'],
  [new RegExp(`^${REPOSITORY}\\/secrets(?:\\/catalog)?$`), 'secrets', 'replace'],
  [new RegExp(`^${REPOSITORY}\\/github-mirror$`), 'github-mirror', 'replace'],
  [new RegExp(`^${REPOSITORY}\\/preview-settings$`), 'previews', 'replace'],
  [new RegExp(`^${REPOSITORY}\\/check-settings$`), 'checks', 'merge'],
  [/^\/api\/models$/, 'ai-models', 'merge'],
  [/^\/api\/ai-keys$/, 'ai-keys', 'merge'],
  [/^\/api\/settings\/ai$/, 'ai-features', 'merge'],
  [/^\/api\/workspace$/, 'ai-features', 'merge', 'ai'],
  [/^\/api\/access$/, 'people', 'merge'],
  [/^\/api\/mcp$/, 'mcp-clients', 'merge'],
  [/^\/api\/workspaces$/, 'workspace-creation', 'merge'],
];

export function demoDisabledRoute(method: string, pathname: string): DemoDisabledRoute | null {
  if (method !== 'GET') return null;
  for (const [pattern, feature, mode, field] of DISABLED_ROUTES) {
    const match = pattern.exec(pathname);
    if (match) return { feature, mode, ...(field ? { field } : {}), ...(match[1] ? { repositoryId: match[1] } : {}) };
  }
  return null;
}

export interface DemoDisabledSnapshot { canManage: false; demo: DemoDisabled; examples?: DemoExamples }

export function demoDisabledSnapshot(feature: DemoFeatureId, examples?: DemoExamples): DemoDisabledSnapshot {
  return { canManage: false, demo: demoDisabled(feature), ...(examples ? { examples } : {}) };
}

export function demoRestrictionError(restriction: DemoRestriction): ApiError { return new ApiError(403, restriction.code, restriction.message); }

export async function demoTokenMatches(supplied: string | undefined, expected: string | undefined): Promise<boolean> {
  if (!supplied || !expected || expected.length < 32) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([supplied, expected].map((value) => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  return timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}

export interface DemoCurrent { generation: number; workspaceId: string; seededAt: string; anchor: string }
export interface DemoControlState { current: DemoCurrent | null; nextGeneration: number; stale: number[]; resetting: { generation: number; startedAt: number } | null }
export interface DemoControlStore { get<T>(key: string): T | undefined; put<T>(key: string, value: T): void }

const CONTROL_KEY = 'demo-control';

export class DemoControlBook {
  constructor(private readonly store: DemoControlStore) {}
  state(): DemoControlState { return this.store.get<DemoControlState>(CONTROL_KEY) ?? { current: null, nextGeneration: 1, stale: [], resetting: null }; }
  claim(now: number, staleMs = DEMO_RESET_STALE_MS): { generation: number; previous: DemoCurrent | null } {
    const state = this.state();
    if (state.resetting && now - state.resetting.startedAt < staleMs) throw new ApiError(409, 'DEMO_RESET_RUNNING', `A demo reset for generation ${state.resetting.generation} started ${Math.round((now - state.resetting.startedAt) / 1000)} seconds ago.`);
    const stale = state.resetting && !state.stale.includes(state.resetting.generation) ? [...state.stale, state.resetting.generation] : state.stale;
    const generation = state.nextGeneration;
    this.store.put(CONTROL_KEY, { ...state, stale, nextGeneration: generation + 1, resetting: { generation, startedAt: now } } satisfies DemoControlState);
    return { generation, previous: state.current };
  }
  finish(current: DemoCurrent): number[] {
    const state = this.state();
    const stale = [...new Set([...state.stale, ...(state.current ? [state.current.generation] : [])])].filter((generation) => generation !== current.generation).sort((a, b) => a - b);
    this.store.put(CONTROL_KEY, { ...state, current, stale, resetting: null } satisfies DemoControlState);
    return stale;
  }
  fail(generation: number): void {
    const state = this.state();
    this.store.put(CONTROL_KEY, { ...state, stale: [...new Set([...state.stale, generation])], resetting: state.resetting?.generation === generation ? null : state.resetting } satisfies DemoControlState);
  }
  cleaned(generations: number[]): void {
    const state = this.state();
    this.store.put(CONTROL_KEY, { ...state, stale: state.stale.filter((generation) => !generations.includes(generation)) } satisfies DemoControlState);
  }
}

export interface DemoResetDeps {
  now(): Date;
  claim(now: number): Promise<{ generation: number; previous: DemoCurrent | null }>;
  finish(current: DemoCurrent): Promise<number[]>;
  fail(generation: number): Promise<void>;
  cleaned(generations: number[]): Promise<void>;
  createRepository(storageName: string, description: string): Promise<void>;
  pushHistory(storageName: string, history: BuiltDemoHistory): Promise<void>;
  importRecords(objectName: string, records: DemoRecord[]): Promise<void>;
  install(plan: DemoSeedPlan): Promise<void>;
  wipeObject(objectName: string): Promise<void>;
  wipeSecurity(workspaceId: string): Promise<void>;
  deleteRepository(storageName: string): Promise<boolean>;
}

export interface DemoResetReport { generation: number; workspaceId: string; anchor: string; repositories: { name: string; headSha: string | null; records: number }[]; catalogRecords: number; cleaned: number[]; cleanupErrors: string[] }

export function demoObjectNames(plan: DemoSeedPlan): string[] {
  return [`catalog:${plan.workspaceId}`, `previews:${plan.workspaceId}`, ...plan.repositories.map((item) => `repository:${item.repository.id}`)];
}

async function wipeGeneration(generation: number, deps: DemoResetDeps): Promise<string[]> {
  const plan = demoSeedPlan(generation, deps.now());
  const errors: string[] = [];
  const attempt = async (label: string, work: () => Promise<unknown>) => { try { await work(); } catch (error) { errors.push(`${label}: ${error instanceof Error ? error.message.slice(0, 200) : 'failed'}`); } };
  for (const name of demoObjectNames(plan)) await attempt(name, () => deps.wipeObject(name));
  await attempt(`security:ws:${plan.workspaceId}`, () => deps.wipeSecurity(plan.workspaceId));
  for (const item of plan.repositories) await attempt(item.repository.name, () => deps.deleteRepository(item.repository.name));
  return errors;
}

export async function resetDemo(deps: DemoResetDeps): Promise<DemoResetReport> {
  const now = deps.now();
  const { generation } = await deps.claim(now.getTime());
  const plan = demoSeedPlan(generation, now);
  try {
    for (const item of plan.repositories) {
      await deps.createRepository(item.repository.name, item.repository.description);
      await deps.pushHistory(item.repository.name, item.history);
      await deps.importRecords(`repository:${item.repository.id}`, item.records);
    }
    await deps.importRecords(`catalog:${plan.workspaceId}`, plan.catalogRecords);
    await deps.install(plan);
  } catch (error) {
    await deps.fail(generation);
    throw error;
  }
  const stale = await deps.finish({ generation, workspaceId: plan.workspaceId, seededAt: now.toISOString(), anchor: plan.anchor });
  const cleaned: number[] = [], cleanupErrors: string[] = [];
  for (const old of stale) {
    const errors = await wipeGeneration(old, deps);
    if (errors.length) cleanupErrors.push(...errors.map((error) => `generation ${old}: ${error}`)); else cleaned.push(old);
  }
  if (cleaned.length) await deps.cleaned(cleaned);
  return {
    generation, workspaceId: plan.workspaceId, anchor: plan.anchor,
    repositories: plan.repositories.map((item) => ({ name: item.repository.displayName ?? item.repository.name, headSha: item.repository.headSha, records: item.records.length })),
    catalogRecords: plan.catalogRecords.length, cleaned, cleanupErrors,
  };
}
