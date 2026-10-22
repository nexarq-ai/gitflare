import { z } from 'zod';
import type { Workspace } from '../../shared/types';
import { ApiError } from '../domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { readOnly, destructive, accessId, userId } from '../mcp-schemas';
import { guarded } from '../mcp-results';
import type { McpToolContext } from './context';

export function register(server: McpServer, { call, origin }: McpToolContext): void {
  server.registerTool('gitflare_access_status', {
    title: 'Read workspace access', description: 'Read your identity, role, memberships, teams, invitations, task credentials, sessions, protection rules and the audit events your role may see. Read-only.',
    inputSchema: z.object({}).strict(), annotations: readOnly,
  }, () => guarded(async () => call<Record<string, unknown>>('/api/access')));
  server.registerTool('gitflare_list_workspaces', {
    title: 'List my workspaces', description: 'List every workspace your account belongs to with your role, whether you see only some repositories, and which one this connection uses. With repository_id, list only your workspaces that contain that repository and that you can see. This connection stays bound to the workspace you approved; switching is a browser session action. Read-only.',
    inputSchema: z.object({ repository_id: z.string().min(1).max(200).optional().describe('Find which of your workspaces holds this repository ID.') }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => call<Record<string, unknown>>(input.repository_id ? `/api/workspaces/locate?repository=${encodeURIComponent(input.repository_id)}` : '/api/workspaces')));
  const memberRole = z.enum(['Viewer', 'Triager', 'Contributor', 'Reviewer', 'Maintainer', 'Deployer']).describe('Workspace role. Owner is assigned only with transfer.');
  const accessAction = <A extends string, S extends z.ZodRawShape>(action: A, shape: S, description: string) => z.object({ action: z.literal(action), ...shape }).strict().describe(description);
  const ACCESS_BROWSER: Record<string, { path: string; reason: string }> = {
    'accept-invite': { path: '/settings', reason: 'Paste the invitation capability under Settings → Access → People & teams → Join another workspace.' },
    'user-create': { path: '/settings', reason: 'Set the new user’s password under Settings → Access → People & teams → Create a user.' },
    'mfa-enroll': { path: '/account/security', reason: 'Scan the authenticator code under Account → Security.' },
  };
  server.registerTool('gitflare_manage_access', {
    title: 'Manage workspace access', description: 'Change access with operation.action: invitations to a workspace, repository or all your workspaces (send, resend, withdraw), roles and repository scope, ownership transfer, teams, grants, task credentials, protection, sessions, create, rename or leave a workspace, agent claims, verification email. Can remove members and revoke credentials. Some return a browser URL. Tokens show once. Mostly Owner only; admin access.',
    inputSchema: z.object({ operation: z.discriminatedUnion('action', [
      accessAction('invite', { email: z.string().email().max(254), role: memberRole, scope: z.enum(['workspace', 'repository', 'organization']).optional().describe('workspace (default): this workspace. repository: only repositoryId. organization: every workspace you own now and later.'), repositoryId: accessId.optional().describe('For repository scope: the only repository they will see.') }, 'Invite someone by email. Returns an invitation capability shown once.'),
      accessAction('organization-remove', { userId }, 'Stop adding someone to your future workspaces and remove them from every workspace you own.'),
      accessAction('workspace-create', { name: z.string().min(1).max(100) }, 'Create a workspace you own. People invited to all your workspaces join it.'),
      accessAction('invite-revoke', { id: accessId.describe('Invitation ID.') }, 'Withdraw a pending invitation.'),
      accessAction('invite-resend', { id: accessId.describe('Invitation ID.') }, 'Send a pending or expired invitation again with a new capability valid for 24 hours; the previous one stops working.'),
      accessAction('workspace-rename', { name: z.string().min(1).max(100) }, 'Rename this workspace. Owner only.'),
      accessAction('leave', {}, 'Leave this workspace yourself. Refused for its only Owner and for your only workspace. This connection stops working.'),
      accessAction('accept-invite', {}, 'Returns a browser URL; the invitation capability is entered there.'),
      accessAction('membership', { userId, role: memberRole.nullable().optional().describe('New role, or null to remove the member and revoke their sessions, credentials and grants.'), repositoryIds: z.array(accessId).max(100).nullable().optional().describe('Restrict the member to these repositories; null restores access to all.') }, 'Change a member’s role or repository scope, or remove them.'),
      accessAction('transfer', { userId }, 'Transfer workspace ownership; you become a Maintainer. Needs a sign-in within five minutes.'),
      accessAction('team-create', { name: z.string().min(1).max(100) }, 'Create a team.'),
      accessAction('team-member', { teamId: accessId.describe('Team ID.'), userId, remove: z.boolean().optional().describe('true removes the member from the team.') }, 'Add a member to a team or remove them.'),
      accessAction('grant', { subjectType: z.enum(['user', 'team']), subjectId: accessId, resourceType: z.enum(['repository', 'stream', 'environment', 'secret', 'database']), resourceId: accessId, actions: z.array(z.enum(['read', 'participate', 'triage', 'contribute', 'execute', 'review', 'land', 'deploy', 'migrate'])).min(1).max(9) }, 'Grant a user or team actions on one resource.'),
      accessAction('grant-revoke', { id: accessId.describe('Grant ID.') }, 'Revoke a resource grant.'),
      accessAction('credential-create', { name: z.string().min(1).max(100), repositoryId: accessId.describe('Repository the credential is bound to.'), missionId: accessId.optional().describe('Limit the credential to one mission.'), actions: z.array(z.enum(['read', 'contribute', 'execute'])).min(1).max(3), expiresInSeconds: z.number().int().min(1).max(86400), maxRequests: z.number().int().min(1).max(1000), maxExecutions: z.number().int().min(1).max(10) }, 'Issue a bounded task credential for a coding agent. Returns its token once.'),
      accessAction('credential-revoke', { id: accessId.describe('Credential ID.') }, 'Revoke a task credential.'),
      accessAction('protection', { requiredApprovals: z.number().int().min(1).max(10), requiredChecks: z.array(z.string().min(1).max(100)).max(20), preventSelfApproval: z.boolean() }, 'Replace the workspace landing protection.'),
      accessAction('session-create', {}, 'Create a personal MCP session token for your account. Needs a recent sign-in.'),
      accessAction('session-revoke', { id: accessId.describe('Session ID.') }, 'Revoke one of your sessions and the client grants derived from it.'),
      accessAction('user-create', {}, 'Self-hosted: returns a browser URL; the password is set there.'),
      accessAction('agent-claim', { claimToken: z.string().min(1).max(128).describe('Claim token the agent account received at sign-up.') }, 'Hosted: claim an agent-created workspace as its Owner.'),
      accessAction('mfa-enroll', {}, 'Returns a browser URL; the authenticator secret is shown there.'),
      accessAction('email-verification-resend', {}, 'Send your account a new verification email.'),
    ]).describe('The access action and its fields.') }).strict(), annotations: { ...destructive, idempotentHint: false },
  }, ({ operation: { action, ...parameters } }) => guarded(async () => {
    const browser = ACCESS_BROWSER[action];
    if (browser) return { browserStartUrl: `${origin}${browser.path}`, browserEntryRequired: true, reason: browser.reason };
    return call<Record<string, unknown>>(action === 'email-verification-resend' ? '/api/auth/resend-verification' : action === 'workspace-create' ? '/api/workspaces/create' : `/api/access/${action}`, parameters);
  }));
  server.registerTool('gitflare_manage_sessions', {
    title: 'Sign out sessions',
    description: 'Sign out browser sessions of your account. sign-out-others signs out every browser session of your account except the one this connection uses; AI clients and personal tokens stay. sign-out ends one session by ID (session IDs from gitflare_access_status) and the client grants derived from it. Needs admin access.',
    inputSchema: z.object({ action: z.enum(['sign-out-others', 'sign-out']), session_id: accessId.optional().describe('For sign-out: the session to end.') }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, (input) => guarded(async () => {
    if (input.action === 'sign-out-others') {
      if (input.session_id !== undefined) throw new ApiError(400, 'INVALID_INPUT', 'session_id applies only to sign-out.');
      return call<Record<string, unknown>>('/api/account/sessions/revoke-others', {});
    }
    if (!input.session_id) throw new ApiError(400, 'INVALID_INPUT', 'Pass session_id for sign-out.');
    return call<Record<string, unknown>>('/api/access/session-revoke', { id: input.session_id });
  }));
}

export function registerWorkspaceStatus(server: McpServer, { call }: McpToolContext): void {
  server.registerTool('gitflare_workspace_status', {
    title: 'Inspect workspace setup and MCP capabilities', description: 'Read workspace mode, service readiness, the MCP endpoint, authentication mode and tool list. Configuration is not proof that a client connected or a run succeeded. Read-only.',
    inputSchema: z.object({}).strict(), annotations: readOnly,
  }, () => guarded(async () => {
    const [workspace, mcp] = await Promise.all([call<Workspace>('/api/workspace'), call<Record<string, unknown>>('/api/mcp')]);
    return { name: workspace.name, mode: workspace.mode, integrations: workspace.integrations, repositoryCount: workspace.repositories.length, missionCount: workspace.missions.length, mcp };
  }));
}
