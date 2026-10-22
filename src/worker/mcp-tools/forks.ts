import { z } from 'zod';
import type { Mission } from '../../shared/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { repositoryId, missionId, requestKey, offset, pageLimit, readOnly, mutation, destructive, external, handleValue, publicRepositoryName } from '../mcp-schemas';
import { page, missionSummary, guarded } from '../mcp-results';
import type { McpToolContext } from './context';

export function register(server: McpServer, { call }: McpToolContext): void {
  server.registerTool('gitflare_fork_repository', {
    title: 'Fork a public repository', description: 'Copy the default branch of a public repository into this connection’s workspace as a private fork linked to its upstream. Push streams to the fork with a personal token from that workspace, then propose them upstream. Needs an Owner of this workspace; forks hold at most 1 GiB. Needs write access.',
    inputSchema: z.object({ handle: handleValue.describe('Owner handle from the public address.'), repository: publicRepositoryName, name: z.string().min(1).max(64).optional().describe('Name for the fork; defaults to the upstream name.'), idempotency_key: requestKey }).strict(), annotations: mutation,
  }, (input) => guarded(async () => call<Record<string, unknown>>('/api/forks', { handle: input.handle, repository: input.repository, ...(input.name ? { name: input.name } : {}) }, input.idempotency_key)));
  server.registerTool('gitflare_fork_status', {
    title: 'Read a fork’s upstream status', description: 'Read a fork’s upstream link and address, whether its default branch is up to date, behind, ahead or diverged, the storage it uses against its 1 GiB limit, and whether you can sync or propose. Read-only.',
    inputSchema: z.object({ repository_id: repositoryId }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/fork`)));
  server.registerTool('gitflare_sync_fork', {
    title: 'Sync a fork from upstream', description: 'Fast-forward the fork’s default branch to the upstream default branch. Refused when the fork has commits upstream doesn’t (work on a stream instead), when upstream is no longer public, or past the storage limit. Needs land permission on the fork and write access.',
    inputSchema: z.object({ repository_id: repositoryId, idempotency_key: requestKey }).strict(), annotations: mutation,
  }, (input) => guarded(async () => call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/fork/sync`, {}, input.idempotency_key)));
  server.registerTool('gitflare_run_checks', {
    title: 'Run checks on a proposal', description: 'Record the proposal stream’s current head and run the repository checks. For a proposal from a fork this is the maintainer gate: checks run without secrets, previews or Cloudflare bindings, with gitflare.json read from the upstream base. Uses billed compute. Needs the Owner or Maintainer role and land access.',
    inputSchema: z.object({ mission_id: missionId, idempotency_key: requestKey }).strict(), annotations: external,
  }, (input) => guarded(async () => missionSummary(await call<Mission>(`/api/missions/${input.mission_id}/run-checks`, {}, input.idempotency_key))));
  server.registerTool('gitflare_upstream_proposals', {
    title: 'Read proposals sent upstream from a fork', description: 'List the proposals this fork opened in its upstream repository, or read one, with state, whether it waits for a maintainer, check results and review comments. Read-only.',
    inputSchema: z.object({ repository_id: repositoryId, mission_id: missionId.optional().describe('Proposal ID from the list; omit to list.'), offset, limit: pageLimit }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => {
    if (input.mission_id) return call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/upstream-proposals/${input.mission_id}`);
    const { proposals, ...rest } = await call<{ proposals: unknown[] } & Record<string, unknown>>(`/api/repositories/${input.repository_id}/upstream-proposals`);
    return { ...rest, ...page(proposals, input.offset, input.limit) };
  }));
  server.registerTool('gitflare_update_upstream_proposal', {
    title: 'Update, close or reopen a proposal sent upstream', description: 'For a proposal this fork opened upstream: update records the stream’s new head (earlier approvals no longer apply and checks wait for a maintainer unless you are a known contributor), close withdraws it, reopen opens it again. Needs contribute permission on the fork and write access.',
    inputSchema: z.object({ repository_id: repositoryId, mission_id: missionId, action: z.enum(['update', 'close', 'reopen']), idempotency_key: requestKey }).strict(), annotations: destructive,
  }, (input) => guarded(async () => call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/upstream-proposals/${input.mission_id}`, { action: input.action }, input.idempotency_key)));
}
