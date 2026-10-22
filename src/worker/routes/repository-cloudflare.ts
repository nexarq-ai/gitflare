import { repositoryHead } from '../artifacts';
import { ApiError, assertMutationOrigin, readJson } from '../domain';
import { detectRepositorySetup, dispatchBackground } from '../background-work';
import { backgroundPrincipal, deploymentsApi, deployWorkflowId, type DeployParams } from '../deployments';
import { deployAccessDeps } from '../deploy-access-deps';
import { repositorySecretsApi } from '../repository-secrets';
import { secretsApiContext, secretsBlocker } from '../secrets-wiring';
import { handleRepositoryCloudflare, cloudflareAccount, cloudflareApiRequest, cloudflareAnalyticsRequest, cloudflareDeployAccess } from '../cloudflare';
import { dispatchCloudflareProject, projectDependencies, type ProjectOperation, type ProjectSnapshot } from '../cloudflare-projects';
import { type RouteContext, records, requireRepository } from '../route-context';

export async function repositoryCloudflareRoutes(context: RouteContext): Promise<Response | null> {
  const { request, url, env, principal, access, catalog } = context;
  const cloudflareRepositoryConnection = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/cloudflare\/connection(?:\/(accounts|resources|connect|select-account|disconnect))?$/.exec(url.pathname);
  if (cloudflareRepositoryConnection) {
    const repository = await requireRepository(catalog, cloudflareRepositoryConnection[1]);
    await access.authorize(principal, 'read', 'repository', repository.id);
    return handleRepositoryCloudflare(request, env, principal, repository.id, cloudflareRepositoryConnection[2] ?? 'status');
  }
  const cloudflareProject = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/cloudflare(?:\/(usage|action))?$/.exec(url.pathname);
  if (cloudflareProject) {
    const repository = await requireRepository(catalog, cloudflareProject[1]);
    let operation: ProjectOperation = cloudflareProject[2] === 'usage' ? 'usage' : 'get';
    let body: Record<string, unknown> = {};
    if (request.method === 'POST' && cloudflareProject[2] === 'action') {
      assertMutationOrigin(request);
      const input = await readJson(request);
      if (!['map', 'migration-plan', 'migration-execute', 'build-trigger', 'account'].includes(String(input.action))) throw new ApiError(400, 'INVALID_PROJECT_OPERATION', 'Choose a supported project operation.');
      const { action, ...fields } = input; operation = action as ProjectOperation; body = fields;
    } else if (request.method !== 'GET' || cloudflareProject[2] === 'action') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use a supported project operation.');
    const read = { action: 'read' as const, resourceType: 'repository', resourceId: repository.id };
    const dependencies = projectDependencies(env, principal, { ...repository, workspaceId: principal.workspaceId }, {
      account: () => cloudflareAccount(env, principal, read, repository.id),
      api: (path, options) => cloudflareApiRequest(env, principal, path, { ...options, authorization: options?.method === 'POST' ? { action: 'migrate', resourceType: 'database', resourceId: path.split('/')[3] } : read }, repository.id),
      analytics: (query) => cloudflareAnalyticsRequest(env, principal, query, { ...read, expectedAccountId: query.expectedAccountId }, repository.id),
    });
    return Response.json(await dispatchCloudflareProject(principal, { ...repository, workspaceId: principal.workspaceId }, operation, body, dependencies));
  }
  const deploymentsRoute = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/deployments(\/detect)?$/.exec(url.pathname);
  if (deploymentsRoute) {
    const repository = await requireRepository(catalog, deploymentsRoute[1]);
    const coordinator = records(env, repository.id);
    return deploymentsApi(request, {
      repository, principal,
      ledger: { state: () => coordinator.deployState(), get: (id) => coordinator.getDeployment(id), saveEnvironment: (environment, settings) => coordinator.saveDeployEnvironment(environment, settings), create: (key, fingerprint, record) => coordinator.createDeployment(key, fingerprint, record), confirm: (id, actorId) => coordinator.confirmDeployment(id, actorId), saveDetected: (environments, detected) => coordinator.saveDetectedDeploySetup(environments, detected) },
      detectSetup: () => detectRepositorySetup(env, principal, repository),
      connection: async (environment) => {
        try {
          const connection = await cloudflareDeployAccess(env, principal, { action: 'read', resourceType: 'repository', resourceId: repository.id }, repository.id, environment);
          return { connected: true, accountId: connection.accountId, ...(connection.accountName ? { accountName: connection.accountName } : {}), scopes: connection.scopes, source: connection.source, ...(connection.selection ? { selection: connection.selection } : {}) };
        } catch (error) {
          return { connected: false, reason: error instanceof ApiError ? error.detail : 'Connect Cloudflare for this repository or workspace first.' };
        }
      },
      linkWorkers: async (accountId, workers) => { await access.projectStore(principal, repository.id, 'link', { accountId, workers }); },
      authorizeRead: () => access.authorize(principal, 'read', 'repository', repository.id),
      authorizeDeploy: (workerName) => access.authorize(principal, 'deploy', 'environment', workerName),
      canDeploy: async (workerName) => (await access.checkMany(principal, 'deploy', [{ resourceType: 'environment', resourceId: workerName }]))[0] === true,
      mappedWorkers: async () => {
        const { mapping } = await access.projectStore(principal, repository.id, 'get') as ProjectSnapshot;
        return mapping ? { accountId: mapping.accountId, workers: (mapping.resources ?? []).filter((resource) => resource.type === 'worker').map(({ id, name, environment }) => ({ id, name, environment })) } : null;
      },
      headSha: () => env.ARTIFACTS ? repositoryHead(env.ARTIFACTS, repository.name, repository.defaultBranch) : Promise.resolve(null),
      dispatch: async (record) => {
        if (!env.MISSION_WORKFLOW || !env.SANDBOX || !env.ARTIFACTS) return 'missing';
        return dispatchBackground(env.MISSION_WORKFLOW, deployWorkflowId(record.id), { kind: 'deploy', repositoryId: repository.id, deploymentId: record.id, principal: backgroundPrincipal(principal) } satisfies DeployParams);
      },
      failDispatch: async (record) => { await coordinator.updateDeployment(record.id, ['queued'], { status: 'failed', errorCode: 'DEPLOYMENT_NOT_STARTED', error: 'The deployment could not be scheduled.' }); },
      audit: (action) => access.auditRepositoryChange(principal, action, repository.id),
      secretsBlocker: secretsBlocker(env, repository, coordinator),
      access: deployAccessDeps(env, principal, repository.id, coordinator),
    });
  }
  const secretsRoute = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/secrets(\/catalog)?$/.exec(url.pathname);
  if (secretsRoute) {
    const repository = await requireRepository(catalog, secretsRoute[1]);
    return repositorySecretsApi(request, secretsApiContext(env, principal, repository, records(env, repository.id)));
  }
  return null;
}
