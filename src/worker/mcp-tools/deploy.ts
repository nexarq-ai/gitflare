import { z } from 'zod';
import { ENVIRONMENT_NAME } from '../deploy-environments';
import { ApiError } from '../domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { repositoryId, requestKey, readOnly, destructive, commit } from '../mcp-schemas';
import { guarded } from '../mcp-results';
import type { McpToolContext } from './context';

export function register(server: McpServer, { call }: McpToolContext): void {
  server.registerTool('gitflare_deployments', {
    title: 'Read repository deployments', description: 'Read a repository’s deploy settings per environment (production, staging and any other Wrangler env), each environment’s current commit, live Worker versions, pending and promotable deployments, the Workers linked to it, and the deployment history (environment, commit SHA, Worker versions, rollout percentage, status, actor, time, errors). canDeploy and canConfirm report what you may do. Read-only.',
    inputSchema: z.object({ repository_id: repositoryId, deployment_id: z.string().max(80).optional().describe('Return only this deployment.') }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => {
    const state = await call<{ deployments: { id: string }[] } & Record<string, unknown>>(`/api/repositories/${input.repository_id}/deployments`);
    if (!input.deployment_id || state.demo) return state;
    const deployment = state.deployments.find((item) => item.id === input.deployment_id);
    if (!deployment) throw new ApiError(404, 'DEPLOYMENT_NOT_FOUND', 'This deployment could not be found.');
    return { deployment };
  }));
  server.registerTool('gitflare_detect_deploy_setup', {
    title: 'Detect the deploy setup', description: 'Read the deploy setup Gitflare finds in a repository’s Wrangler configs: environments, Workers, build commands, D1 migrations and warnings, with a fingerprint to pass to gitflare_deploy apply_detected. Saves nothing. Read-only.',
    inputSchema: z.object({ repository_id: repositoryId }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/deployments/detect`)));
  server.registerTool('gitflare_deploy_access', {
    title: 'Read deploy environment Access protection', description: 'Read each deploy environment’s Cloudflare Access protection: status (protected, unprotected or error with the exact reason), Access application id, protected hostnames, allowed emails, domains or group, whether Gitflare created the application, and canChange. Read-only.',
    inputSchema: z.object({ repository_id: repositoryId, environment: z.string().regex(ENVIRONMENT_NAME).optional().describe('Return only this environment, e.g. staging.') }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => {
    const state = await call<{ environments: Record<string, { access?: unknown }>; demo?: unknown }>(`/api/repositories/${input.repository_id}/deployments`);
    if (state.demo) return state;
    const entries = Object.entries(state.environments).filter(([name]) => !input.environment || name === input.environment);
    if (input.environment && !entries.length) throw new ApiError(404, 'ENVIRONMENT_NOT_FOUND', `${input.environment} is not a deploy environment of this repository.`);
    return { environments: Object.fromEntries(entries.map(([name, value]) => [name, value.access ?? null])) };
  }));
  const manageDeployAccessTitle = 'Protect a deploy environment with Cloudflare Access';
  server.registerTool('gitflare_manage_deploy_access', {
    title: manageDeployAccessTitle, description: 'enable or update puts one self-hosted Cloudflare Access application with one allow policy in front of an environment’s live URLs, Wrangler routes, custom domains and workers.dev hostnames; remove deletes it only if Gitflare created it. Allow emails, email domains and/or an Access group id. Audited. Needs the Owner role, the Access scope and admin access.',
    inputSchema: z.object({ repository_id: repositoryId, environment: z.string().regex(ENVIRONMENT_NAME).describe('production or a Wrangler env name such as staging.'), action: z.enum(['enable', 'update', 'remove']), emails: z.array(z.string().min(3).max(254)).max(200).optional().describe('Email addresses allowed to sign in.'), domains: z.array(z.string().min(1).max(253)).max(50).optional().describe('Email domains allowed to sign in, e.g. example.com.'), group_id: z.string().max(64).optional().describe('Id of an existing Cloudflare Access group to allow.'), idempotency_key: requestKey }).strict(),
    annotations: { title: manageDeployAccessTitle, readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, (input) => guarded(async () => call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/deployments`, input.action === 'remove'
    ? { action: 'access', environment: input.environment, enabled: false }
    : { action: 'access', environment: input.environment, enabled: true, emails: input.emails ?? [], domains: input.domains ?? [], ...(input.group_id ? { groupId: input.group_id } : {}) }, input.idempotency_key)));
  server.registerTool('gitflare_deploy', {
    title: 'Deploy a landed commit to Cloudflare', description: 'Deploy landed commits to production (top level) or any Wrangler env (staging, qa…). apply_detected saves the setup from gitflare_detect_deploy_setup and links its Workers; settings configures one environment; deploy builds the head or confirms a pending deployment; promote sends a successful deployment to production; rollback restores one. Needs land access.',
    inputSchema: z.object({ repository_id: repositoryId, action: z.enum(['apply_detected', 'settings', 'deploy', 'promote', 'rollback']), environment: z.string().regex(ENVIRONMENT_NAME).optional().describe('production or a Wrangler env name such as staging or qa. Required for settings; for deploy and rollback when several environments are configured; for promote the destination (default production); for apply_detected only that environment.'), from: z.string().regex(ENVIRONMENT_NAME).optional().describe('For promote: promote the latest successful deployment of this environment.'), fingerprint: z.string().max(64).optional().describe('For apply_detected: the fingerprint gitflare_detect_deploy_setup returned, so only the reviewed setup is saved.'), acknowledge_warnings: z.array(z.string().max(400)).max(50).optional().describe('For apply_detected: warning ids from gitflare_detect_deploy_setup an Owner acknowledges before non-production environments are enabled.'), commit_sha: commit.optional().describe('For deploy: the current default-branch head.'), deployment_id: z.string().max(80).optional().describe('For deploy: a deployment awaiting confirmation. For promote: the deployment to promote (default: the latest successful non-production one).'), confirm: z.boolean().optional().describe('For production deploy and promote: an Owner confirms now instead of leaving it waiting for confirmation.'), enabled: z.boolean().optional().describe('For settings: deploy on land.'), worker_name: z.string().max(63).optional().describe('For settings without targets: a Worker linked to this repository, built from the root Wrangler config with its existing bindings kept.'), targets: z.union([z.literal('all'), z.array(z.string().max(63)).min(1).max(5), z.array(z.object({ worker_name: z.string().max(63).describe('The Worker Wrangler resolves for this environment, e.g. prahari-api-staging.'), config_path: z.string().max(300).describe('Repository-relative Wrangler config, e.g. apps/api/wrangler.jsonc.'), build_command: z.string().max(500).optional().describe('Runs at the repository root (with CLOUDFLARE_ENV set outside production) before Wrangler reads the config, e.g. pnpm --filter @app/web build.'), d1_migrations: z.boolean().optional().describe('Apply pending migrations_dir files through the D1 API before deploying.'), watch_paths: z.array(z.string().max(201)).max(20).optional().describe('Globs (prefix ! to exclude); on land the target deploys only when the landed change touches a match. Empty: always.') }).strict()).min(1).max(5)]).optional().describe('For settings: target objects, deployed in order. For deploy: "all" (default) or the Worker names to deploy, e.g. ["prahari-web"].'), mode: z.enum(['deploy', 'upload-only']).optional().describe('For settings: upload-only uploads versions without deploying them.'), rollout: z.enum(['immediate', 'gradual']).optional(), trigger: z.enum(['manual', 'auto']).optional().describe('For settings: deploy after landing automatically or wait (production auto: Owner only).'), confirmation: z.enum(['manual', 'auto']).optional().describe('Earlier name for trigger.'), idempotency_key: requestKey }).strict(), annotations: { ...destructive, openWorldHint: true, idempotentHint: false },
  }, (input) => guarded(async () => {
    const path = `/api/repositories/${input.repository_id}/deployments`;
    const environment = input.environment ? { environment: input.environment } : {};
    const body = input.action === 'apply_detected'
      ? { action: 'apply_detected', ...environment, fingerprint: input.fingerprint, ...(input.acknowledge_warnings ? { acknowledge: input.acknowledge_warnings } : {}) }
      : input.action === 'settings'
      ? { action: 'settings', ...environment, enabled: input.enabled, workerName: input.worker_name, rollout: input.rollout, trigger: input.trigger ?? input.confirmation, mode: input.mode, ...(input.targets !== undefined ? { targets: Array.isArray(input.targets) ? input.targets.map((target) => typeof target === 'string' ? target : { workerName: target.worker_name, configPath: target.config_path, buildCommand: target.build_command, d1Migrations: target.d1_migrations ?? false, watchPaths: target.watch_paths }) : input.targets } : {}) }
      : input.action === 'deploy' ? { action: 'deploy', ...environment, ...(input.deployment_id ? { deploymentId: input.deployment_id } : { commitSha: input.commit_sha, ...(input.targets !== undefined ? { targets: input.targets } : {}) }), ...(input.confirm !== undefined ? { confirm: input.confirm } : {}) }
      : input.action === 'promote' ? { action: 'promote', ...environment, ...(input.from ? { from: input.from } : {}), ...(input.deployment_id ? { deploymentId: input.deployment_id } : {}), ...(input.confirm !== undefined ? { confirm: input.confirm } : {}) }
      : { action: 'rollback', ...environment };
    return call<Record<string, unknown>>(path, body, input.idempotency_key);
  }));
}
