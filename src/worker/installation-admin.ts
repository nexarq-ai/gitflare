import type { OperatorAiStatus } from '../shared/types';
import { operatorLog } from './agent-assist';
import { OPERATOR_TRIAGE_PER_DAY } from './community-pool';
import { ApiError } from './domain';
import type { AppEnv } from './env';
import { cloudflareSigninConfigured, requestedScopes, signinScopes } from './cloudflare';
import { emailConfigured } from './email';
import { securityClient, superAdminEmails, type Principal } from './security';

export const ADMIN_STATUS_PATH = '/api/admin/status';
export const OPERATOR_AI_PATH = '/api/admin/operator-ai';

export interface InstallationAdminStatus {
  edition: 'hosted' | 'self-hosted';
  superAdmins: string[];
  cloudflareOAuth: boolean;
  email: boolean;
  previewsWorker: string | null;
  scopes: { signin: string[]; connect: string[]; access: string[] };
}

export async function installationAdminStatus(env: AppEnv, principal: Principal): Promise<InstallationAdminStatus> {
  if (!await securityClient(env).installationCredentialAdmin(principal).catch(() => false)) throw new ApiError(404, 'NOT_FOUND', 'This API route could not be found.');
  const hosted = env.EDITION !== 'self-hosted';
  return {
    edition: hosted ? 'hosted' : 'self-hosted',
    superAdmins: hosted ? superAdminEmails(env.SUPER_ADMIN_EMAILS) : [],
    cloudflareOAuth: cloudflareSigninConfigured(env),
    email: emailConfigured(env),
    previewsWorker: env.PREVIEWS_WORKER_NAME ?? null,
    scopes: { signin: hosted ? signinScopes(env) : [], connect: requestedScopes(env), access: (env.CLOUDFLARE_ACCESS_SCOPES ?? '').split(/\s+/).filter(Boolean) },
  };
}

export async function operatorAiStatus(env: AppEnv, principal: Principal): Promise<OperatorAiStatus> {
  if (!await securityClient(env).installationCredentialAdmin(principal).catch(() => false)) throw new ApiError(404, 'NOT_FOUND', 'This API route could not be found.');
  if (env.EDITION === 'self-hosted') return { workspaces: [], triagePerDay: 0, recent: [] };
  const workspaces = (env.OPERATOR_MODEL_WORKSPACES ?? '').split(',').map(value => value.trim()).filter(Boolean);
  return { workspaces, triagePerDay: OPERATOR_TRIAGE_PER_DAY, recent: (await operatorLog(env).operatorAiLog()).slice(0, 50) };
}
