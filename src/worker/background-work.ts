import { ApiError } from './domain';
import { securityClient, type Principal } from './security';
import type { AppEnv } from './env';
import { repositoryHead } from './artifacts';
import { landingRule } from './branch-protection';
import { LANDING_STEP_MS, PREVIEW_STEP_MS } from './budgets';
import { catalogName } from './capacity';
import { PREVIEW_HEARTBEAT_MS, type PreviewHost, type StoppedPreview, type WorkerPreviewRecord } from './coordinator';
import { buildLandedWorker, integrateCandidate, IntegrationFailure, prepareCandidatePreview, PreviewFailure } from './execution';
import { deleteWorkerPreview, previewAlias, upsertWorkerPreview, WorkerPreviewError, type WorkerPreviewsConfig } from './worker-previews';
import { resolveWorkerPreviewsConfig } from './installation-credential';
import { WorkerBuildFailure } from './worker-bundle';
import { changedPaths } from './deploy-changes';
import { automaticPromotion, deployWorkflowId, landedDeployments, landingDeploySummary, policyDeployTargets, runDeployment, selfWorker, wranglerEnvironment, type DeploymentRecord, type DeployParams } from './deployments';
import { cloudflareDeployClient, type CloudflareDeployAccess } from './cloudflare-deploy';
import { bindPreviewD1, deletePreviewD1 } from './preview-d1';
import { cloudflareDeployAccess, cloudflareWorkerDeployer } from './cloudflare';
import { previewLifetimeMs } from './preview-settings';
import { candidateWorkerTarget, previewTarget, resolvePreviewHost, usedContainerFallback, workerPreviewSetup, type PreviewTarget, type ProjectWorkers } from './preview-host';
import { isPreviewSetupCode, type PreviewSetupCode } from '../shared/preview-setup';
import { ensurePreviewAccess } from './preview-access';
import { previewAccessIncludes } from './preview-settings-api';
import { POLICY_FILE } from './repository-policy';
import type { ProjectSnapshot } from './cloudflare-projects';
import { declaresRoutes, detectDeploySetup, environmentBlock, parseWranglerConfig, scanRepository, withAccountFacts, type DetectedSetup, type EnvironmentAccount } from './deploy-detect';
import type { Repository } from '../shared/types';
import { triggerMirrorSync } from './github-mirror-runtime';
import { previewSecretBindings } from './repository-secrets';

export interface LandingParams { kind: 'land'; repositoryId: string; missionId: string; epoch: number; candidateSha: string; baseSha: string; claimId: string; principal: Principal }
export interface PreviewParams { kind: 'preview'; repositoryId: string; missionId: string; epoch: number; candidateSha: string; claimId: string; principal: Principal }
export interface PreviewRetireParams { kind: 'preview-retire'; repositoryId: string; missionId: string; previewName: string; workspaceId: string; d1DatabaseIds?: string[]; host?: PreviewHost; principal?: Principal }
export interface StepConfig { retries?: { limit: number; delay: string | number; backoff?: 'constant' | 'linear' | 'exponential' }; timeout?: string | number }
export interface StepRunner { do<T>(name: string, config: StepConfig, callback: () => Promise<T>): Promise<T>; sleep?(name: string, duration: number): Promise<void> }
interface WorkflowBinding<P> {
  create(options: { id: string; params: P }): Promise<unknown>;
  get(id: string): Promise<{ status(): Promise<{ status: string }> }>;
}
type LandingOutcome = { kind: 'stale' } | { kind: 'pushed'; sha: string } | { kind: 'failed'; outcome: 'not_pushed' | 'unknown'; reason: string };
export type BackgroundState = 'running' | 'finished' | 'missing';

const ACTIVE = ['queued', 'running', 'paused', 'waiting', 'waitingForPause'];

export const landingWorkflowId = (claimId: string) => `land-${claimId}`;
export const previewWorkflowId = (claimId: string) => `preview-${claimId}`;
export const previewRetireWorkflowId = (claimId: string) => `preview-retire-${claimId}`;

export async function backgroundState<P>(workflow: WorkflowBinding<P>, id: string): Promise<BackgroundState> {
  try { return ACTIVE.includes((await (await workflow.get(id)).status()).status) ? 'running' : 'finished'; }
  catch { return 'missing'; }
}

export async function dispatchBackground<P>(workflow: WorkflowBinding<P>, id: string, params: P): Promise<BackgroundState> {
  try {
    await workflow.create({ id, params });
    return 'running';
  } catch { return backgroundState(workflow, id); }
}

function staleExecution(error: unknown): boolean { return error instanceof Error && /STALE_EXECUTION/.test(error.message); }

export async function landCandidate(env: AppEnv, params: LandingParams, step: StepRunner): Promise<void> {
  const { repositoryId, missionId, epoch, candidateSha, baseSha, claimId, principal } = params;
  const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`);
  const access = securityClient(env);
  const push = (name: string, integrationAttemptId: string) => step.do(name, { retries: { limit: 0, delay: '1 second' }, timeout: LANDING_STEP_MS }, async (): Promise<LandingOutcome> => {
    const [claim, mission, repository] = await Promise.all([coordinator.integrationClaim(), coordinator.getMission(missionId), coordinator.getRepository(repositoryId)]);
    if (claim?.claimId !== claimId || !mission || !repository || mission.status !== 'integrating') return { kind: 'stale' };
    // A replayed step must not push again once the claim recorded a push attempt
    if (claim.phase === 'pushing') return { kind: 'failed', outcome: 'unknown', reason: 'An earlier landing step had already started the canonical push' };
    try {
      const result = await integrateCandidate(env, {
        repository, mission, integrationAttemptId,
        beforePush: (landedSha) => coordinator.claimIntegrationPush(missionId, epoch, claimId, landedSha),
        assertAuthority: async () => {
          await access.check(principal, 'land', 'repository', repositoryId, missionId);
          await access.assertLand(principal, missionId, candidateSha, baseSha, epoch, repositoryId, landingRule(await coordinator.getBranchProtection(), repository.defaultBranch));
        },
      });
      return { kind: 'pushed', sha: result.sha };
    } catch (error) {
      return error instanceof IntegrationFailure ? { kind: 'failed', outcome: error.outcome, reason: error.message } : { kind: 'failed', outcome: 'unknown', reason: 'Landing failed with an unexpected error' };
    }
  });
  const first = await push('push approved candidate', claimId);
  if (first.kind === 'stale') return;
  const retrying = first.kind === 'failed' && first.outcome === 'not_pushed' && await step.do('retry landing that pushed nothing', { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, async () => {
    const repository = await coordinator.getRepository(repositoryId);
    if (!repository || !env.ARTIFACTS) throw new Error('Repository services are unavailable');
    if (await repositoryHead(env.ARTIFACTS, repository.name, repository.defaultBranch) !== baseSha) return false;
    return coordinator.retryIntegration(missionId, epoch, claimId, first.reason);
  });
  const settled = retrying ? await push('push approved candidate on a fresh runner', `${claimId}-retry`) : first;
  if (settled.kind === 'stale') return;
  const landed: string | boolean | null = await step.do<string | null>('record landing outcome', { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, async () => {
    const repository = await coordinator.getRepository(repositoryId);
    if (!repository || !env.ARTIFACTS) throw new Error('Repository services are unavailable');
    const head = settled.kind === 'pushed' ? settled.sha : await repositoryHead(env.ARTIFACTS, repository.name, repository.defaultBranch).catch(() => null);
    const claim = settled.kind === 'pushed' ? undefined : await coordinator.integrationClaim();
    const expected = settled.kind === 'pushed' ? settled.sha : claim?.claimId === claimId && claim.landedSha ? claim.landedSha : candidateSha;
    try {
      if (head === expected) {
        await coordinator.completeIntegration(missionId, epoch, expected, claimId);
        const catalog = env.GITFLARE_COORDINATOR.getByName(catalogName(principal.workspaceId));
        const listed = await catalog.getRepository(repositoryId);
        if (listed) await catalog.saveRepository({ ...listed, headSha: expected, updatedAt: new Date().toISOString() });
        return expected;
      }
      const failure = settled.kind === 'failed' ? settled : { outcome: 'unknown' as const, reason: `The default branch did not show pushed commit ${expected.slice(0, 12)}` };
      await coordinator.integrationFailed(missionId, epoch, claimId, failure.outcome, failure.reason);
    } catch (error) { if (!staleExecution(error)) throw error; }
    return null;
  });
  if (!landed) return;
  // Workflows started before landed SHAs were recorded replay a cached `true`
  const landedSha = typeof landed === 'string' ? landed : candidateSha;
  await step.do('retire candidate preview and schedule deployment', { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, async () => {
    await retireMissionPreview(env, repositoryId, missionId, principal.workspaceId);
    await scheduleLandedDeployment(env, repositoryId, missionId, epoch, landedSha, baseSha);
    return true;
  });
  await step.do('schedule GitHub mirror sync', { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '1 minute' }, async () => {
    await triggerMirrorSync(env, repositoryId, principal.workspaceId, 'land');
    return true;
  });
}

export async function retireMissionPreview(env: AppEnv, repositoryId: string, missionId: string, workspaceId: string): Promise<StoppedPreview['kind']> {
  const stopped = await env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`).stopPreview(missionId);
  const catalog = env.GITFLARE_COORDINATOR.getByName(catalogName(workspaceId));
  if (stopped.kind === 'container') {
    await env.SANDBOX?.getByName(stopped.sandboxName).destroy().catch(() => { console.error('preview.stop.sandbox.failed', missionId); });
    await catalog.releasePreviewSlot(missionId);
  } else if (stopped.kind === 'worker') {
    const dispatched = env.MISSION_WORKFLOW ? await dispatchBackground(env.MISSION_WORKFLOW, previewRetireWorkflowId(stopped.record.claimId), retireParams(repositoryId, missionId, workspaceId, stopped.record)) : 'missing';
    if (dispatched === 'missing') {
      console.error('preview.retire.dispatch.failed', missionId);
      await catalog.releasePreviewSlot(missionId);
    }
  }
  return stopped.kind;
}

function retireParams(repositoryId: string, missionId: string, workspaceId: string, record: WorkerPreviewRecord): PreviewRetireParams {
  return { kind: 'preview-retire', repositoryId, missionId, previewName: record.previewName, workspaceId, ...(record.d1DatabaseIds?.length ? { d1DatabaseIds: record.d1DatabaseIds } : {}), ...(record.host ? { host: record.host } : {}), ...(record.principal ? { principal: record.principal } : {}) };
}

export async function scheduleLandedDeployment(env: AppEnv, repositoryId: string, missionId: string, epoch: number, commitSha: string, baseSha?: string): Promise<void> {
  const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`);
  const { settings } = await coordinator.deployState();
  const created: DeploymentRecord[] = [];
  for (const draft of landedDeployments(settings, repositoryId, missionId, commitSha, baseSha)) {
    const principal = settings?.environments[draft.environment]?.authorizedBy;
    if (!principal) continue;
    created.push(await createAndDispatchDeployment(env, coordinator, draft, principal, `land-${missionId}-${epoch}${draft.environment === 'production' ? '' : `-${draft.environment}`}`, JSON.stringify(['land', missionId, epoch, commitSha, draft.environment])));
  }
  await coordinator.recordMissionEvent(missionId, landingDeploySummary(settings, created));
}

async function createAndDispatchDeployment(env: AppEnv, coordinator: ReturnType<AppEnv['GITFLARE_COORDINATOR']['getByName']>, draft: DeploymentRecord, principal: DeployParams['principal'], key: string, fingerprint: string): Promise<DeploymentRecord> {
  let record;
  try { record = await coordinator.createDeployment(key, fingerprint, draft); }
  catch (error) {
    if (!(error instanceof Error && /DEPLOYMENT_IN_PROGRESS/.test(error.message))) throw error;
    record = await coordinator.createDeployment(key, fingerprint, { ...draft, status: 'awaiting_confirmation' });
  }
  if (record.status === 'queued' && env.MISSION_WORKFLOW && await dispatchBackground(env.MISSION_WORKFLOW, deployWorkflowId(record.id), { kind: 'deploy', repositoryId: draft.repositoryId, deploymentId: record.id, principal } satisfies DeployParams) === 'missing') {
    return await coordinator.updateDeployment(record.id, ['queued'], { status: 'failed', errorCode: 'DEPLOYMENT_NOT_STARTED', error: 'The deployment could not be scheduled. Deploy it manually.' }) ?? record;
  }
  return record;
}

function previewsCall(config: { token: string; accountId: string }) {
  return cloudflareDeployClient({ accessToken: config.token, accountId: config.accountId, scopes: [], source: 'workspace' }).call;
}

export const PREVIEW_ENVIRONMENT = 'preview';

function connectionAccess(env: AppEnv, principal: Principal, repositoryId: string, expectedAccountId?: string, environment: string = PREVIEW_ENVIRONMENT): Promise<CloudflareDeployAccess> {
  return cloudflareDeployAccess(env, principal, { action: 'read', resourceType: 'repository', resourceId: repositoryId, ...(expectedAccountId ? { expectedAccountId } : {}) }, repositoryId, environment);
}

async function retireConfig(env: AppEnv, params: PreviewRetireParams): Promise<WorkerPreviewsConfig | null> {
  const host = params.host;
  if (host?.kind === 'connection') {
    if (!params.principal) return null;
    try {
      const access = await connectionAccess(env, params.principal, params.repositoryId, host.accountId);
      return { accountId: access.accountId, workerName: host.workerName, token: access.accessToken, connection: access.source };
    } catch (error) {
      console.error('preview.retire.connection.unavailable', params.missionId, error instanceof Error ? error.message : 'unknown');
      return null;
    }
  }
  let config: WorkerPreviewsConfig | null;
  try { config = await resolveWorkerPreviewsConfig(env); }
  catch (error) {
    console.error('preview.retire.installation.unavailable', params.missionId, error instanceof ApiError ? error.code : 'unknown');
    return null;
  }
  if (!config || (host && (host.accountId !== config.accountId || host.workerName !== config.workerName))) return null;
  return config;
}

export async function retirePreview(env: AppEnv, params: PreviewRetireParams, step: StepRunner): Promise<void> {
  const config = await retireConfig(env, params);
  if (config) {
    await step.do('delete worker preview', { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, async () => deleteWorkerPreview(config, params.previewName));
    const d1DatabaseIds = params.d1DatabaseIds ?? [];
    if (d1DatabaseIds.length) await step.do('delete preview D1 databases', { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, async () => deletePreviewD1(previewsCall(config), config.accountId, d1DatabaseIds));
  }
  await step.do('release preview capacity', { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '1 minute' }, async () => {
    const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${params.repositoryId}`);
    if (!await coordinator.workerPreview(params.missionId)) await env.GITFLARE_COORDINATOR.getByName(catalogName(params.workspaceId)).releasePreviewSlot(params.missionId);
    return true;
  });
}

const DETECT_FILE_MAX_BYTES = 262_144;

async function readText(source: { readFile(args: { ref: string; path: string }): Promise<Blob | null> }, ref: string, path: string): Promise<string | null> {
  const file = await source.readFile({ ref, path });
  if (!file || file.size > DETECT_FILE_MAX_BYTES) return null;
  return file.text();
}

export async function detectRepositorySetup(env: AppEnv, principal: Principal, repository: Repository): Promise<DetectedSetup> {
  if (!env.ARTIFACTS || repository.provider !== 'artifacts') throw new ApiError(409, 'REPOSITORY_NOT_CONNECTED', 'Deploy setup is detected from a connected Artifacts repository.');
  const head = await repositoryHead(env.ARTIFACTS, repository.name, repository.defaultBranch);
  if (!head) throw new ApiError(409, 'EMPTY_REPOSITORY', 'Push an initial commit before detecting the deploy setup.');
  using source = await env.ARTIFACTS.get(repository.name);
  const setup = await detectDeploySetup(await scanRepository(source, head), (path) => readText(source, head, path));
  let access: CloudflareDeployAccess;
  const environmentAccounts: Record<string, EnvironmentAccount> = Object.fromEntries(await Promise.all(Object.keys(setup.environments).map(async (environment) => {
    try { const resolved = await cloudflareDeployAccess(env, principal, { action: 'read', resourceType: 'repository', resourceId: repository.id }, repository.id, environment); return [environment, { connected: true, accountId: resolved.accountId, ...(resolved.accountName ? { accountName: resolved.accountName } : {}), source: resolved.source, selection: resolved.selection ?? 'default' }]; }
    catch (error) { return [environment, { connected: false, reason: error instanceof ApiError ? error.detail : 'Connect Cloudflare for this repository or workspace first.' }]; }
  })));
  try { access = await cloudflareDeployAccess(env, principal, { action: 'read', resourceType: 'repository', resourceId: repository.id }, repository.id); }
  catch (error) { return { ...setup, environmentAccounts, account: { connected: false, reason: error instanceof ApiError ? error.detail : 'Connect Cloudflare for this repository or workspace first.' } }; }
  return { ...await withAccountFacts(setup, cloudflareDeployClient(access).call, access.accountId, access.source, { ...(access.accountName ? { accountName: access.accountName } : {}), scopes: access.scopes }), environmentAccounts };
}

async function policyBase(env: AppEnv, repositoryName: string, record: DeploymentRecord): Promise<string | null> {
  if (record.baseSha) return record.baseSha;
  if (!env.ARTIFACTS || !record.commitSha) return null;
  using repository = await env.ARTIFACTS.get(repositoryName);
  const commits = await repository.log({ ref: record.commitSha, limit: 2 });
  return commits[0]?.hash === record.commitSha ? commits[1]?.hash ?? null : null;
}

export async function deployLandedWorker(env: AppEnv, params: DeployParams, step: StepRunner & { sleep(name: string, duration: number): Promise<void> }): Promise<void> {
  const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${params.repositoryId}`);
  const access = securityClient(env);
  await runDeployment(params, step, {
    coordinator,
    self: selfWorker(env),
    authorize: (principal, workerName) => access.check(principal, 'deploy', 'environment', workerName),
    deployer: (principal, record, workerName) => cloudflareWorkerDeployer(env, principal, workerName, record.accountId, undefined, record.repositoryId, record.environment),
    environmentAccount: async (principal, repositoryId, environment) => (await connectionAccess(env, principal, repositoryId, undefined, environment).catch(() => null))?.accountId ?? null,
    build: (repository, record, target, index, assertAuthority, publish) => buildLandedWorker(env, { repository, commitSha: record.commitSha!, attemptId: record.attemptId, assertAuthority, ...(target.inheritBindings ? {} : { target }), index, environment: wranglerEnvironment(record.environment, target) }, publish),
    policyTargets: async (repository, record) => {
      if (!env.ARTIFACTS) return null;
      const base = await policyBase(env, repository.name, record);
      if (!base) return null;
      using source = await env.ARTIFACTS.get(repository.name);
      const file = await source.readFile({ ref: base, path: POLICY_FILE });
      return policyDeployTargets(file ? await file.text() : null, record.environment);
    },
    changedPaths: async (repository, record) => {
      if (!env.ARTIFACTS || !record.baseSha || !record.commitSha) return null;
      using source = await env.ARTIFACTS.get(repository.name);
      return await changedPaths(source, record.baseSha, record.commitSha);
    },
    mappedWorkers: async (principal, repositoryId) => {
      const { mapping } = await access.projectStore(principal, repositoryId, 'get') as ProjectSnapshot;
      return mapping ? { accountId: mapping.accountId, workers: (mapping.resources ?? []).filter((resource) => resource.type === 'worker').map((resource) => resource.id) } : null;
    },
    secretLinks: () => coordinator.secretLinks(),
    declaresRoutes: async (repository, record, target) => {
      if (!env.ARTIFACTS || !record.commitSha || !target.configPath) return false;
      using source = await env.ARTIFACTS.get(repository.name);
      const content = await readText(source, record.commitSha, target.configPath);
      if (content === null) return false;
      try { return declaresRoutes(environmentBlock(parseWranglerConfig(target.configPath, content), record.environment)); } catch { return false; }
    },
  });
  await step.do('promote to production', { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, async () => {
    const [staging, { settings }] = await Promise.all([coordinator.getDeployment(params.deploymentId), coordinator.deployState()]);
    const draft = automaticPromotion(settings, staging);
    const principal = settings?.environments.production?.authorizedBy;
    if (draft && principal) await createAndDispatchDeployment(env, coordinator, draft, principal, `promote-${params.deploymentId}`, JSON.stringify(['promote', params.deploymentId]));
    return true;
  });
}

function durablePrincipal({ userId, workspaceId, role, credentialId, bootstrap }: Principal): Principal {
  return { userId, workspaceId, role, ...(credentialId ? { credentialId } : {}), ...(bootstrap ? { bootstrap } : {}) };
}

async function projectWorkers(env: AppEnv, principal: Principal, repositoryId: string): Promise<ProjectWorkers | null> {
  try {
    const { mapping } = await securityClient(env).projectStore(principal, repositoryId, 'get') as ProjectSnapshot;
    return mapping ? { accountId: mapping.accountId, workers: (mapping.resources ?? []).filter((resource) => resource.type === 'worker').map((resource) => resource.id) } : null;
  } catch { return null; }
}

async function candidateTarget(env: AppEnv, forkName: string | undefined, sha: string): Promise<PreviewTarget | null> {
  if (!env.ARTIFACTS || !forkName) return null;
  try {
    using source = await env.ARTIFACTS.get(forkName);
    return await candidateWorkerTarget((path) => readText(source, sha, path));
  } catch { return null; }
}

export async function preparePreview(env: AppEnv, params: PreviewParams, step: StepRunner): Promise<void> {
  const { repositoryId, missionId, epoch, candidateSha, claimId, principal } = params;
  const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`);
  const catalog = env.GITFLARE_COORDINATOR.getByName(catalogName(principal.workspaceId));
  const access = securityClient(env);
  const prepared = await step.do('prepare candidate preview', { retries: { limit: 0, delay: '1 second' }, timeout: PREVIEW_STEP_MS }, async (): Promise<{ worker: boolean; expiresAt?: number; lifetimeMs?: number }> => {
    let finished = false;
    let setup: PreviewSetupCode | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const renew = async () => {
      try { await coordinator.renewPreview(missionId, epoch, candidateSha, claimId); }
      catch {}
      if (!finished) timer = setTimeout(renew, PREVIEW_HEARTBEAT_MS);
    };
    timer = setTimeout(renew, PREVIEW_HEARTBEAT_MS);
    try {
      const [mission, repository] = await Promise.all([coordinator.getMission(missionId), coordinator.getRepository(repositoryId)]);
      if (!mission || !repository || mission.epoch !== epoch || mission.candidateSha !== candidateSha) throw new PreviewFailure('The candidate changed before its preview started.');
      if (!env.SANDBOX) { setup = 'PREVIEW_NOT_CONFIGURED'; throw new PreviewFailure('The preview runner is unavailable.'); }
      const settings = await coordinator.getPreviewSettings();
      const lifetimeMs = previewLifetimeMs(settings, env);
      const lifetime = { lifetimeMs, extendMs: lifetimeMs };
      const { settings: deploy } = await coordinator.deployState();
      const target = previewTarget(settings, deploy, await projectWorkers(env, principal, repositoryId)) ?? await candidateTarget(env, mission.integrationForkName, candidateSha);
      let installationProblem: string | undefined;
      const plan = await resolvePreviewHost(env, settings, target, {
        connection: (wanted: PreviewTarget) => connectionAccess(env, principal, repositoryId, wanted.accountId),
        installation: () => resolveWorkerPreviewsConfig(env).catch((error: unknown) => {
          if (!(error instanceof ApiError)) throw error;
          installationProblem = error.detail;
          return null;
        }),
      });
      const previews = plan.config;
      const host = plan.host;
      const alias = previews ? previewAlias(missionId, previews.workerName) : '';
      const previewCall = previews ? previewsCall(previews) : null;
      const prepared = await prepareCandidatePreview(env, {
        repository, mission, previewAttemptId: claimId, workerPreviews: !!previews || !!installationProblem, ...(plan.containerReason ? { workerPreviewsUnavailable: plan.containerReason } : {}), ...(plan.configPath ? { configPath: plan.configPath } : {}),
        assertAuthority: () => access.check(principal, 'read', 'repository', repositoryId, missionId),
        onStep: (step) => coordinator.previewStep(missionId, epoch, candidateSha, claimId, step),
        publishWorker: async (built) => {
          if (!previews || !previewCall || !host) { setup = installationProblem ? 'PREVIEWS_INSTALLATION_UNAVAILABLE' : plan.setup ?? 'PREVIEWS_NOT_CONNECTED'; throw new PreviewFailure(installationProblem ?? 'Worker previews are not configured for this installation.'); }
          if (host.access === 'cloudflare-access') await ensurePreviewAccess(previewCall, previews.accountId, previews.workerName, await previewAccessIncludes(env, principal, repositoryId, settings));
          const { uploadAssets } = built;
          const d1 = built.d1?.length ? await bindPreviewD1(previewCall, previews.accountId, built.d1) : undefined;
          const links = await coordinator.secretLinks();
          const scopes = host.kind === 'connection' && links.length ? (await connectionAccess(env, principal, repositoryId, host.accountId).catch(() => null))?.scopes ?? [] : [];
          const secrets = previewSecretBindings(links, host, scopes);
          return upsertWorkerPreview(previews, {
            secrets,
            alias,
            bundle: built.bundle,
            annotations: { 'workers/commit_sha': candidateSha, 'workers/message': mission.title.slice(0, 100), 'workers/pull_request_title': mission.title.slice(0, 100) },
            ...(uploadAssets ? { uploadAssets: () => uploadAssets(previewCall, previews.accountId, previews.workerName) } : {}),
            ...(d1 ? { d1 } : {}),
            inheritBaseConfig: host.kind === 'connection',
            emailRecipients: settings.previewEmailRecipients,
          }).catch((error: unknown) => { setup = workerPreviewSetup(error, previews); throw error; });
        },
      });
      if (prepared.kind === 'worker') {
        const result = prepared.published;
        if (!result || !host) throw new PreviewFailure('The Worker preview was not published.');
        const expiresAt = await coordinator.workerPreviewReady(missionId, epoch, candidateSha, claimId, { previewName: alias, previewUrl: result.previewUrl, deploymentUrl: result.deploymentUrl, notes: [...plan.notes, ...result.notes].slice(0, 50), host, ...(result.baseBindings ? { baseBindings: result.baseBindings.slice(0, 50) } : {}), ...(result.d1Databases?.length ? { d1Databases: result.d1Databases } : {}) }, lifetime, durablePrincipal(principal));
        await catalog.holdPreviewSlot(missionId, expiresAt);
        return { worker: true, expiresAt, lifetimeMs };
      }
      const fallback = !previews && !installationProblem && plan.setup && usedContainerFallback(prepared.notes) ? plan.setup : undefined;
      const expiresAt = await coordinator.previewReady(missionId, epoch, candidateSha, claimId, prepared.sandboxName, lifetime, prepared.notes, fallback);
      await env.SANDBOX.getByName(prepared.sandboxName).expireAt(expiresAt);
      await catalog.holdPreviewSlot(missionId, expiresAt);
    } catch (error) {
      const message = error instanceof PreviewFailure || error instanceof WorkerPreviewError || error instanceof WorkerBuildFailure ? error.message : error instanceof ApiError ? `The preview could not be started. ${error.detail}` : 'The preview could not be started.';
      const code = setup ?? (error instanceof ApiError && isPreviewSetupCode(error.code) ? error.code : undefined);
      const released = await coordinator.previewFailed(missionId, claimId, message, code).catch(() => false);
      await env.SANDBOX?.getByName(`preview-${missionId}-${claimId}`).destroy().catch(() => {});
      if (released) await catalog.releasePreviewSlot(missionId).catch(() => {});
    } finally {
      finished = true;
      clearTimeout(timer);
    }
    return { worker: false };
  });
  if (!prepared.worker || !step.sleep) return;
  await step.sleep('hold worker preview until expiry', prepared.lifetimeMs ?? 0);
  const extendedUntil = await step.do('read worker preview expiry', { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '1 minute' }, async () => {
    const record = await coordinator.workerPreview(missionId);
    return record?.claimId === claimId ? record.expiresAt : 0;
  });
  if (extendedUntil > (prepared.expiresAt ?? 0)) await step.sleep('hold extended worker preview until expiry', extendedUntil - (prepared.expiresAt ?? 0));
  const expired = await step.do('retire expired worker preview', { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '1 minute' }, async () => coordinator.retireWorkerPreview(missionId, claimId));
  if (expired) await retirePreview(env, retireParams(repositoryId, missionId, principal.workspaceId, expired), step);
}
