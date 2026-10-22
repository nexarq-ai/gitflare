import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { securityClient, type GitflareSecurity } from './security';
import type { AgentRun, CheckPlan, CheckSettings, CommunityPool, Mission, ModelConnection, Repository } from '../shared/types';
import { fixModelAccess } from './community-pool';
import { autoAgentReview } from './agent-assist';
import { isUntrustedMission } from '../shared/pull-requests';
import type { LearnedLimits } from './check-settings';
import { assertPinnedModel } from './model-config';
import { executeMission, type ExecutionEnv, type ExecutionResult } from './execution';
import type { AppEnv } from './env';
import { deployLandedWorker, landCandidate, preparePreview, retirePreview, type LandingParams, type PreviewParams, type PreviewRetireParams } from './background-work';
import type { DeployParams } from './deployments';
import type { MirrorParams } from './github-mirror';
import { mirrorWorkflow } from './github-mirror-runtime';
import type { ImportParams } from './github-import';
import { githubImportWorkflow } from './github-import-runtime';
import { missionStepTimeoutMs } from './budgets';
import { catalogName } from './capacity';
import { afterChecks } from './proposal-notifications';
import { createModelAccess, type AiAccessOptions, type AiCredentials } from './ai-keys';
import { withStoreSecrets } from './store-secrets';
import { logFailure } from './log';

export interface MissionRunParams { kind?: 'mission'; repositoryId: string; missionId: string; epoch: number }
export type MissionWorkflowParams = MissionRunParams | LandingParams | PreviewParams | PreviewRetireParams | DeployParams | MirrorParams | ImportParams;
interface Coordinator {
  getModelConnections(): Promise<ModelConnection[]>;
  getAiCredentials(): Promise<AiCredentials>;
  getRepository(repositoryId: string): Promise<Repository | undefined>;
  getMission(missionId: string): Promise<Mission | undefined>;
  getCheckPlan?(missionId?: string): Promise<CheckPlan>;
  applyLearnedCheckLimits?(missionId: string, epoch: number, learned: LearnedLimits): Promise<CheckSettings | null>;
  isMissionActive(missionId: string, epoch: number): Promise<boolean>;
  recordExecution(missionId: string, epoch: number, result: ExecutionResult, complete?: boolean): Promise<unknown>;
  releaseMissionSlot(missionId: string, epoch: number): Promise<void>;
  communityPool?(): Promise<CommunityPool | null>;
}
interface WorkflowEnv extends ExecutionEnv, AiAccessOptions {
  GITFLARE_SECURITY: DurableObjectNamespace<GitflareSecurity>;
  GITFLARE_COORDINATOR: { getByName(name: string): Coordinator };
}

const platformStop = (after = '') => `Cloudflare Workflows stopped this attempt${after} ("internal workflows error"); Gitflare's code reported no error.`;

export function platformInterruption(error: unknown): boolean {
  const raw = error && typeof error === 'object' ? error as { name?: unknown; message?: unknown } : {};
  return raw.name === 'WorkflowInternalError' || /internal workflows error/i.test(String(raw.message ?? ''));
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds} s`;
}

export function interruptedRun(run: Pick<AgentRun, 'status' | 'startedAt' | 'summary'>, now: number): string {
  const started = run.status === 'running' && run.startedAt ? Date.parse(run.startedAt) : NaN;
  const after = Number.isFinite(started) ? ` after ${elapsed(now - started)}` : '';
  const progress = run.summary?.trim() ? ` Last progress: ${run.summary.trim().slice(0, 200)}.` : '';
  return `${platformStop(after)}${progress} Retry the agent to run it again.`;
}

export class MissionWorkflow extends WorkflowEntrypoint<WorkflowEnv, MissionWorkflowParams> {
  async run(event: WorkflowEvent<MissionWorkflowParams>, step: WorkflowStep): Promise<void> {
    this.env = await withStoreSecrets(this.env);
    const params = event.payload;
    if (params.kind === 'land') return landCandidate(this.env as unknown as AppEnv, params, step);
    if (params.kind === 'preview') return preparePreview(this.env as unknown as AppEnv, params, step);
    if (params.kind === 'preview-retire') return retirePreview(this.env as unknown as AppEnv, params, step);
    if (params.kind === 'deploy') return deployLandedWorker(this.env as unknown as AppEnv, params, step);
    if (params.kind === 'mirror') return mirrorWorkflow(this.env as unknown as AppEnv, params, step);
    if (params.kind === 'github-import') return githubImportWorkflow(this.env as unknown as AppEnv, params, step);
    const { repositoryId, missionId, epoch } = params;
    const coordinator = this.env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`);
    const planned = await coordinator.getMission(missionId);
    const timeout = missionStepTimeoutMs(planned ?? { runs: [] });
    try {
      await step.do('execute isolated agents and verify integration', { retries: { limit: 0, delay: '1 second' }, timeout }, async () => {
        const [repository, mission, checkSettings] = await Promise.all([coordinator.getRepository(repositoryId), coordinator.getMission(missionId), coordinator.getCheckPlan?.(missionId)]);
        if (!repository || !mission) throw new Error('Mission repository was not found');
        if (!await coordinator.isMissionActive(missionId, epoch)) return;
        const authorization = mission.authorization;
        if (!authorization || (repository.workspaceId ?? 'legacy') !== authorization.workspaceId || authorization.principal.workspaceId !== authorization.workspaceId) throw new Error('Execution authorization is missing or belongs to another workspace');
        const assertAuthority = () => securityClient(this.env).check(authorization.principal, 'execute', 'repository', repositoryId, missionId);
        await assertAuthority();
        const catalog = this.env.GITFLARE_COORDINATOR.getByName(authorization.workspaceId === 'legacy' ? 'catalog:owner' : `catalog:${authorization.workspaceId}`);
        const funded = mission.fixRequest ? fixModelAccess(this.env, mission.fixRequest, this.env.GITFLARE_COORDINATOR.getByName(catalogName(mission.fixRequest.fundingWorkspaceId)), async () => (await coordinator.communityPool?.()) ?? null) : null;
        const modelConnections = funded ? await funded.models() : await catalog.getModelConnections();
        const result = await executeMission(
          { repository, mission, modelConnections, checkSettings, testCommand: this.env.TEST_COMMAND ?? 'node --test --test-reporter=tap tests/*.test.mjs' },
          funded ? { ...this.env, assertModelAllowed: funded.assertModelAllowed, modelAccess: funded.modelAccess } : { ...this.env, assertModelAllowed: async model => assertPinnedModel(await catalog.getModelConnections(), model), modelAccess: createModelAccess(this.env, authorization.workspaceId, catalog) },
          async (progress) => { await coordinator.recordExecution(missionId, epoch, progress, false); },
          () => coordinator.isMissionActive(missionId, epoch),
          assertAuthority,
        );
        await coordinator.recordExecution(missionId, epoch, result, true);
        if (result.learnedLimits && coordinator.applyLearnedCheckLimits) {
          try {
            if (await coordinator.applyLearnedCheckLimits(missionId, epoch, result.learnedLimits)) await securityClient(this.env).auditRepositoryChange(authorization.principal, 'repository.check-settings.auto-increase', repositoryId);
          } catch (error) { console.error(JSON.stringify({ event: 'check_limits_learning_failed', repositoryId, missionId, epoch, message: error instanceof Error ? error.message : 'unknown' })); }
        }
      });
      if (planned && isUntrustedMission(planned)) await step.do('agent review of the checked candidate', { retries: { limit: 0, delay: '1 second' }, timeout: '3 minutes' }, async () => { await autoAgentReview(this.env as unknown as AppEnv, repositoryId, missionId); }).catch(() => {});
    } catch (error) {
      const mission = await coordinator.getMission(missionId);
      const platform = platformInterruption(error);
      const reason = error instanceof Error && error.message ? `Execution interrupted: ${error.message.slice(0, 300)}` : 'Execution interrupted';
      if (mission && await coordinator.isMissionActive(missionId, epoch)) await coordinator.recordExecution(missionId, epoch, {
        runs: mission.runs.map((run) => run.status === 'running' || run.status === 'queued' ? { ...run, status: 'failed', error: platform ? interruptedRun(run, Date.now()) : reason } : run),
        checks: mission.checks,
        changes: mission.changes,
        candidateSha: null,
        error: platform ? platformStop() : error instanceof Error ? error.message : 'Workflow failed',
      }, true);
      throw error;
    } finally {
      const workspaceId = planned?.authorization?.workspaceId ?? 'legacy';
      await this.env.GITFLARE_COORDINATOR.getByName(catalogName(workspaceId)).releaseMissionSlot(missionId, epoch).catch(error => logFailure('mission_slot_release_failed', error, { workspaceId, repositoryId, missionId, epoch }));
    }
    await step.do('notify reviewers and participants', { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, async () => {
      await afterChecks(this.env as unknown as AppEnv, repositoryId, missionId, epoch).catch(() => undefined);
      return true;
    });
  }
}
