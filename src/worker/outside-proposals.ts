import type { Mission, ModelConnection, OutsideChecksGate, Repository, UpstreamProposal } from '../shared/types';
import { awaitingChecks, notifyProposal, proposalOpened } from './proposal-notifications';
import { pullRequestState, waitingForMaintainer } from '../shared/pull-requests';
import { repositoryLabel } from '../shared/repository-names';
import { ApiError, assertMutationOrigin, readJson, requireIdempotencyKey, requireString } from './domain';
import { branchName } from './branch-protection';
import type { ContributorStanding, OutgoingProposal } from './coordinator';
import { startWithDurableDispatch } from './coordinator';
import type { AppEnv } from './env';
import { executionReadiness } from './execution';
import { upstreamOf } from './forks';
import { publicUrls, siteOrigin } from './public-repositories';
import { consume, rateLimitedResponse } from './rate-limits';
import type { Principal, SecurityService } from './security';

const PROPOSALS_PER_UPSTREAM_PER_DAY = 20;
const OUTPUT_EXCERPT = 4000;

interface UpstreamRecords {
  createMission(key: string, input: import('../shared/types').CreateMissionInput, authorization?: NonNullable<Mission['authorization']>, models?: ModelConnection[]): Promise<Mission>;
  getMission(id: string): Promise<Mission | undefined>;
  contributorStanding(userId: string): Promise<ContributorStanding | null>;
  holdOutsideProposal(id: string, gate: OutsideChecksGate): Promise<Mission>;
  pullRequestAction(key: string, id: string, action: 'update' | 'close' | 'reopen', actorId: string, headSha?: string, clearFor?: Principal): Promise<Mission>;
  startMissionWithDispatch(key: string, id: string, authorization?: NonNullable<Mission['authorization']>, models?: ModelConnection[]): Promise<Mission>;
  settleApprovalClears(missionId?: string, actor?: Principal): Promise<void>;
}
interface ForkRecords {
  recordOutgoingProposal(entry: OutgoingProposal): Promise<void>;
  outgoingProposal(missionId: string): Promise<OutgoingProposal | null>;
  listOutgoingProposals(): Promise<OutgoingProposal[]>;
}
export interface OutsideContext {
  env: AppEnv;
  principal: Principal;
  access: SecurityService;
  catalogOf(workspaceId: string): { getRepository(id: string): Promise<Repository | undefined>; indexMission(missionId: string, repositoryId: string): Promise<void>; getModelConnections(): Promise<ModelConnection[]> };
  records(repositoryId: string): UpstreamRecords & ForkRecords;
}

function hostedOnly(env: AppEnv) {
  if (env.EDITION === 'self-hosted' || env.DEMO_MODE === 'true') throw new ApiError(403, 'HOSTED_ONLY', 'Proposals to public repositories are part of hosted Gitflare.');
}

function signedInAuthor(principal: Principal) {
  if (principal.credentialId || principal.bootstrap || principal.kind) throw new ApiError(403, 'ACCOUNT_REQUIRED', 'Sign in with your account to propose changes upstream.');
}

async function branchHead(env: AppEnv, artifactName: string, branch: string): Promise<string | null> {
  if (!env.ARTIFACTS) throw new ApiError(503, 'REPOSITORY_SETUP_REQUIRED', 'Connect Artifacts first.');
  using source = await env.ARTIFACTS.get(artifactName);
  return (await source.log({ ref: branch, limit: 1 }).catch(() => []))[0]?.hash ?? null;
}

async function vouchingAuthority(context: Pick<OutsideContext, 'access'>, standing: ContributorStanding | null, upstreamId: string): Promise<Principal | null> {
  const vouch = standing?.vouchedBy;
  if (!vouch) return null;
  return await context.access.check(vouch, 'land', 'repository', upstreamId).then(() => vouch, () => null);
}

async function startOrHold(context: OutsideContext, upstream: Repository, mission: Mission, key: string, authorId: string): Promise<Mission> {
  const records = context.records(upstream.id);
  const standing = await records.contributorStanding(authorId);
  const vouch = await vouchingAuthority(context, standing, upstream.id);
  if (!vouch || !context.env.MISSION_WORKFLOW || !executionReadiness(context.env, 'skill-edit').ready) return records.holdOutsideProposal(mission.id, standing?.landed ? 'returning' : 'first-time');
  const models = await context.catalogOf(upstream.workspaceId ?? 'legacy').getModelConnections();
  return startWithDurableDispatch(records, `${key.slice(0, 120)}-start`, mission.id, { principal: vouch, workspaceId: upstream.workspaceId ?? 'legacy', creatorId: authorId }, models);
}

export function upstreamProposalView(mission: Mission, origin: string, upstream: { handle: string; repository: Repository } | null): UpstreamProposal {
  const change = mission.branchChange!;
  return {
    id: mission.id, title: mission.title, ...(change.description ? { description: change.description } : {}), state: pullRequestState(mission), status: mission.status,
    branch: change.branch, headSha: change.headSha, targetBranch: change.targetBranch,
    upstream: { label: upstream ? `${upstream.handle}/${repositoryLabel(upstream.repository)}` : change.source!.label, url: upstream ? publicUrls(origin, upstream.handle, upstream.repository).url : null },
    waitingForMaintainer: waitingForMaintainer(mission), candidateSha: mission.candidateSha, ...(mission.landedSha ? { landedSha: mission.landedSha } : {}),
    checks: mission.checks.map(check => ({ name: check.name, status: check.status, ...(check.output ? { output: check.output.slice(0, OUTPUT_EXCERPT) } : {}) })),
    reviews: (mission.reviews ?? []).map(review => ({ kind: review.kind, body: review.body, ...(review.path ? { path: review.path, line: review.line } : {}), resolved: !!review.resolvedAt, createdAt: review.createdAt })),
    createdAt: mission.createdAt, updatedAt: mission.updatedAt,
  };
}

export async function proposeUpstream(context: OutsideContext, fork: Repository, key: string, body: Record<string, unknown>, origin: string): Promise<Response> {
  const { env, principal, access } = context;
  hostedOnly(env);
  signedInAuthor(principal);
  if (!fork.fork) throw new ApiError(409, 'NOT_A_FORK', 'Only a fork can propose to an upstream repository.');
  const throttled = await consume(env, 'OUTSIDE_PROPOSAL_RATE_LIMIT', `user:${principal.userId}`);
  if (throttled) return rateLimitedResponse(throttled, 'proposals');
  const upstream = await upstreamOf({ env, access, catalogOf: context.catalogOf }, fork);
  if (!upstream) throw new ApiError(404, 'UPSTREAM_UNAVAILABLE', 'The upstream repository is no longer public.');
  const title = requireString(body.title, 'Title', 120), branch = branchName(body.branch);
  const description = body.description === undefined || body.description === '' ? undefined : requireString(body.description, 'Description', 8000);
  const headSha = await branchHead(env, fork.name, branch);
  if (!headSha) throw new ApiError(404, 'BRANCH_NOT_FOUND', `Branch ${branch} was not found in this fork. Push it first.`);
  const target = upstream.repository;
  const baseSha = await branchHead(env, target.name, target.defaultBranch);
  if (!baseSha) throw new ApiError(409, 'EMPTY_REPOSITORY', 'The upstream repository has no commits.');
  if (headSha === baseSha) throw new ApiError(409, 'NOTHING_TO_MERGE', `${branch} has no commits that are not already on ${upstream.handle}/${repositoryLabel(target)}.`);
  try { await access.rateLimit(`outside-proposal:${principal.userId}:${target.id}`, PROPOSALS_PER_UPSTREAM_PER_DAY, 86_400_000); }
  catch (error) { if (error instanceof ApiError && error.code === 'RATE_LIMITED') throw new ApiError(429, 'RATE_LIMITED', `You opened ${PROPOSALS_PER_UPSTREAM_PER_DAY} proposals to this repository today. Try again tomorrow.`); throw error; }
  const forkHandle = await access.handleOf(principal.workspaceId);
  const records = context.records(target.id);
  const created = await records.createMission(key, {
    repositoryId: target.id, title, prompt: description ?? `Merge ${forkHandle ?? 'fork'}:${branch} into ${target.defaultBranch}.`,
    branchChange: { branch, headSha, targetBranch: target.defaultBranch, ...(description ? { description } : {}), source: { workspaceId: principal.workspaceId, repositoryId: fork.id, repositoryName: fork.name, label: `${forkHandle ?? 'fork'}/${repositoryLabel(fork)}`, authorId: principal.userId } },
  });
  if (created.branchChange?.source?.authorId !== principal.userId || created.branchChange.source.repositoryId !== fork.id) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key belongs to another proposal.');
  await context.catalogOf(target.workspaceId ?? 'legacy').indexMission(created.id, target.id);
  await context.records(fork.id).recordOutgoingProposal({ missionId: created.id, upstreamWorkspaceId: target.workspaceId ?? 'legacy', upstreamRepositoryId: target.id, branch, createdAt: created.createdAt });
  const mission = created.epoch === 0 && created.status === 'draft' && !created.branchChange.gate ? await startOrHold(context, target, created, key, principal.userId) : created;
  await access.auditRepositoryChange(principal, 'repository.proposal.upstream', fork.id);
  await (waitingForMaintainer(mission) ? awaitingChecks(env, access, undefined, target, mission) : notifyProposal(env, access, undefined, target, mission, proposalOpened(mission, principal.userId)));
  return Response.json(upstreamProposalView(mission, origin, upstream), { status: 202 });
}

async function ownProposal(context: OutsideContext, fork: Repository, missionId: string) {
  const link = await context.records(fork.id).outgoingProposal(missionId);
  if (!link) throw new ApiError(404, 'PROPOSAL_NOT_FOUND', 'This fork has no such proposal.');
  const mission = await context.records(link.upstreamRepositoryId).getMission(missionId);
  if (!mission || mission.branchChange?.source?.repositoryId !== fork.id) throw new ApiError(404, 'PROPOSAL_NOT_FOUND', 'This fork has no such proposal.');
  return { link, mission };
}

export async function handleUpstreamProposals(request: Request, url: URL, context: OutsideContext & { catalog: { getRepository(id: string): Promise<Repository | undefined> } }): Promise<Response | null> {
  const route = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/upstream-proposals(?:\/([a-zA-Z0-9-]+))?$/.exec(url.pathname);
  if (!route) return null;
  const { principal, access, env } = context;
  const fork = await context.catalog.getRepository(route[1]!);
  if (!fork) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
  await access.authorize(principal, 'read', 'repository', fork.id);
  if (!fork.fork) throw new ApiError(404, 'NOT_A_FORK', 'This repository is not a fork.');
  const origin = siteOrigin(env, url.origin);
  const upstream = await upstreamOf(context, fork);
  if (request.method === 'GET' && !route[2]) {
    const links = (await context.records(fork.id).listOutgoingProposals()).slice(0, 100);
    const missions = await Promise.all(links.map(link => context.records(link.upstreamRepositoryId).getMission(link.missionId)));
    return Response.json({ repositoryId: fork.id, proposals: missions.filter((mission): mission is Mission => !!mission && mission.branchChange?.source?.repositoryId === fork.id).map(mission => upstreamProposalView(mission, origin, upstream)) });
  }
  if (request.method === 'GET') return Response.json(upstreamProposalView((await ownProposal(context, fork, route[2]!)).mission, origin, upstream));
  if (request.method !== 'POST' || !route[2]) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use a supported proposal action.');
  hostedOnly(env);
  assertMutationOrigin(request);
  const key = requireIdempotencyKey(request);
  const body = await readJson(request, 4096);
  signedInAuthor(principal);
  await access.authorize(principal, 'contribute', 'repository', fork.id);
  const action = body.action;
  if (action !== 'update' && action !== 'close' && action !== 'reopen') throw new ApiError(400, 'INVALID_PULL_ACTION', 'Choose update, close or reopen.');
  const { link, mission } = await ownProposal(context, fork, route[2]!);
  const records = context.records(link.upstreamRepositoryId);
  if (action === 'close') {
    const closed = await records.pullRequestAction(key, mission.id, 'close', principal.userId);
    await access.auditRepositoryChange(principal, 'repository.proposal.upstream.close', fork.id);
    return Response.json(upstreamProposalView(closed, origin, upstream));
  }
  if (!upstream) throw new ApiError(404, 'UPSTREAM_UNAVAILABLE', 'The upstream repository is no longer public.');
  const headSha = await branchHead(env, fork.name, mission.branchChange!.branch);
  if (!headSha) throw new ApiError(404, 'BRANCH_NOT_FOUND', `Branch ${mission.branchChange!.branch} no longer exists in this fork.`);
  const standing = await records.contributorStanding(principal.userId);
  const vouch = await vouchingAuthority(context, standing, upstream.repository.id);
  const updated = await records.pullRequestAction(key, mission.id, action, principal.userId, headSha, vouch ?? undefined);
  if (vouch) await Promise.resolve().then(() => records.settleApprovalClears(mission.id, vouch)).catch(() => {});
  const next = await startOrHold(context, upstream.repository, updated, key, principal.userId);
  await access.auditRepositoryChange(principal, `repository.proposal.upstream.${action}`, fork.id);
  if (waitingForMaintainer(next)) await awaitingChecks(env, access, undefined, upstream.repository, next);
  return Response.json(upstreamProposalView(next, origin, upstream));
}

