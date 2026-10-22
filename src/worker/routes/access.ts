import { ApiError, assertMutationOrigin, readJson, requireString } from '../domain';
import { personalWorkspaceId, type InvitationScope } from '../security';
import { revokeClientGrants } from '../oauth';
import { deliverInvitation } from '../email';
import { ADMIN_PUBLIC_INDEX_PATH, ADMIN_STATUS_PATH, installationAdminStatus, OPERATOR_AI_PATH, operatorAiStatus, rebuildPublicIndex } from '../installation-admin';
import { siteOrigin } from '../public-repositories';
import { accountDiscoveryApi, handleChanged } from '../public-discovery';
import { type RouteContext, catalogName, workspaceName } from '../route-context';
import { authorize } from '../request-auth';

export async function accessRoutes(context: Omit<RouteContext, 'catalog'>, application: Parameters<typeof revokeClientGrants>[2]): Promise<Response | null> {
  const { request, url, env, ctx, principal, access } = context;
  if (url.pathname === '/api/access' && request.method === 'GET') {
    const [snapshot, name] = await Promise.all([access.snapshot(principal), workspaceName(env, access, principal)]);
    return Response.json({ ...snapshot, workspace: snapshot.workspace ? { ...snapshot.workspace, name } : snapshot.workspace, workspaces: snapshot.workspaces.map((workspace) => workspace.id === principal.workspaceId ? { ...workspace, name } : workspace) });
  }
  if (url.pathname === '/api/account' && request.method === 'GET') return Response.json(await access.account(principal), { headers: { 'Cache-Control': 'no-store' } });
  if (url.pathname === '/api/account/sessions/revoke-others' && request.method === 'POST') { assertMutationOrigin(request); return Response.json(await access.revokeOtherSessions(principal)); }
  if (url.pathname === ADMIN_STATUS_PATH && request.method === 'GET') return Response.json(await installationAdminStatus(env, principal), { headers: { 'Cache-Control': 'no-store' } });
  if (url.pathname === OPERATOR_AI_PATH && request.method === 'GET') return Response.json(await operatorAiStatus(env, principal), { headers: { 'Cache-Control': 'no-store' } });
  if (url.pathname === ADMIN_PUBLIC_INDEX_PATH && request.method === 'POST') { assertMutationOrigin(request); return Response.json(await rebuildPublicIndex(env, principal), { headers: { 'Cache-Control': 'no-store' } }); }
  if (url.pathname === '/api/admin/reports' && request.method === 'GET') return Response.json(await access.reports(principal));
  const dismissReport = /^\/api\/admin\/reports\/([a-f0-9-]{36})\/dismiss$/.exec(url.pathname);
  if (dismissReport && request.method === 'POST') { assertMutationOrigin(request); return Response.json(await access.dismissReport(principal, dismissReport[1]!)); }
  if (url.pathname === '/api/workspaces' && request.method === 'GET') {
    const [items, name] = await Promise.all([access.workspaces(principal), workspaceName(env, access, principal)]);
    return Response.json({ workspaces: items.map(item => item.current ? { ...item, name } : item) });
  }
  if (url.pathname === '/api/workspaces/locate' && request.method === 'GET') {
    const repositoryId = requireString(url.searchParams.get('repository'), 'Repository', 200);
    const candidates: string[] = [];
    for (const item of await access.workspaces(principal)) if (await env.GITFLARE_COORDINATOR.getByName(catalogName(item.id)).getRepository(repositoryId)) candidates.push(item.id);
    const workspaces = await access.locateRepository(principal, repositoryId, candidates);
    if (!workspaces.length) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'None of your workspaces has this repository, or you cannot see it.');
    return Response.json({ repositoryId, workspaces });
  }
  if (url.pathname === '/api/workspaces/switch' && request.method === 'POST') {
    assertMutationOrigin(request); const body = await readJson(request);
    return Response.json(await access.switchWorkspace(principal, requireString(body.workspaceId, 'Workspace', 100)));
  }
  if (url.pathname === '/api/workspaces/create' && request.method === 'POST') {
    assertMutationOrigin(request); const body = await readJson(request);
    return Response.json(await access.createWorkspace(principal, body));
  }
  if (url.pathname === '/api/handles' && request.method === 'GET') return Response.json(await access.handles(principal, siteOrigin(env, url.origin)));
  if (url.pathname === '/api/handles/check' && request.method === 'GET') return Response.json(await access.checkHandle(principal, url.searchParams.get('scope') === 'workspace' ? 'workspace' : 'user', url.searchParams.get('handle') ?? ''));
  if (url.pathname === '/api/handles' && request.method === 'POST') {
    assertMutationOrigin(request); const body = await readJson(request, 4096);
    if (body.scope !== 'user' && body.scope !== 'workspace') throw new ApiError(400, 'INVALID_INPUT', 'Choose the user or workspace handle.');
    const workspaceId = body.scope === 'workspace' ? principal.workspaceId : (() => { try { return personalWorkspaceId(principal.userId); } catch { return null; } })();
    const previous = workspaceId ? await access.handleOf(workspaceId).catch(() => null) : null;
    const status = await access.setHandle(principal, body.scope, String(body.handle ?? ''), siteOrigin(env, url.origin));
    if (workspaceId && (body.scope === 'user' ? status.user.handle : status.workspace.handle) !== previous) await handleChanged(env, ctx, workspaceId, previous, url.origin);
    return Response.json(status);
  }
  const discoveryAccount = await accountDiscoveryApi(request, env, ctx, principal, access);
  if (discoveryAccount) return discoveryAccount;
  if (url.pathname.startsWith('/api/access/') && request.method === 'POST') {
    assertMutationOrigin(request); const body = await readJson(request); const action = url.pathname.slice('/api/access/'.length);
    if (action === 'invite') { delete body.repositoryName; delete body.ownerName; }
    if (action === 'workspace-rename' && principal.workspaceId === 'legacy' && env.WORKSPACE_NAME) throw new ApiError(409, 'WORKSPACE_NAME_FIXED', 'This installation sets the workspace name with WORKSPACE_NAME. Change it there.');
    if (action === 'invite' && body.scope === 'repository') { const repository = await env.GITFLARE_COORDINATOR.getByName(catalogName(principal.workspaceId)).getRepository(String(body.repositoryId ?? '')); if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'Select a repository in this workspace.'); body.repositoryName = repository.name; }
    const inviterName = (action === 'invite' || action === 'invite-resend') && !principal.bootstrap ? (await access.snapshot(principal)).user.name : undefined;
    if (action === 'invite' && body.scope === 'organization') body.ownerName = inviterName;
    if (action === 'accept-invite') return Response.json(await access.acceptInvite(principal, requireString(body.token, 'Invitation token', 128)));
    if (action === 'membership' && body.repositoryIds !== undefined) { if (!Array.isArray(body.repositoryIds)) throw new ApiError(400, 'INVALID_SCOPE', 'Provide repository IDs.'); const catalog = env.GITFLARE_COORDINATOR.getByName(catalogName(principal.workspaceId)); for (const id of body.repositoryIds) if (typeof id !== 'string' || !await catalog.getRepository(id)) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'Every scoped repository must belong to this workspace.'); }
    if (action === 'credential-create') { const catalog = env.GITFLARE_COORDINATOR.getByName(catalogName(principal.workspaceId)); if (!await catalog.getRepository(String(body.repositoryId))) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'Select a repository in this workspace.'); }
    const result = await access.action(principal, action, body);
    if (action === 'session-revoke' && typeof body.id === 'string') await revokeClientGrants(env, url.origin, application, authorize, principal.userId, body.id);
    if ((action === 'invite' || action === 'invite-resend') && result && typeof result === 'object' && 'token' in result && typeof result.token === 'string' && 'invitation' in result) {
      const invitation = result.invitation as { email: string; role?: string; scope?: InvitationScope };
      const scope = invitation.scope?.kind === 'organization' ? { kind: 'organization' as const, ownerName: invitation.scope.ownerName ?? '' } : invitation.scope?.kind === 'repository' ? { kind: 'repository' as const, repositoryName: invitation.scope.repositoryName ?? '' } : { kind: 'workspace' as const };
      const delivery = await deliverInvitation(env, { email: invitation.email, token: result.token, workspaceName: await workspaceName(env, access, principal), origin: url.origin, role: invitation.role, scope, inviterName });
      return Response.json({ ...result, delivery });
    }
    return Response.json(result);
  }
  return null;
}
