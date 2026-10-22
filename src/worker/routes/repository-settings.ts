import { repositoryHead } from '../artifacts';
import { ApiError, assertMutationOrigin, readJson, requireIdempotencyKey, requireString } from '../domain';
import { repositoryLabel } from '../../shared/repository-names';
import { checkSettingsSnapshot, normalizeCheckSettings, samePolicyOverride } from '../check-settings';
import { agentSettingsSnapshot, normalizeAgentSettings } from '../agent-settings';
import { handlePreviewSettings } from '../preview-settings-api';
import { executionReadiness } from '../execution';
import { notifyProposal, proposalOpened } from '../proposal-notifications';
import { listBranches } from '../git-http';
import { branchApi } from '../branches';
import { branchName, effectiveRules, protectionSnapshot } from '../branch-protection';
import { triggerMirrorSync } from '../github-mirror-runtime';
import { changeVisibility, siteOrigin, visibilitySnapshot } from '../public-repositories';
import { visibilityChanged } from '../public-discovery';
import { proposeUpstream } from '../outside-proposals';
import { type RouteContext, records, requireRepository, outsideContext, currentRepository, inBackground } from '../route-context';

export async function repositorySettingsRoutes(context: RouteContext): Promise<Response | null> {
  const { request, url, env, ctx, principal, access, catalog } = context;
  const branchWrite = request.method === 'POST' ? /^\/api\/repositories\/([a-zA-Z0-9-]+)\/branches(?:\/(delete))?$/.exec(url.pathname) : null;
  if (branchWrite) {
    const repository = await requireRepository(catalog, branchWrite[1]);
    const changed = await branchApi(request, { artifacts: env.ARTIFACTS, repository, coordinator: records(env, repository.id), principal, access }, branchWrite[2] ? 'delete' : 'create');
    if (changed.ok) await inBackground(ctx, triggerMirrorSync(env, repository.id, principal.workspaceId, 'branch', undefined, ctx));
    return changed;
  }
  const visibilityRoute = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/visibility$/.exec(url.pathname);
  if (visibilityRoute) {
    const repository = await requireRepository(catalog, visibilityRoute[1]);
    await access.authorize(principal, 'read', 'repository', repository.id);
    if (request.method === 'POST') {
      assertMutationOrigin(request);
      requireIdempotencyKey(request);
      await changeVisibility(env, access, principal, repository, await readJson(request, 4096));
      await visibilityChanged(env, ctx, access, principal, repository, url.origin);
    } else if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST for visibility.');
    return Response.json(await visibilitySnapshot(env, access, principal, repository, siteOrigin(env, url.origin)));
  }
  const checkSettingsRoute = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/check-settings$/.exec(url.pathname);
  if (checkSettingsRoute) {
    const repository = await requireRepository(catalog, checkSettingsRoute[1]);
    const coordinator = records(env, repository.id);
    if (request.method === 'GET') {
      await access.authorize(principal, 'read', 'repository', repository.id);
      return Response.json(checkSettingsSnapshot(repository.id, await coordinator.getCheckSettings(), await coordinator.getCheckDurations()));
    }
    if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST for check settings.');
    assertMutationOrigin(request);
    const key = requireIdempotencyKey(request), body = await readJson(request, 4096);
    await access.authorize(principal, 'land', 'repository', repository.id);
    const input = normalizeCheckSettings(body);
    const current = await coordinator.getCheckSettings();
    const overrideChanged = body.policyOverride !== undefined && !samePolicyOverride(input.policyOverride, current?.policyOverride);
    if (overrideChanged && (principal.role !== 'Owner' || principal.credentialId)) throw new ApiError(403, 'OWNER_REQUIRED', 'Only a workspace Owner can override the check settings of gitflare.json. Leave policyOverride out to keep the current override.');
    if (overrideChanged && input.policyOverride) input.policyOverride = { ...input.policyOverride, updatedAt: new Date().toISOString(), updatedBy: principal.userId };
    else if (!overrideChanged && current?.policyOverride) input.policyOverride = current.policyOverride;
    const saved = await coordinator.setCheckSettings(key, input, principal.userId);
    await access.auditRepositoryChange(principal, overrideChanged ? 'repository.check-settings.policy-override' : 'repository.check-settings', repository.id);
    return Response.json(checkSettingsSnapshot(repository.id, saved, await coordinator.getCheckDurations()));
  }
  const agentSettingsRoute = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/agent-settings$/.exec(url.pathname);
  if (agentSettingsRoute) {
    const repository = await requireRepository(catalog, agentSettingsRoute[1]);
    const coordinator = records(env, repository.id);
    if (request.method === 'GET') {
      await access.authorize(principal, 'read', 'repository', repository.id);
      return Response.json(agentSettingsSnapshot(repository.id, await coordinator.getAgentSettings()));
    }
    if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST for agent settings.');
    assertMutationOrigin(request);
    const key = requireIdempotencyKey(request), body = await readJson(request, 4096);
    await access.authorize(principal, 'land', 'repository', repository.id);
    const saved = await coordinator.setAgentSettings(key, normalizeAgentSettings(body), principal.userId);
    await access.auditRepositoryChange(principal, 'repository.agent-settings', repository.id);
    return Response.json(agentSettingsSnapshot(repository.id, saved));
  }
  const previewSettingsRoute = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/preview-settings$/.exec(url.pathname);
  if (previewSettingsRoute) {
    const repository = await requireRepository(catalog, previewSettingsRoute[1]);
    return handlePreviewSettings(request, env, principal, repository.id, records(env, repository.id));
  }
  const branchRoute = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/(branches|branch-protection|pulls)$/.exec(url.pathname);
  if (branchRoute) {
    const repository = await requireRepository(catalog, branchRoute[1]);
    const coordinator = records(env, repository.id);
    const writing = request.method === 'POST';
    if (!writing && (request.method !== 'GET' || branchRoute[2] === 'pulls')) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use a supported branch operation.');
    await access.authorize(principal, !writing ? 'read' : branchRoute[2] === 'branch-protection' ? 'manage' : 'contribute', 'repository', repository.id);
    if (!writing && branchRoute[2] === 'branch-protection') return Response.json(protectionSnapshot(repository.id, repository.defaultBranch, await coordinator.getBranchProtection()));
    if (!env.ARTIFACTS || repository.provider !== 'artifacts') throw new ApiError(409, 'REPOSITORY_NOT_CONNECTED', 'Connect an Artifacts repository to use streams.');
    if (!writing) return Response.json({ repositoryId: repository.id, defaultBranch: repository.defaultBranch, gitUrl: `${url.origin}/git/${repositoryLabel(repository)}.git`, branches: await listBranches(env.ARTIFACTS, repository, effectiveRules(await coordinator.getBranchProtection(), repository.defaultBranch)) });
    assertMutationOrigin(request);
    const key = requireIdempotencyKey(request), body = await readJson(request, 65_536);
    if (branchRoute[2] === 'branch-protection') { await coordinator.setBranchProtection(key, body.rules, principal.userId); return Response.json(protectionSnapshot(repository.id, repository.defaultBranch, await coordinator.getBranchProtection())); }
    if (body.target !== undefined && body.target !== 'upstream' && body.target !== 'self') throw new ApiError(400, 'INVALID_TARGET', 'Choose upstream or self as the target.');
    if (body.target === 'upstream') return proposeUpstream(outsideContext(context), repository, key, body, siteOrigin(env, url.origin));
    await access.authorize(principal, 'execute', 'repository', repository.id);
    if (!env.MISSION_WORKFLOW || !executionReadiness(env, 'skill-edit').ready) throw new ApiError(503, 'EXECUTION_NOT_CONFIGURED', 'Connect the required services before opening a pull request.');
    const title = requireString(body.title, 'Title', 120), branch = branchName(body.branch);
    const description = body.description === undefined || body.description === '' ? undefined : requireString(body.description, 'Description', 8000);
    if (branch === repository.defaultBranch) throw new ApiError(400, 'INVALID_PULL_REQUEST', 'Choose a branch other than the default branch.');
    const current = await currentRepository(env, repository);
    if (!current.headSha) throw new ApiError(409, 'EMPTY_REPOSITORY', 'Push an initial commit to the default branch first.');
    const headSha = await repositoryHead(env.ARTIFACTS, repository.name, branch).catch(() => null);
    if (!headSha) throw new ApiError(404, 'BRANCH_NOT_FOUND', `Branch ${branch} was not found. Push it first.`);
    if (headSha === current.headSha) throw new ApiError(409, 'NOTHING_TO_MERGE', `${branch} has no commits that are not already on ${repository.defaultBranch}.`);
    const models = await catalog.getModelConnections();
    const authorization = { principal, workspaceId: principal.workspaceId, creatorId: principal.userId };
    const draft = await coordinator.createMission(key, { repositoryId: repository.id, expectedBaseSha: current.headSha, title, prompt: description ?? `Merge ${branch} into ${repository.defaultBranch}.`, branchChange: { branch, headSha, targetBranch: repository.defaultBranch, ...(description ? { description } : {}) } }, authorization, models);
    const started = await coordinator.startMissionWithDispatch(`${key.slice(0, 120)}-start`, draft.id, authorization, models);
    await notifyProposal(env, access, ctx, repository, started, proposalOpened(started, principal.userId));
    return Response.json(started, { status: 202 });
  }
  return null;
}
