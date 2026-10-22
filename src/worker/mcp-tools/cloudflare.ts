import { z } from 'zod';
import { ApiError } from '../domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { repositoryId, readOnly, external, commit } from '../mcp-schemas';
import { guarded } from '../mcp-results';
import type { McpToolContext } from './context';

export function register(server: McpServer, { call, origin }: McpToolContext): void {
  const cloudflareRepository = repositoryId.optional().describe('Act on this repository’s own Cloudflare connection instead of the workspace connection.');
  const cloudflareGrant = z.string().uuid().optional().describe('Cloudflare login ID (grantId) from connected-accounts.');
  const requireGrant = (grant?: string) => { if (!grant) throw new ApiError(400, 'GRANT_REQUIRED', 'Pass grant_id from connected-accounts.'); return grant; };
  const cloudflareBase = (repository?: string) => repository ? `/api/repositories/${encodeURIComponent(repository)}/cloudflare/connection` : '/api/cloudflare';
  server.registerTool('gitflare_cloudflare_connection', {
    title: 'Read the Cloudflare connection', description: 'Read the workspace (or repository_id) Cloudflare connection: status, the accounts it can reach, or its resources. connected-accounts lists the accounts this workspace uses and its default; login-accounts lists what one login (grant_id) can reach. installation-credential reads the self-hosted previews fallback. Credentials are never returned. Read-only.',
    inputSchema: z.object({ action: z.enum(['status', 'accounts', 'resources', 'connected-accounts', 'login-accounts', 'installation-credential']).default('status'), repository_id: cloudflareRepository, grant_id: cloudflareGrant, include_gitflare: z.boolean().optional().describe('For resources on the account that hosts this installation: also list Gitflare’s own Workers, namespaces, containers and workflows, marked gitflare. They are hidden by default and can never be linked.') }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => {
    if (input.action === 'installation-credential') return call<Record<string, unknown>>('/api/cloudflare/installation-credential');
    if (input.action === 'connected-accounts') return call<Record<string, unknown>>('/api/cloudflare/connected-accounts');
    if (input.action === 'login-accounts') return call<Record<string, unknown>>(`/api/cloudflare/logins/${encodeURIComponent(requireGrant(input.grant_id))}/accounts`);
    const base = cloudflareBase(input.repository_id);
    if (input.action === 'resources') return call<Record<string, unknown>>(`${base}/resources${input.include_gitflare ? '?includeGitflare=true' : ''}`);
    return call<Record<string, unknown>>(input.action === 'status' && input.repository_id ? base : `${base}/${input.action}`);
  }));
  server.registerTool('gitflare_manage_cloudflare_connection', {
    title: 'Connect or change the Cloudflare connection', description: 'Change the workspace (or repository_id) Cloudflare connection. connect and add-login return a browser URL and the permissions with reasons; select-account and disconnect change it. account-put, account-remove and account-default manage connected accounts; login-disconnect removes a login. installation-* actions set the previews fallback. Needs the Owner role and admin access.',
    inputSchema: z.object({ action: z.enum(['connect', 'add-login', 'select-account', 'disconnect', 'account-put', 'account-remove', 'account-default', 'login-disconnect', 'installation-credential-setup', 'installation-credential-remove', 'installation-connection-use', 'installation-connection-remove']), accountId: z.string().regex(/^[a-f0-9]{32}$/).optional().describe('Cloudflare account ID for select-account, disconnect, account-put, account-remove, account-default or installation-connection-use.'), grant_id: cloudflareGrant, features: z.array(z.enum(['deploy', 'previews', 'secrets', 'access'])).max(4).optional().describe('For connect: features to add permissions for (deploy, previews, secrets, access). Permissions already granted are kept.'), workerName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,52}$/).optional().describe('Previews Worker name for installation-connection-use; defaults to the installation’s configured name.'), repository_id: cloudflareRepository }).strict(), annotations: { ...external, destructiveHint: true },
  }, (input) => guarded(async () => {
    if (input.action === 'installation-connection-use') return call<Record<string, unknown>>('/api/cloudflare/installation-credential/connection', { ...(input.accountId ? { accountId: input.accountId } : {}), ...(input.workerName ? { workerName: input.workerName } : {}) });
    if (input.action === 'installation-connection-remove') return call<Record<string, unknown>>('/api/cloudflare/installation-credential/connection-remove', {});
    if (input.action === 'installation-credential-remove') return call<Record<string, unknown>>('/api/cloudflare/installation-credential/remove', {});
    if (input.action === 'installation-credential-setup') {
      const status = await call<Record<string, unknown>>('/api/cloudflare/installation-credential');
      return { browserStartUrl: `${origin}/settings/cloudflare`, browserEntryRequired: true, manageable: status.manageable, state: status.state };
    }
    if (input.action === 'add-login') {
      const features = input.features ? `?features=${input.features.join(',')}` : '';
      return { browserStartUrl: `${origin}/settings/cloudflare${features}${features ? '&' : '?'}login=new`, browserAuthorizationRequired: true, reason: 'Another Cloudflare user signs in to Cloudflare in the browser; their accounts can then be added to this workspace.' };
    }
    if (input.action === 'account-put') return call<Record<string, unknown>>('/api/cloudflare/account-put', { accountId: input.accountId, ...(input.grant_id ? { grantId: input.grant_id } : {}) });
    if (input.action === 'account-remove' || input.action === 'account-default') return call<Record<string, unknown>>(`/api/cloudflare/${input.action}`, { accountId: input.accountId });
    if (input.action === 'login-disconnect') return call<Record<string, unknown>>(`/api/cloudflare/logins/${encodeURIComponent(requireGrant(input.grant_id))}/disconnect`, {});
    const base = cloudflareBase(input.repository_id);
    if (input.action === 'connect') {
      const features = input.features ? `?features=${input.features.join(',')}` : '';
      const status = await call<{ permissions?: { docsUrl?: string } }>(`${base}${features}`);
      const permissions = status.permissions ? { ...status.permissions, ...(status.permissions.docsUrl ? { docsUrl: `${origin}${status.permissions.docsUrl}` } : {}) } : undefined;
      return { browserStartUrl: `${input.repository_id ? `${origin}/repository/${encodeURIComponent(input.repository_id)}/cloudflare` : `${origin}/settings/cloudflare`}${features}`, browserAuthorizationRequired: true, ...(permissions ? { permissions } : {}) };
    }
    return call<Record<string, unknown>>(`${base}/${input.action}`, { accountId: input.accountId });
  }));
  server.registerTool('gitflare_cloudflare_project', {
    title: 'Read project Cloudflare resources', description: 'Read a repository’s mapped Cloudflare resources (Workers, D1, Durable Objects, Containers, Workflows) with action get, or their usage with action usage. Read-only.',
    inputSchema: z.object({ repositoryId: repositoryId, action: z.enum(['get', 'usage']).default('get') }).strict(), annotations: readOnly,
  }, ({ repositoryId, action }) => guarded(async () => call<Record<string, unknown>>(`/api/repositories/${repositoryId}/cloudflare${action === 'usage' ? '/usage' : ''}`)));
  server.registerTool('gitflare_manage_cloudflare_project', {
    title: 'Map resources or run a D1 migration', description: 'Replace a repository’s Cloudflare resource mapping (map), choose the connected account the repository or one environment uses (account), pin a D1 SQL migration file at a commit (migration-plan), or apply a pinned plan (migration-execute). migration-execute changes database data and schema and is never retried after an uncertain result. Needs the Owner role and admin access.',
    inputSchema: z.object({ repositoryId: repositoryId, action: z.enum(['map', 'account', 'migration-plan', 'migration-execute']).describe('map replaces the resource mapping; account chooses the Cloudflare account; migration-plan pins a SQL file; migration-execute applies a plan.'), accountId: z.string().regex(/^[a-f0-9]{32}$/).nullable().optional().describe('For account: a connected account ID, or null to use the workspace default.'), environment: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).optional().describe('For account: the environment to choose for; omit for the whole repository.'), resources: z.array(z.object({ type: z.enum(['worker','d1','durable_object','container','workflow']), id: z.string().min(1).max(128), name: z.string().max(200), environment: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/) }).strict()).max(100).optional(), databaseId: z.string().uuid().optional(), workerName: z.string().max(64).optional(), d1DatabaseId: z.string().max(36).optional(), durableObjectNamespaceId: z.string().max(36).optional(), commitSha: commit.optional(), path: z.string().max(500).optional(), planId: z.string().uuid().optional().describe('Plan ID from migration-plan.'), checksum: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Exact plan checksum from migration-plan.') }).strict(), annotations: { ...external, destructiveHint: true },
  }, ({ repositoryId, action, ...fields }) => guarded(async () => call<Record<string, unknown>>(`/api/repositories/${repositoryId}/cloudflare/action`, { action, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) })));
}
