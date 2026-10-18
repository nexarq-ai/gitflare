import type { Repository } from '../shared/types';
import { ApiError } from './domain';
import type { AppEnv } from './env';
import { securityClient, type Principal } from './security';
import { repositoryHead } from './artifacts';
import { cloudflareDeployAccess } from './cloudflare';
import { cloudflareDeployClient } from './cloudflare-deploy';
import { settingsTargets, type DeployEnvironment, type DeploySettings } from './deployments';
import { orderedEnvironments } from './deploy-environments';
import { missingSecretsReason, repositorySecretRequirements, unmetRequirements, type RequirementTarget, type SecretLink, type SecretReceipt, type SecretsApiContext, type SecretsConnection } from './repository-secrets';
import { secretsStoreScopes } from './secrets-scopes';

const DETECT_FILE_MAX_BYTES = 262_144;

interface SecretsCoordinator {
  deployState(): Promise<{ settings: DeploySettings | null }>;
  secretLinks(): Promise<SecretLink[]>;
  secretReceipt(key: string): Promise<SecretReceipt | null>;
  saveSecretLink(link: SecretLink, receipt?: { key: string; value: SecretReceipt }): Promise<SecretLink>;
  removeSecretLink(environment: string, binding: string, receipt?: { key: string; value: SecretReceipt }): Promise<SecretLink | null>;
  recordSecretRequest(key: string, value: SecretReceipt): Promise<void>;
}

export function requirementTargets(settings: DeploySettings | null): RequirementTarget[] {
  return orderedEnvironments(Object.keys(settings?.environments ?? {})).flatMap((environment) => {
    const value = settings?.environments[environment];
    return value ? settingsTargets(value).map((target) => ({ environment, workerName: target.workerName, configPath: target.configPath })) : [];
  });
}

async function headRequirements(env: AppEnv, repository: Repository, settings: DeploySettings | null) {
  const targets = requirementTargets(settings);
  if (!targets.some((target) => target.configPath)) return { requirements: [], errors: [] };
  if (!env.ARTIFACTS || repository.provider !== 'artifacts') return { requirements: [], errors: ['Secret requirements are read from a connected Artifacts repository.'] };
  const head = await repositoryHead(env.ARTIFACTS, repository.name, repository.defaultBranch);
  if (!head) return { requirements: [], errors: [] };
  using source = await env.ARTIFACTS.get(repository.name);
  return repositorySecretRequirements(targets, async (path) => {
    const file = await source.readFile({ ref: head, path });
    return !file || file.size > DETECT_FILE_MAX_BYTES ? null : file.text();
  });
}

export function secretsBlocker(env: AppEnv, repository: Repository, coordinator: SecretsCoordinator): (environment: DeployEnvironment) => Promise<string | null> {
  let pending: Promise<{ missing: ReturnType<typeof unmetRequirements> }> | undefined;
  const load = () => pending ??= (async () => {
    const [{ settings }, links] = await Promise.all([coordinator.deployState(), coordinator.secretLinks()]);
    const { requirements } = await headRequirements(env, repository, settings);
    return { missing: unmetRequirements(requirements, links) };
  })();
  return async (environment) => missingSecretsReason(environment, (await load()).missing);
}

export function secretsApiContext(env: AppEnv, principal: Principal, repository: Repository, coordinator: SecretsCoordinator): SecretsApiContext {
  const security = securityClient(env);
  return {
    repositoryId: repository.id,
    principal,
    store: {
      links: () => coordinator.secretLinks(),
      receipt: (key) => coordinator.secretReceipt(key),
      save: (link, receipt) => coordinator.saveSecretLink(link, receipt),
      remove: (environment, binding, receipt) => coordinator.removeSecretLink(environment, binding, receipt),
      record: (key, value) => coordinator.recordSecretRequest(key, value),
    },
    authorizeRead: () => security.authorize(principal, 'read', 'repository', repository.id),
    canManage: async () => !principal.credentialId && await security.check(principal, 'deploy', 'secret', repository.id).then(() => true, () => false),
    environments: async () => Object.keys((await coordinator.deployState()).settings?.environments ?? {}),
    requirements: async () => headRequirements(env, repository, (await coordinator.deployState()).settings),
    connection: async (): Promise<SecretsConnection> => {
      try {
        const access = await cloudflareDeployAccess(env, principal, { action: 'read', resourceType: 'repository', resourceId: repository.id }, repository.id);
        return { connected: true, accountId: access.accountId, scopes: access.scopes, source: access.source, call: cloudflareDeployClient(access).call };
      } catch (error) {
        return { connected: false, reason: error instanceof ApiError ? error.detail : 'Connect Cloudflare for this repository or workspace first.' };
      }
    },
    requestedScopes: secretsStoreScopes(env),
    audit: (action) => security.auditRepositoryChange(principal, action, repository.id),
  };
}
