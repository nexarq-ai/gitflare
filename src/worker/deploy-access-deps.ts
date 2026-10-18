import type { AppEnv } from './env';
import type { Principal } from './security';
import { cloudflareDeployAccess } from './cloudflare';
import { cloudflareDeployClient } from './cloudflare-deploy';
import type { DeployAccessDeps, DeployAccessRecord, DeployAccessResult } from './deploy-access';

type Maybe<T> = T | Promise<T>;

export interface DeployAccessCoordinator {
  deployAccess(): Maybe<DeployAccessRecord[]>;
  deployAccessReceipt(key: string, fingerprint: string): Maybe<DeployAccessResult | null>;
  saveDeployAccess(key: string, fingerprint: string, environment: string, record: DeployAccessRecord | null, result: DeployAccessResult): Maybe<DeployAccessResult>;
}

export function deployAccessDeps(env: AppEnv, principal: Principal, repositoryId: string, coordinator: DeployAccessCoordinator, fetcher?: (request: Request) => Promise<Response>): DeployAccessDeps {
  return {
    store: {
      records: async () => coordinator.deployAccess(),
      receipt: async (key, fingerprint) => coordinator.deployAccessReceipt(key, fingerprint),
      save: async (key, fingerprint, environment, record, result) => coordinator.saveDeployAccess(key, fingerprint, environment, record, result),
    },
    client: async (environment) => cloudflareDeployClient(await cloudflareDeployAccess(env, principal, { action: 'read', resourceType: 'repository', resourceId: repositoryId }, repositoryId, environment), fetcher),
    scopes: env,
  };
}
