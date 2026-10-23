import type { AgentMissionEntry, AgentMissionState, AiSetup, FixQuote, FixRequest, FixRequests, IssuePerson, Mission, MissionSummary, ModelConnection, Repository } from '../shared/types';
import { aiSetupPath, requestChangePath } from '../shared/ai-setup';
import { hostOrigins } from '../shared/hosts';
import { DRAFT_GOAL_MAX } from '../shared/mission-draft';
import { ApiError, assertMutationOrigin, publicError, readJson, requireIdempotencyKey, requireString } from './domain';
import type { AppEnv } from './env';
import { catalogName } from './capacity';
import type { ContributorStanding } from './coordinator';
import type { CommunityPool } from '../shared/types';
import { fixModelAccess, hostedOnly, poolModelChoices, REQUESTER_FIXES_PER_DAY, requesterModelChoices, type StoredPool } from './community-pool';
import { executionReadiness } from './execution';
import { planMission, repositorySnapshot } from './mission-draft';
import { DEFAULT_MODEL } from './model-config';
import { PUBLIC_NOT_FOUND, resolvePublicRepository } from './public-repositories';
import { clientIp, consume, rateLimitedResponse } from './rate-limits';
import { personalWorkspaceId, publicPrincipal, securityClient, type Principal, type SecurityService } from './security';
import type { AiCredentials } from './ai-keys';
import { logFailure } from './log';

const ROUTE = /^\/api\/public\/repos\/([^/]+)\/([^/]+)\/fix-requests$/;
export const FIX_MAX_AGENTS = 2;
const LIST_MAX = 100;

interface UpstreamRecords {
  storedCommunityPool(): Promise<StoredPool | null>;
  communityPool(): Promise<CommunityPool | null>;
  communityPoolRemaining(userId: string): Promise<number | null>;
  reserveCommunityPool(kind: 'request' | 'mission' | 'draft', id: string, userId: string | null): Promise<{ allowed: boolean; reason: string }>;
  contributorStanding(userId: string): Promise<ContributorStanding | null>;
  listMissionSummaries(): Promise<MissionSummary[]>;
  getIssue(number: number): Promise<{ number: number; title: string; body: string; state: string } | undefined>;
  missionForRequest(key: string): Promise<Mission | undefined>;
  createMission(key: string, input: import('../shared/types').CreateMissionInput, authorization?: NonNullable<Mission['authorization']>, models?: ModelConnection[], defaultModel?: string): Promise<Mission>;
  holdFixRequest(id: string): Promise<Mission>;
  startMissionWithDispatch(key: string, id: string, authorization?: NonNullable<Mission['authorization']>, models?: ModelConnection[]): Promise<Mission>;
}
interface Catalog {
  getModelConnections(): Promise<ModelConnection[]>;
  getDefaultModel(): Promise<string | null>;
  getAiCredentials(): Promise<AiCredentials>;
  getAiEnabled(): Promise<boolean>;
  indexMission(id: string, repositoryId: string): Promise<void>;
}

function notFound(): never { throw new ApiError(404, 'NOT_FOUND', PUBLIC_NOT_FOUND); }

function records(env: AppEnv, repositoryId: string): UpstreamRecords { return env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`) as unknown as UpstreamRecords; }
function catalogOf(env: AppEnv, workspaceId: string): Catalog { return env.GITFLARE_COORDINATOR.getByName(catalogName(workspaceId)) as unknown as Catalog; }

export function agentMissionState(mission: Pick<Mission, 'status' | 'fixRequest'>): AgentMissionState {
  if (mission.status === 'integrated') return 'landed';
  if (mission.status === 'cancelled') return 'closed';
  if (mission.status === 'failed') return 'failed';
  if (['needs_review', 'approved', 'integrating'].includes(mission.status)) return 'review';
  if (mission.status === 'draft') return mission.fixRequest?.waiting ? 'waiting' : 'planning';
  return 'running';
}

export function agentMissionEntry(mission: Pick<Mission, 'id' | 'title' | 'status' | 'fixRequest' | 'createdAt' | 'landedSha'>): AgentMissionEntry {
  const fix = mission.fixRequest!;
  return { id: mission.id, title: mission.title, issueNumber: fix.issueNumber ?? null, requester: fix.requester, source: fix.source, state: agentMissionState(mission), createdAt: mission.createdAt, landedSha: mission.landedSha ?? null };
}

async function authorityFor(access: SecurityService, authority: Principal | undefined, repositoryId: string): Promise<Principal | null> {
  if (!authority) return null;
  return access.check(authority, 'land', 'repository', repositoryId).then(() => authority, () => null);
}

interface Funding { source: 'pool' | 'requester'; workspaceId: string; model: ModelConnection; authority: Principal | null; remaining: number | null }
interface Context { env: AppEnv; access: SecurityService; repository: Repository; workspaceId: string; principal: Principal }

function aiReady(env: AppEnv): boolean {
  return env.AI_FEATURES !== 'disabled' && !!env.MISSION_WORKFLOW && executionReadiness({ ...env, MODEL: env.MODEL ?? DEFAULT_MODEL }, 'agent').ready;
}

interface Resolved { funding: Funding | null; reason: string; ownKeyMissing?: boolean }

export async function resolveFunding(context: Context): Promise<Resolved> {
  const { env, access, repository, workspaceId, principal } = context;
  if (!aiReady(env)) return { funding: null, reason: 'Agents are not available on this Gitflare installation right now.' };
  const upstream = catalogOf(env, workspaceId);
  const aiEnabled = await Promise.resolve().then(() => upstream.getAiEnabled()).catch(error => { logFailure('ai_settings_read_failed', error, { workspaceId, repositoryId: repository.id }); return null; });
  if (aiEnabled === null) return { funding: null, reason: "This project's AI setting could not be read, so AI fixes stay off until it can. Try again shortly." };
  if (!aiEnabled) return { funding: null, reason: 'This project has turned AI features off.' };
  const repo = records(env, repository.id);
  const pool = await repo.storedCommunityPool();
  let poolReason = '';
  if (pool && pool.missionsPerDay > 0) {
    const [models, credentials, remaining] = await Promise.all([upstream.getModelConnections(), upstream.getAiCredentials(), repo.communityPoolRemaining(principal.userId)]);
    const [model] = poolModelChoices(pool, models, credentials);
    if (model && (remaining ?? 0) > 0) return { funding: { source: 'pool', workspaceId, model, authority: await authorityFor(access, pool.authority, repository.id), remaining }, reason: 'Uses this project’s community AI pool.' };
    poolReason = model ? 'You have used this project’s requests for today. ' : '';
  }
  if (principal.kind === 'community' && (await access.standing(principal.userId)).limited) return { funding: null, reason: `${poolReason}New accounts can request fixes only where the project funds a community AI pool.` };
  let personal: string;
  try { personal = personalWorkspaceId(principal.userId); } catch { return { funding: null, reason: 'Sign in with your own account to request fixes.' }; }
  const own = catalogOf(env, personal);
  const [models, stored, credentials] = await Promise.all([own.getModelConnections(), own.getDefaultModel(), own.getAiCredentials()]);
  const [model] = requesterModelChoices(models, stored, credentials);
  if (!model) return { funding: null, reason: poolReason ? `${poolReason}Connect your own AI model to send more.` : 'This project doesn’t pay for requests. Connect your own AI model to send one.', ownKeyMissing: true };
  const standing = await repo.contributorStanding(principal.userId);
  return { funding: { source: 'requester', workspaceId: personal, model, authority: await authorityFor(access, standing?.vouchedBy, repository.id), remaining: null }, reason: `Uses your own AI key (${model.label}).` };
}

function quoteOf({ funding, reason }: Resolved, setup: AiSetup | null): FixQuote {
  return { signedIn: true, available: !!funding, source: funding?.source ?? null, model: funding ? { id: funding.model.id, label: funding.model.label } : null, reason, waitsForMaintainer: !!funding && !funding.authority, remainingToday: funding?.remaining ?? null, setup };
}

function unavailable(signedIn: boolean, reason: string): FixQuote {
  return { signedIn, available: false, source: null, model: null, reason, waitsForMaintainer: false, remainingToday: null, setup: null };
}

async function setupFor(request: Request, context: Context, handle: string, name: string): Promise<AiSetup> {
  const { env, access, principal } = context;
  const origin = hostOrigins(env.SITE_ORIGIN, env.APP_ORIGIN)?.app ?? new URL(request.url).origin;
  const handleRequired = !(await requesterPerson(access, principal.userId)).handle;
  return { url: `${origin}${aiSetupPath(requestChangePath(handle, name), handleRequired)}`, handleRequired };
}

async function fixQuote(request: Request, context: Context, handle: string, name: string): Promise<FixQuote> {
  const resolved = await resolveFunding(context);
  return quoteOf(resolved, resolved.ownKeyMissing ? await setupFor(request, context, handle, name) : null);
}

function goalFor(issue: { number: number; title: string; body: string }): string {
  const head = `Fix issue #${issue.number}: ${issue.title}\n\n`;
  const body = issue.body.trim() || 'No description was given.';
  return `${head}${body}`.slice(0, DRAFT_GOAL_MAX);
}

async function requesterPerson(access: SecurityService, userId: string): Promise<IssuePerson> {
  return (await access.profiles([userId]))[userId] ?? { name: 'Gitflare user', handle: null };
}

async function createFixRequest(request: Request, context: Context): Promise<Response> {
  const { env, access, repository, workspaceId, principal } = context;
  hostedOnly(env, 'Requesting fixes');
  assertMutationOrigin(request);
  const key = requireIdempotencyKey(request);
  const body = await readJson(request, 8_192);
  await access.authorize(principal, 'participate', 'repository', repository.id);
  const throttled = await consume(env, 'FIX_REQUEST_RATE_LIMIT', `user:${principal.userId}`);
  if (throttled) return rateLimitedResponse(throttled, 'fix requests');
  const repo = records(env, repository.id);
  const replay = await repo.missionForRequest(key);
  if (replay) {
    if (replay.fixRequest?.requesterId !== principal.userId) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key belongs to another request.');
    return Response.json({ mission: agentMissionEntry(replay), waitingForMaintainer: agentMissionState(replay) === 'waiting' }, { status: 202 });
  }
  if ((body.issueNumber === undefined) === (body.goal === undefined)) throw new ApiError(400, 'INVALID_INPUT', 'Pass either an issue number or a goal.');
  let goal: string; let issueNumber: number | undefined;
  if (body.issueNumber !== undefined) {
    if (!Number.isInteger(body.issueNumber) || (body.issueNumber as number) < 1) throw new ApiError(400, 'INVALID_ISSUE_NUMBER', 'Provide a valid issue number.');
    const issue = await repo.getIssue(body.issueNumber as number);
    if (!issue) throw new ApiError(404, 'ISSUE_NOT_FOUND', 'This issue could not be found.');
    if (issue.state !== 'open') throw new ApiError(409, 'ISSUE_CLOSED', 'Fixes can be requested only for open issues.');
    issueNumber = issue.number; goal = goalFor(issue);
  } else goal = requireString(body.goal, 'Goal', DRAFT_GOAL_MAX, 10);
  const { funding, reason } = await resolveFunding(context);
  if (!funding) throw new ApiError(412, 'AI_SOURCE_REQUIRED', reason);
  if (funding.source === 'pool') {
    const requested = await repo.reserveCommunityPool('request', key, principal.userId);
    if (!requested.allowed) throw new ApiError(429, 'POOL_EXHAUSTED', requested.reason);
    const drafted = await repo.reserveCommunityPool('draft', `${key}:plan`, principal.userId);
    if (!drafted.allowed) throw new ApiError(429, 'POOL_EXHAUSTED', drafted.reason);
  } else {
    try { await access.rateLimit(`fix-request:${principal.userId}`, REQUESTER_FIXES_PER_DAY, 86_400_000); }
    catch (error) { if (error instanceof ApiError && error.code === 'RATE_LIMITED') throw new ApiError(429, 'RATE_LIMITED', `You requested ${REQUESTER_FIXES_PER_DAY} fixes today. Try again tomorrow.`); throw error; }
  }
  const requester = await requesterPerson(access, principal.userId);
  const fixRequest: FixRequest = { requesterId: principal.userId, requester, source: funding.source, fundingWorkspaceId: funding.workspaceId, model: funding.model.id, ...(issueNumber !== undefined ? { issueNumber } : {}), requestedAt: new Date().toISOString() };
  const models = fixModelAccess(env, fixRequest, catalogOf(env, funding.workspaceId), () => repo.communityPool());
  const snapshot = await repositorySnapshot(env.ARTIFACTS, repository);
  let plan: Awaited<ReturnType<typeof planMission>>;
  try { plan = await planMission({ ...env, modelAccess: models.modelAccess }, funding.model, { goal, maxAgents: FIX_MAX_AGENTS, allowedModels: [funding.model] }, snapshot); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, 'DRAFT_FAILED', 'The agent could not plan this fix right now. Try again later.');
  }
  const created = await repo.createMission(key, {
    repositoryId: repository.id, title: (plan.title || goal.split('\n')[0]!).slice(0, 120), prompt: goal, acceptanceCriteria: plan.acceptanceCriteria.slice(0, 12), mode: plan.mode,
    tasks: plan.tasks.slice(0, FIX_MAX_AGENTS).map(({ name, role, task, coordinator }) => ({ name, role, task, ...(coordinator ? { coordinator: true } : {}) })),
    ...(issueNumber !== undefined ? { issueNumber } : {}), fixRequest,
  }, undefined, [funding.model], funding.model.id);
  await catalogOf(env, workspaceId).indexMission(created.id, repository.id);
  let mission = created;
  const authority = funding.authority;
  const missionFunded = funding.source === 'requester' || !authority || (await repo.reserveCommunityPool('mission', `${created.id}:${created.epoch}`, principal.userId)).allowed;
  if (authority && missionFunded && created.status === 'draft' && created.epoch === 0) mission = await repo.startMissionWithDispatch(`${key.slice(0, 120)}-start`, created.id, { principal: authority, workspaceId, creatorId: principal.userId }, [funding.model]);
  else if (created.status === 'draft') mission = await repo.holdFixRequest(created.id);
  await access.auditRepositoryChange(principal, `repository.fix.request.${funding.source}`, repository.id);
  return Response.json({ mission: agentMissionEntry(mission), waitingForMaintainer: agentMissionState(mission) === 'waiting' }, { status: 202 });
}

export async function publicFixRequestsApi(request: Request, env: AppEnv, signedIn: (request: Request) => Promise<Principal | null>): Promise<Response | null> {
  const url = new URL(request.url);
  const match = ROUTE.exec(url.pathname);
  if (!match) return null;
  const read = request.method === 'GET' || request.method === 'HEAD';
  if (!read && request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST.');
  if (read) { const limited = await consume(env, 'PUBLIC_READ_RATE_LIMIT', `ip:${clientIp(request)}`); if (limited) return rateLimitedResponse(limited, 'public repository requests'); }
  let handle: string; let name: string;
  try { handle = decodeURIComponent(match[1]!).toLowerCase(); name = decodeURIComponent(match[2]!); } catch { notFound(); }
  const access = securityClient(env);
  const target = await resolvePublicRepository(env, access, handle, name);
  if (!target) notFound();
  if ('redirect' in target) return new Response(null, { status: 308, headers: { Location: `/api/public/repos/${target.redirect}/${encodeURIComponent(name)}/fix-requests${url.search}` } });
  const { repository, workspaceId } = target;
  const home = await signedIn(request);
  if (!home && !read) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to request a fix.');
  let principal: Principal;
  try { principal = home ? await access.participant(home, workspaceId) : publicPrincipal(workspaceId); }
  catch (error) { if (!read || publicError(error).code !== 'ACCOUNT_REQUIRED') throw error; principal = publicPrincipal(workspaceId); }
  try { await access.check(principal, 'read', 'repository', repository.id); }
  catch (error) { if (publicError(error).code === 'FORBIDDEN') notFound(); throw error; }
  const context: Context = { env, access, repository, workspaceId, principal };
  if (!read) return createFixRequest(request, context);
  const issueText = url.searchParams.get('issue');
  const issue = issueText === null ? null : Number(issueText);
  if (issue !== null && (!Number.isInteger(issue) || issue < 1)) throw new ApiError(400, 'INVALID_ISSUE_NUMBER', 'Provide a valid issue number.');
  const missions = (await records(env, repository.id).listMissionSummaries())
    .filter(mission => mission.fixRequest && (issue === null || mission.fixRequest.issueNumber === issue))
    .slice(0, LIST_MAX).map(agentMissionEntry);
  let quote: FixQuote | null = null;
  if (url.searchParams.get('quote') === '1') {
    if (principal.kind === 'public') quote = unavailable(false, 'Sign in to request a change.');
    else if (env.EDITION === 'self-hosted' || env.DEMO_MODE === 'true') quote = unavailable(true, 'Requesting changes is part of hosted Gitflare.');
    else quote = await fixQuote(request, context, handle, name);
  }
  return Response.json({ missions, quote } satisfies FixRequests);
}

export async function fixStartModels(env: AppEnv, mission: Mission, key: string): Promise<ModelConnection[]> {
  const fix = mission.fixRequest!;
  hostedOnly(env, 'Requesting fixes');
  const repo = records(env, mission.repositoryId);
  const funding = fixModelAccess(env, fix, catalogOf(env, fix.fundingWorkspaceId), () => repo.communityPool());
  const models = await funding.models();
  if (!models.length) throw new ApiError(409, 'MODEL_NOT_CONFIGURED', fix.source === 'pool' ? 'The model this fix was planned with is no longer enabled for the community pool.' : 'The requester no longer has the model this fix was planned with.');
  for (const model of models) await funding.modelAccess(model);
  if (fix.source === 'pool') {
    const reserved = await repo.reserveCommunityPool('mission', key, fix.requesterId);
    if (!reserved.allowed) throw new ApiError(429, 'POOL_EXHAUSTED', reserved.reason);
  }
  return models;
}
