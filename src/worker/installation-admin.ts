import { ApiError } from './domain';
import type { AppEnv } from './env';
import { cloudflareSigninConfigured, requestedScopes, signinScopes } from './cloudflare';
import { emailConfigured } from './email';
import { indexedRepositoryCount, publicIndex, reconcilePublicIndex } from './public-index';
import { securityClient, superAdminEmails, type Principal } from './security';

export const ADMIN_STATUS_PATH = '/api/admin/status';
export const ADMIN_PUBLIC_INDEX_PATH = '/api/admin/public-index/rebuild';

export interface InstallationAdminStatus {
  edition: 'hosted' | 'self-hosted';
  superAdmins: string[];
  cloudflareOAuth: boolean;
  email: boolean;
  previewsWorker: string | null;
  scopes: { signin: string[]; connect: string[]; access: string[] };
  publicIndex: { configured: boolean; repositories: number | null };
}

export interface PublicIndexRebuild { indexed: number; removed: number; failed: number; repositories: number }

export async function installationAdminStatus(env: AppEnv, principal: Principal): Promise<InstallationAdminStatus> {
  if (!await securityClient(env).installationCredentialAdmin(principal).catch(() => false)) throw new ApiError(404, 'NOT_FOUND', 'This API route could not be found.');
  const hosted = env.EDITION !== 'self-hosted';
  const repositories = await indexedRepositoryCount(env).catch(() => null);
  return {
    edition: hosted ? 'hosted' : 'self-hosted',
    superAdmins: hosted ? superAdminEmails(env.SUPER_ADMIN_EMAILS) : [],
    cloudflareOAuth: cloudflareSigninConfigured(env),
    email: emailConfigured(env),
    previewsWorker: env.PREVIEWS_WORKER_NAME ?? null,
    scopes: { signin: hosted ? signinScopes(env) : [], connect: requestedScopes(env), access: (env.CLOUDFLARE_ACCESS_SCOPES ?? '').split(/\s+/).filter(Boolean) },
    publicIndex: { configured: !!publicIndex(env), repositories },
  };
}

export async function rebuildPublicIndex(env: AppEnv, principal: Principal): Promise<PublicIndexRebuild> {
  const access = securityClient(env);
  if (!await access.installationCredentialAdmin(principal).catch(() => false)) throw new ApiError(404, 'NOT_FOUND', 'This API route could not be found.');
  if (!publicIndex(env) || !env.GITFLARE_SECURITY) throw new ApiError(409, 'PUBLIC_INDEX_UNAVAILABLE', 'This installation has no public index database. Bind PUBLIC_INDEX in the deployment and deploy again.');
  const result = await reconcilePublicIndex(env, access);
  await access.auditInstallation(principal, 'installation.public_index.rebuilt', `indexed:${result.indexed},removed:${result.removed},failed:${result.failed}`);
  return { ...result, repositories: await indexedRepositoryCount(env) ?? 0 };
}
