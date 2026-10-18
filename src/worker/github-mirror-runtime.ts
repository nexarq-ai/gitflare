import type { Repository } from '../shared/types';
import type { AppEnv } from './env';
import { dispatchBackground, type StepRunner } from './background-work';
import { catalogName } from './capacity';
import { inspectRepositoryImport } from './repository-import';
import { securityClient, type Principal } from './security';
import { handleGithubMirror, mirrorRemotes, mirrorWorkflowId, runMirrorSync, runMirrorWorkflow, scheduleMirrorSync, type MirrorParams, type MirrorRecords, type MirrorRunContext } from './github-mirror';

export function mirrorRecords(env: AppEnv, repositoryId: string): MirrorRecords {
  const coordinator = env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`);
  return { githubMirror: () => coordinator.githubMirror(), changeGithubMirror: (change) => coordinator.changeGithubMirror(change) };
}

function runContext(env: AppEnv, repository: Repository, fetcher?: typeof fetch): MirrorRunContext {
  return { records: mirrorRecords(env, repository.id), remotes: mirrorRemotes(env, repository, fetcher), authority: securityClient(env), repositoryId: repository.id };
}

function dispatcher(env: AppEnv) {
  return env.MISSION_WORKFLOW ? (params: MirrorParams) => dispatchBackground(env.MISSION_WORKFLOW!, mirrorWorkflowId(params.runId), params) : null;
}

async function repositoryRecord(env: AppEnv, repositoryId: string): Promise<Repository | undefined> {
  return env.GITFLARE_COORDINATOR.getByName(`repository:${repositoryId}`).getRepository(repositoryId);
}

export async function triggerMirrorSync(env: AppEnv, repositoryId: string, workspaceId: string, reason: string, changedRefs?: string[], ctx?: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
  try {
    const repository = await repositoryRecord(env, repositoryId);
    if (!repository) return;
    await scheduleMirrorSync(mirrorRecords(env, repositoryId), dispatcher(env), async (params) => {
      const running = runMirrorSync(runContext(env, repository), { runId: params.runId, reason: params.reason }).catch(() => undefined);
      if (ctx) ctx.waitUntil(running); else await running;
    }, { repositoryId, workspaceId, reason }, changedRefs);
  } catch (error) {
    console.warn(JSON.stringify({ event: 'github_mirror_trigger_failed', repositoryId, reason, name: error instanceof Error ? error.name : 'unknown' }));
  }
}

export async function mirrorWorkflow(env: AppEnv, params: MirrorParams, step: StepRunner): Promise<void> {
  const repository = await repositoryRecord(env, params.repositoryId);
  if (!repository) return;
  await runMirrorWorkflow(runContext(env, repository), params, step);
}

export interface MirrorRouteContext {
  repository: Repository;
  principal: Principal;
  bootstrapSha(): Promise<string | undefined>;
  ctx?: { waitUntil(promise: Promise<unknown>): void };
  fetcher?: typeof fetch;
}

export function githubMirrorApi(request: Request, env: AppEnv, route: MirrorRouteContext, action: string | undefined): Promise<Response> {
  const { repository, principal } = route;
  const context = runContext(env, repository, route.fetcher);
  return handleGithubMirror(request, {
    env, repository, principal, access: securityClient(env), records: context.records, remotes: context.remotes, fetcher: route.fetcher,
    run: (options) => runMirrorSync(context, { runId: `${repository.id}-${crypto.randomUUID()}`, ...options }),
    schedule: (reason) => scheduleMirrorSync(context.records, dispatcher(env), async (params) => {
      const running = runMirrorSync(context, { runId: params.runId, reason: params.reason }).catch(() => undefined);
      if (route.ctx) route.ctx.waitUntil(running); else await running;
    }, { repositoryId: repository.id, workspaceId: principal.workspaceId, reason }),
    freshRepository: async () => (await inspectRepositoryImport(env.ARTIFACTS, repository, await route.bootstrapSha())).allowed,
    recordHead: async (headSha) => {
      const now = new Date().toISOString();
      for (const name of [catalogName(principal.workspaceId), `repository:${repository.id}`]) {
        const records = env.GITFLARE_COORDINATOR.getByName(name);
        const current = await records.getRepository(repository.id);
        if (current) await records.saveRepository({ ...current, headSha, updatedAt: now });
      }
    },
  }, action);
}
