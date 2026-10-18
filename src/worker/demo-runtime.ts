import { ApiError } from './domain';
import type { AppEnv } from './env';
import { securityClient, type Principal } from './security';
import { pushDemoHistory } from './demo-git';
import { DEMO_VISITOR_ID } from './demo-seed';
import { DEMO_CONTROL, DEMO_RESET_PATH, DEMO_RESET_TIME, DEMO_STATUS_PATH, demoMode, demoTokenMatches, resetDemo, type DemoResetDeps, type DemoResetReport } from './demo';

const PRINCIPAL_CACHE_MS = 30_000;
let cachedPrincipal: { principal: Principal; until: number } | null = null;

export async function demoVisitor(env: AppEnv): Promise<Principal> {
  const now = Date.now();
  if (cachedPrincipal && cachedPrincipal.until > now) return cachedPrincipal.principal;
  const principal = await securityClient(env).demoPrincipal(DEMO_VISITOR_ID);
  cachedPrincipal = { principal, until: now + PRINCIPAL_CACHE_MS };
  return principal;
}

function artifactsCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

export function demoResetDeps(env: AppEnv, fetcher: typeof fetch = fetch): DemoResetDeps {
  const artifacts = env.ARTIFACTS;
  if (!artifacts) throw new ApiError(503, 'DEMO_NOT_CONFIGURED', 'The demo needs the Artifacts binding.');
  const control = env.GITFLARE_COORDINATOR.getByName(DEMO_CONTROL);
  const object = (name: string) => env.GITFLARE_COORDINATOR.getByName(name);
  return {
    now: () => new Date(),
    claim: (now) => control.demoClaimReset(now),
    finish: (current) => control.demoFinishReset(current),
    fail: (generation) => control.demoFailReset(generation),
    cleaned: (generations) => control.demoCleaned(generations),
    createRepository: async (name, description) => {
      const created = await artifacts.create(name, { description, setDefaultBranch: 'main' });
      using repository = await artifacts.get(created.name);
      await repository.revokeToken(created.token);
    },
    pushHistory: (name, history) => pushDemoHistory(artifacts, name, history, fetcher),
    importRecords: async (name, records) => { await object(name).demoImport(records); },
    install: (plan) => securityClient(env).demoInstall({ workspaceId: plan.workspaceId, workspaceName: plan.workspaceName, users: plan.users, visitorId: DEMO_VISITOR_ID }),
    wipeObject: (name) => object(name).demoWipe(),
    wipeSecurity: (workspaceId) => env.GITFLARE_SECURITY.getByName(`security:ws:${workspaceId}`).demoWipe(),
    deleteRepository: async (name) => {
      const remover = (artifacts as unknown as { delete?(name: string): Promise<boolean> }).delete;
      if (!remover) throw new ApiError(503, 'ARTIFACTS_DELETE_UNAVAILABLE', 'The Artifacts binding cannot delete repositories.');
      try { return await remover.call(artifacts, name); }
      catch (error) { if (artifactsCode(error) === 'NOT_FOUND') return false; throw error; }
    },
  };
}

export async function runDemoReset(env: AppEnv): Promise<DemoResetReport> {
  const report = await resetDemo(demoResetDeps(env));
  cachedPrincipal = null;
  console.log(JSON.stringify({ event: 'demo_reset', generation: report.generation, repositories: report.repositories.length, cleaned: report.cleaned, cleanupErrors: report.cleanupErrors.length }));
  return report;
}

export async function handleDemoRoute(request: Request, env: AppEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== DEMO_STATUS_PATH && path !== DEMO_RESET_PATH) return null;
  if (!demoMode(env)) throw new ApiError(404, 'NOT_FOUND', 'This API route could not be found.');
  if (path === DEMO_STATUS_PATH) {
    if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
    const state = await env.GITFLARE_COORDINATOR.getByName(DEMO_CONTROL).demoControl();
    return Response.json({ demo: true, resetsDaily: DEMO_RESET_TIME, generation: state.current?.generation ?? null, seededAt: state.current?.seededAt ?? null, agentRuns: 'disabled' });
  }
  if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
  const bearer = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!await demoTokenMatches(bearer, env.DEMO_RESET_TOKEN)) throw new ApiError(401, 'AUTH_REQUIRED', 'Only the demo operator can reset the demo.');
  return Response.json(await runDemoReset(env));
}
