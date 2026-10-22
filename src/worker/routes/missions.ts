import type { Mission, ModelConnection } from '../../shared/types';
import { repositoryHead, validGitSha } from '../artifacts';
import { assertDependencyApproval } from '../dependency-changes';
import { agentRunIds, ApiError, commitMessageInput, missionInput, publicError, requireString, retryGuidance } from '../domain';
import { retryPlan } from '../check-settings';
import { normalizeRetryOverrides } from '../agent-settings';
import { executionReadiness } from '../execution';
import { backgroundState, dispatchBackground, landingWorkflowId, previewWorkflowId, retireMissionPreview } from '../background-work';
import { backgroundPrincipal } from '../deployments';
import { PREVIEW_STEP_MS } from '../budgets';
import { integrationPendingMessage } from '../coordinator';
import type { Action } from '../security';
import { autoDraftRequest, draftMission, draftRequest, planMission, repositorySnapshot } from '../mission-draft';
import { codeownerRequirement, notifyProposal, proposalOpened, proposalReviewed } from '../proposal-notifications';
import { assertReviewClear, REVIEW_VERDICTS, reviewMissionInput } from '../proposal-review';
import { effectiveDefaultModel, resolveModelConnection } from '../model-config';
import { assertModelAccess, assertWorkspaceAi, createModelAccess, reserveOperatorUsage } from '../ai-keys';
import { capabilityHash, mintPreviewToken, PREVIEW_CAPABILITY_MS, previewCapabilityStore, previewTarget } from '../preview-capability';
import { fixStartModels } from '../fix-requests';
import { isOutsideProposal, proposalAuthor } from '../../shared/pull-requests';
import { type RouteContext, records, requireRepository, landingReviewRule, findMission, currentRepository, requireAi } from '../route-context';
import { security } from '../request-auth';

const HOUR_MS = 3_600_000;
const MISSION_DRAFT_LIMIT = { max: 30, windowMs: HOUR_MS };

export async function missionReads(context: RouteContext, match: RegExpExecArray | null): Promise<Response | null> {
  const { request, env, principal, access } = context;
  if (request.method === 'GET' && match && !match[2]) { const {mission,repository} = await findMission(env, match[1], principal.workspaceId); await access.authorize(principal, 'read', 'repository', repository.id, mission.id); return Response.json(mission); }
  if (request.method === 'GET' && match?.[2] === 'attempts') {
    const { repository, mission } = await findMission(env, match[1], principal.workspaceId);
    await access.authorize(principal, 'read', 'repository', repository.id, mission.id);
    return Response.json({ attempts: await records(env, repository.id).listAttempts(mission.id) });
  }
  if (request.method === 'GET' && match?.[2] === 'preview') {
    const { repository, mission } = await findMission(env, match[1], principal.workspaceId);
    await access.authorize(principal, 'read', 'repository', repository.id, mission.id);
    return Response.json(await records(env, repository.id).previewStatus(mission.id));
  }
  return null;
}

export async function missionWrites(context: RouteContext, match: RegExpExecArray | null, key: string, body: Record<string, unknown>): Promise<Response | null> {
  const { url, env, ctx, principal, access, catalog } = context;
  if (url.pathname === '/api/missions/draft') {
    await requireAi(env, catalog);
    const auto = body.mode === 'auto';
    const [models, storedDefault] = await Promise.all([catalog.getModelConnections(), catalog.getDefaultModel()]);
    const draft = auto ? undefined : draftRequest(body);
    const plan = auto ? autoDraftRequest(body, models) : undefined;
    const repositoryId = requireString(body.repositoryId, 'Repository', 100);
    const repository = await requireRepository(catalog, repositoryId);
    await access.authorize(principal, 'contribute', 'repository', repositoryId);
    await security(env).rateLimit(`mission-draft:${principal.userId}`, MISSION_DRAFT_LIMIT.max, MISSION_DRAFT_LIMIT.windowMs);
    const model = resolveModelConnection(models, typeof body.model === 'string' ? body.model : effectiveDefaultModel(models, storedDefault));
    const credentials = await catalog.getAiCredentials();
    assertModelAccess(env, principal.workspaceId, credentials, [model]);
    await reserveOperatorUsage(env, principal.workspaceId, credentials, [model], 'draft', key, catalog);
    const snapshot = await repositorySnapshot(env.ARTIFACTS, repository);
    const modelEnv = { ...env, modelAccess: createModelAccess(env, principal.workspaceId, { getAiCredentials: () => catalog.getAiCredentials() }) };
    try { return Response.json({ ...plan ? await planMission(modelEnv, model, plan, snapshot) : await draftMission(modelEnv, model, draft!, snapshot), baseSha: snapshot.commitSha, model: model.id }); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, 'DRAFT_FAILED', 'The model could not draft this mission right now. Try again, or fill the fields yourself.');
    }
  }
  if (url.pathname === '/api/missions') {
    const input = missionInput(body);
    if (!input.skillChange && !input.revertChange) { await requireAi(env, catalog); assertWorkspaceAi(env, principal.workspaceId, await catalog.getAiCredentials()); }
    const repository = await requireRepository(catalog, input.repositoryId);
    await access.authorize(principal, 'contribute', 'repository', input.repositoryId);
    await currentRepository(env, repository);
    const coordinator = records(env, input.repositoryId);
    const [models, storedDefault] = await Promise.all([catalog.getModelConnections(), catalog.getDefaultModel()]);
    const mission = await coordinator.createMission(key, input, { principal, workspaceId: principal.workspaceId, creatorId: principal.userId }, models, effectiveDefaultModel(models, storedDefault));
    await notifyProposal(env, access, ctx, repository, mission, { ...proposalOpened(mission, principal.userId), watchers: false });
    return Response.json(mission, { status: 201 });
  }
  if (!match) return null;
  let operation = match[2];
  if (operation === 'retry-checks') {
    const { mission, repository } = await findMission(env, match[1], principal.workspaceId);
    await access.authorize(principal, 'land', 'repository', repository.id, mission.id);
    const coordinator = records(env, repository.id);
    const plan = retryPlan(mission, await coordinator.getCheckSettings(), body.adjustment, principal.role === 'Owner');
    if (plan.kind === 'override') {
      await coordinator.setCheckOverride(`${key.slice(0, 100)}-check-override`, mission.id, plan.override, principal.userId);
      await access.auditRepositoryChange(principal, `repository.check-override.retry-${String(body.adjustment)}`, repository.id);
    } else {
      await coordinator.setCheckSettings(`${key.slice(0, 100)}-check-settings`, plan.settings, principal.userId);
      await access.auditRepositoryChange(principal, `repository.check-settings.retry-${String(body.adjustment)}`, repository.id);
    }
    operation = mission.branchChange ? 'pull' : 'start';
    if (mission.branchChange) body.action = 'update';
  }
  let summaryReview: { body: string } | undefined;
  if (operation === 'submit-review') {
    if (!(REVIEW_VERDICTS as readonly string[]).includes(String(body.verdict))) throw new ApiError(400, 'INVALID_REVIEW', 'Choose comment, approve or request changes.');
    if (body.verdict === 'approve') {
      if (body.epoch !== undefined && !Number.isSafeInteger(body.epoch)) throw new ApiError(400, 'INVALID_REVIEW', 'An exact execution attempt is required.');
      summaryReview = { body: body.body === undefined || body.body === '' ? '' : requireString(body.body, 'Review message', 8000) };
      operation = 'approve';
    } else {
      body.action = body.verdict;
      body.summary = true;
      operation = 'review';
    }
    delete body.verdict;
  }
  if (operation === 'run-checks') {
    const { mission } = await findMission(env, match[1], principal.workspaceId);
    if (!mission.branchChange) throw new ApiError(409, 'NOT_A_PULL_REQUEST', 'Only a proposal from a stream has checks to run.');
    operation = 'pull';
    body.action = mission.branchChange.closedAt ? 'reopen' : 'update';
  }
  if (operation && operation !== 'attempts') {
    const { mission, repository } = await findMission(env, match[1], principal.workspaceId);
    if (isOutsideProposal(mission) && ['start', 'retry-agents', 'drop-failed-agents', 'address-review'].includes(operation)) { operation = 'pull'; body.action = 'update'; }
    const coordinator = records(env, repository.id);
    const reviewInput = operation === 'review' ? reviewMissionInput(body) : undefined;
    if (reviewInput?.action === 'approve') throw new ApiError(400, 'INVALID_REVIEW', 'Approve through the approval action.');
    const pullAction = operation === 'pull' ? body.action : undefined;
    if (operation === 'pull' && !['update', 'close', 'reopen'].includes(String(pullAction))) throw new ApiError(400, 'INVALID_PULL_ACTION', 'Choose update, close or reopen.');
    const action: Action = reviewInput ? (reviewInput.action === 'comment' ? 'contribute' : 'review') : operation === 'start' || operation === 'retry-agents' || operation === 'drop-failed-agents' || operation === 'address-review' || operation === 'revert' || (pullAction && pullAction !== 'close') ? 'execute' : ['approve', 'revoke', 'select'].includes(operation) ? 'review' : operation === 'integrate' || operation === 'preview-extend' ? 'land' : operation === 'preview' ? 'read' : 'contribute';
    try { await access.authorize(principal, action, 'repository', repository.id, mission.id); }
    catch (error) {
      if (reviewInput?.action !== 'comment' || publicError(error).code !== 'FORBIDDEN') throw error;
      await access.authorize(principal, 'review', 'repository', repository.id, mission.id);
    }
    if (reviewInput) {
      const reviewed = await coordinator.reviewMission(key, mission.id, reviewInput, principal.userId, principal);
      await coordinator.settleApprovalClears(mission.id, principal);
      const event = reviewInput.action === 'resolve' ? null : proposalReviewed(reviewed, principal.userId, reviewInput.action, reviewInput.body, !!reviewInput.summary);
      if (event) await notifyProposal(env, access, ctx, repository, reviewed, event);
      return Response.json(reviewed);
    }
    if (operation === 'cancel') { const cancelled = await coordinator.cancelMission(key, mission.id); await retireMissionPreview(env, repository.id, mission.id, principal.workspaceId); return Response.json(cancelled); }
    if (operation === 'pull') {
      if (!mission.branchChange) throw new ApiError(409, 'NOT_A_PULL_REQUEST', 'This mission is not a pull request.');
      if (pullAction === 'close') { const closed = await coordinator.pullRequestAction(key, mission.id, 'close', principal.userId, undefined, principal); await coordinator.settleApprovalClears(mission.id, principal); await retireMissionPreview(env, repository.id, mission.id, principal.workspaceId); await notifyProposal(env, access, ctx, repository, closed, { id: `proposal:${repository.id}:${mission.id}:closed:${closed.branchChange?.closedAt ?? closed.updatedAt}`, event: 'closed', actorId: principal.userId, subscribe: [{ userId: principal.userId, reason: 'participant' }], thread: true }); return Response.json(closed); }
      await access.authorize(principal, 'contribute', 'repository', repository.id, mission.id);
      if (isOutsideProposal(mission)) await access.authorize(principal, 'land', 'repository', repository.id, mission.id);
      if (!env.MISSION_WORKFLOW || !executionReadiness(env, 'skill-edit').ready || !env.ARTIFACTS) throw new ApiError(503, 'EXECUTION_NOT_CONFIGURED', 'Connect the required services before running pull request checks.');
      await currentRepository(env, repository);
      const headSha = await repositoryHead(env.ARTIFACTS, mission.branchChange.source?.repositoryName ?? repository.name, mission.branchChange.branch).catch(() => null);
      if (!headSha) throw new ApiError(404, 'BRANCH_NOT_FOUND', `Branch ${mission.branchChange.branch} no longer exists${isOutsideProposal(mission) ? ' in the contributor’s fork' : ''}.`);
      await coordinator.pullRequestAction(key, mission.id, pullAction as 'update' | 'reopen', principal.userId, headSha, principal);
      await coordinator.settleApprovalClears(mission.id, principal);
      const authorization = { principal, workspaceId: principal.workspaceId, creatorId: proposalAuthor(mission) ?? principal.userId };
      return Response.json(await coordinator.startMissionWithDispatch(`${key.slice(0, 120)}-start`, mission.id, authorization, await catalog.getModelConnections()), { status: 202 });
    }
    if (operation === 'select') {
      if (!Number.isInteger(body.epoch)) throw new ApiError(400, 'INVALID_INPUT', 'Include the attempt number this selection applies to.');
      const selected = await coordinator.selectCandidate(key, mission.id, requireString(body.runId, 'Agent run', 100), body.epoch as number, principal.userId, principal);
      await coordinator.settleApprovalClears(mission.id, principal);
      return Response.json(selected);
    }
    if (operation === 'preview-stop') {
      const stopped = await retireMissionPreview(env, repository.id, mission.id, principal.workspaceId);
      if (stopped === 'none') throw new ApiError(409, 'PREVIEW_NOT_RUNNING', 'This mission has no running preview to stop.');
      await access.auditRepositoryChange(principal, 'mission.preview.stopped', mission.id);
      return Response.json(await coordinator.previewStatus(mission.id));
    }
    if (operation === 'preview-extend') {
      const extension = await coordinator.extendPreview(mission.id);
      if (extension.sandboxName) await env.SANDBOX?.getByName(extension.sandboxName).expireAt(extension.expiresAt);
      await catalog.holdPreviewSlot(mission.id, extension.expiresAt);
      await access.auditRepositoryChange(principal, 'mission.preview.extended', mission.id);
      return Response.json(await coordinator.previewStatus(mission.id));
    }
    if (operation === 'preview') {
      if (!env.PREVIEW_ORIGIN || !env.SANDBOX || !env.ARTIFACTS) throw new ApiError(503, 'PREVIEW_NOT_CONFIGURED', 'Configure the isolated preview service before creating a preview.');
      const target = previewTarget(env.PREVIEW_ORIGIN, url.origin);
      if (!mission.candidateSha || !mission.checks.some((check) => check.candidateSha === mission.candidateSha && check.status === 'passed') || mission.checks.some((check) => check.status !== 'passed')) throw new ApiError(409, 'CHECKS_REQUIRED', 'The current integration candidate must pass verification before preview.');
      if (!env.MISSION_WORKFLOW) throw new ApiError(503, 'PREVIEW_NOT_CONFIGURED', 'Configure the Mission Workflow before creating a preview.');
      const reserved = await catalog.reservePreviewSlot(mission.id, Date.now() + PREVIEW_STEP_MS);
      let claim: Awaited<ReturnType<typeof coordinator.claimPreview>>;
      try { claim = await coordinator.claimPreview(key, mission.id, mission.epoch, mission.candidateSha); }
      catch (error) { if (reserved) await catalog.releasePreviewSlot(mission.id); throw error; }
      if (claim.previous) await env.SANDBOX.getByName(claim.previous).destroy().catch(() => {});
      if (claim.worker) return Response.json({ status: 'ready', kind: 'worker', candidateSha: mission.candidateSha, expiresAt: new Date(claim.expiresAt ?? Date.now()).toISOString(), previewUrl: claim.worker.previewUrl ?? claim.worker.deploymentUrl, deploymentUrl: claim.worker.deploymentUrl, previewName: claim.worker.previewName, notes: claim.worker.notes, ...(claim.worker.d1Databases?.length ? { d1Databases: claim.worker.d1Databases } : {}), ...(claim.worker.host ? { host: claim.worker.host } : {}), access: claim.worker.host?.access ?? 'link' });
      const sandboxName = claim.sandboxName;
      if (!sandboxName) {
        if (claim.claimed && await dispatchBackground(env.MISSION_WORKFLOW, previewWorkflowId(claim.claimId), { kind: 'preview', repositoryId: repository.id, missionId: mission.id, epoch: mission.epoch, candidateSha: mission.candidateSha, claimId: claim.claimId, principal }) === 'missing') {
          if (await coordinator.previewFailed(mission.id, claim.claimId)) await catalog.releasePreviewSlot(mission.id);
          throw new ApiError(503, 'PREVIEW_NOT_STARTED', 'The preview could not be scheduled. Try again.');
        }
        return Response.json(await coordinator.previewStatus(mission.id), { status: 202 });
      }
      const current = await coordinator.getMission(mission.id);
      if (!current || current.epoch !== mission.epoch || current.candidateSha !== mission.candidateSha || !['needs_review', 'approved', 'integrating', 'integrated'].includes(current.status)) throw new ApiError(409, 'STALE_PREVIEW', 'The candidate changed while the preview was starting.');
      const token = mintPreviewToken(principal.workspaceId);
      const expiresAt = Math.min(Date.now() + PREVIEW_CAPABILITY_MS, claim.expiresAt ?? Infinity);
      await access.check(principal, 'read', 'repository', repository.id, mission.id);
      await env.GITFLARE_COORDINATOR.getByName(previewCapabilityStore(principal.workspaceId)).savePreviewCapability(await capabilityHash(token), { workspaceId: principal.workspaceId, principal, repositoryId: repository.id, missionId: mission.id, epoch: mission.epoch, candidateSha: mission.candidateSha, sandboxName, expiresAt, host: target.host, isolated: target.isolated });
      return Response.json({ status: 'ready', kind: 'container', access: 'members', previewUrl: `${target.origin}/open/${token}`, candidateSha: mission.candidateSha, expiresAt: new Date(claim.expiresAt ?? expiresAt).toISOString(), linkExpiresAt: new Date(expiresAt).toISOString(), ...(claim.notes?.length ? { notes: claim.notes } : {}), ...(claim.setup ? { setup: claim.setup } : {}) });
    }
    if (operation === 'revert') {
      await access.authorize(principal, 'contribute', 'repository', repository.id);
      if (mission.status !== 'integrated' || !mission.candidateSha || !mission.baseSha) throw new ApiError(409, 'NOT_LANDED', 'Only a landed mission can be reverted.');
      if (!env.MISSION_WORKFLOW || !executionReadiness(env, 'skill-edit').ready) throw new ApiError(503, 'EXECUTION_NOT_CONFIGURED', 'Connect the required services before reverting.');
      const current = await currentRepository(env, repository);
      const models = await catalog.getModelConnections();
      const authorization = { principal, workspaceId: principal.workspaceId, creatorId: principal.userId };
      const draft = await coordinator.createMission(key, { repositoryId: repository.id, expectedBaseSha: current.headSha ?? undefined, title: `Revert: ${mission.title}`.slice(0, 120), prompt: `Undo the change that mission "${mission.title}" landed as commit ${mission.landedSha ?? mission.candidateSha}, restoring the files it changed to commit ${mission.baseSha}. Later commits stay in place.`, revertChange: { missionId: mission.id, title: mission.title.slice(0, 120), landedSha: mission.landedSha ?? mission.candidateSha, previousSha: mission.baseSha } }, authorization, models);
      const started = await coordinator.startMissionWithDispatch(`${key.slice(0, 120)}-start`, draft.id, authorization, models);
      return Response.json(started, { status: 202 });
    }
    if (operation === 'start' || operation === 'retry-agents' || operation === 'drop-failed-agents' || operation === 'address-review') {
      const runIds = operation === 'retry-agents' || operation === 'address-review' ? agentRunIds(body.runIds) : undefined;
      const guidance = operation === 'retry-agents' || operation === 'address-review' ? retryGuidance(body.guidance) : undefined;
      if (body.guidance !== undefined && operation !== 'retry-agents' && operation !== 'address-review') throw new ApiError(400, 'INVALID_INPUT', 'guidance applies only to retrying failed agents or addressing a review.');
      if (body.overrides !== undefined && operation !== 'retry-agents') throw new ApiError(400, 'INVALID_INPUT', 'overrides apply only to retrying failed agents.');
      const overrides = operation === 'retry-agents' ? normalizeRetryOverrides(body.overrides, runIds ?? []) : undefined;
      let fixModels: ModelConnection[] | undefined;
      if (mission.fixRequest) {
        await access.authorize(principal, 'land', 'repository', repository.id, mission.id);
        if (overrides && Object.values(overrides).some((override) => override.model)) throw new ApiError(400, 'INVALID_INPUT', 'A requested fix keeps the model it was funded with.');
        await requireAi(env, catalog);
        fixModels = await fixStartModels(env, mission, `${mission.id}:${mission.epoch}`);
      } else if (!mission.skillChange && !mission.revertChange && !mission.branchChange) {
        await requireAi(env, catalog);
        const credentials = await catalog.getAiCredentials();
        assertWorkspaceAi(env, principal.workspaceId, credentials);
        const enabled = overrides && Object.values(overrides).some((override) => override.model) ? await catalog.getModelConnections() : [];
        const models = [...mission.runs.flatMap(run => run.modelConfig ? [run.modelConfig] : []), ...Object.values(overrides ?? {}).flatMap((override) => override.model ? [resolveModelConnection(enabled, override.model)] : [])];
        assertModelAccess(env, principal.workspaceId, credentials, models);
        await reserveOperatorUsage(env, principal.workspaceId, credentials, models, 'mission', `${mission.id}:${mission.epoch}`, catalog);
      }
      const readiness = executionReadiness(env, mission.skillChange || mission.revertChange || mission.branchChange ? 'skill-edit' : 'agent');
      if (!readiness.ready || !env.MISSION_WORKFLOW) throw new ApiError(503, 'EXECUTION_NOT_CONFIGURED', `Connect the required services before running agents: ${[...readiness.missing, ...(!env.MISSION_WORKFLOW ? ['Mission Workflow'] : [])].join(', ')}.`);
      const current = await currentRepository(env, repository);
      if (!current.headSha) throw new ApiError(409, 'EMPTY_REPOSITORY', 'Push an initial commit before starting a mission.');
      const authorization = { principal, workspaceId: principal.workspaceId, creatorId: proposalAuthor(mission) ?? principal.userId };
      const models = fixModels ?? await catalog.getModelConnections();
      const started = operation === 'start' ? await coordinator.startMissionWithDispatch(key, mission.id, authorization, models) : await coordinator.retryAgents(key, mission.id, operation === 'retry-agents' ? 'retry' : operation === 'address-review' ? 'review' : 'drop', runIds, authorization, models, guidance, overrides);
      return Response.json(started, { status: 202 });
    }
    const candidateSha = requireString(body.candidateSha, 'Candidate commit', 40, 40);
    const baseSha = requireString(body.baseSha, 'Base commit', 40, 40);
    if (!validGitSha(candidateSha) || !validGitSha(baseSha)) throw new ApiError(400, 'INVALID_COMMIT', 'Commit identifiers must be 40 lowercase hexadecimal characters.');
    if (body.commitMessage !== undefined && operation !== 'approve' && operation !== 'integrate') throw new ApiError(400, 'INVALID_INPUT', 'commitMessage applies only to approving or landing.');
    const commitMessage = commitMessageInput(body.commitMessage);
    if (operation === 'revoke') { const result = await coordinator.revokeApproval(key, mission.id, candidateSha, baseSha, principal); await coordinator.settleApprovalClears(mission.id, principal); return Response.json(result); }
    const current = await currentRepository(env, repository);
    if (operation === 'integrate') {
      if (!env.SANDBOX || !env.ARTIFACTS || !env.MISSION_WORKFLOW) throw new ApiError(503, 'EXECUTION_NOT_CONFIGURED', 'Connect Artifacts, Sandbox and the Mission Workflow before integrating.');
      const rule = await landingReviewRule(env, repository);
      await access.assertLand(principal, mission.id, candidateSha, baseSha, mission.epoch, repository.id, rule, await codeownerRequirement(env, access, repository, mission, rule));
      const claim = await coordinator.beginIntegration(key, mission.id, candidateSha, baseSha, commitMessage, principal.userId, isOutsideProposal(mission) && !principal.credentialId && !principal.bootstrap ? backgroundPrincipal(principal) : undefined);
      if (claim.mission.status === 'integrated') return Response.json(claim.mission);
      if (!claim.claimId) throw new ApiError(500, 'INTEGRATION_CLAIM_MISSING', 'The integration claim could not be established.');
      if (!claim.claimed) {
        if (current.headSha && current.headSha === (claim.landedSha ?? candidateSha)) return Response.json(await coordinator.completeIntegration(mission.id, claim.mission.epoch, current.headSha, claim.claimId));
        if (await backgroundState(env.MISSION_WORKFLOW, landingWorkflowId(claim.claimId)) === 'running') return Response.json(claim.mission, { status: 202 });
        if (await coordinator.releaseStaleIntegration(mission.id, claim.claimId)) throw new ApiError(409, 'INTEGRATION_RELEASED', 'An earlier landing attempt ended without updating the canonical branch. Its claim was released; retry landing.');
        throw new ApiError(409, 'INTEGRATION_PENDING', integrationPendingMessage(candidateSha));
      }
      if (await dispatchBackground(env.MISSION_WORKFLOW, landingWorkflowId(claim.claimId), { kind: 'land', repositoryId: repository.id, missionId: mission.id, epoch: claim.mission.epoch, candidateSha, baseSha, claimId: claim.claimId, principal }) === 'missing') {
        await coordinator.integrationFailed(mission.id, claim.mission.epoch, claim.claimId, 'not_pushed', 'the landing Workflow could not be scheduled');
        throw new ApiError(503, 'INTEGRATION_NOT_STARTED', 'Landing could not be scheduled and nothing was pushed. Retry landing.');
      }
      return Response.json(claim.mission, { status: 202 });
    }
    if (summaryReview && body.epoch !== undefined && body.epoch !== mission.epoch) throw new ApiError(409, 'STALE_REVIEW', 'This review belongs to another revision. Refresh the proposal.');
    assertReviewClear(mission);
    if (body.approveDependencies !== undefined && typeof body.approveDependencies !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', 'approveDependencies must be true or false.');
    const approveDependencies = body.approveDependencies === true;
    assertDependencyApproval(mission, principal.role, approveDependencies);
    await coordinator.settleApprovalClears(mission.id, principal);
    const rule = await landingReviewRule(env, repository);
    const approval = await access.recordApproval(principal, mission.id, candidateSha, baseSha, mission.epoch, mission.checks, proposalAuthor(mission), rule, await codeownerRequirement(env, access, repository, mission, rule));
    if (mission.dependencyChanges?.length) await access.auditRepositoryChange(principal, 'mission.dependencies.approved', mission.id);
    const approved: Mission & { approval?: typeof approval } = !approval.ready ? { ...(commitMessage === undefined ? mission : await coordinator.setLandingMessage(mission.id, candidateSha, baseSha, commitMessage, principal.userId)), approval } : await coordinator.approveMission(key, mission.id, candidateSha, baseSha, principal.userId, principal.role === 'Owner' && approveDependencies, commitMessage);
    const result = summaryReview ? { ...await coordinator.reviewMission(`${key.slice(0, 100)}-summary`, mission.id, { action: 'approve', summary: true, epoch: mission.epoch, candidateSha, baseSha, body: summaryReview.body }, principal.userId, principal), ...(approved.approval ? { approval: approved.approval } : {}) } : approved;
    const event = summaryReview ? proposalReviewed(result, principal.userId, 'approve', summaryReview.body, true) : { id: `proposal:${repository.id}:${mission.id}:approved:${mission.epoch}:${principal.userId}`, event: 'approved' as const, subscribe: [{ userId: principal.userId, reason: 'reviewer' }], thread: true };
    if (event) await notifyProposal(env, access, ctx, repository, result, { ...event, actorId: principal.userId });
    return Response.json(result);
  }
  return null;
}
