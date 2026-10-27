import { z } from 'zod';
import type { Mission } from '../../shared/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { repositoryId, missionId, requestKey, offset, pageLimit, readOnly, mutation, destructive, commit } from '../mcp-schemas';
import { page, missionSummary, guarded } from '../mcp-results';
import type { McpToolContext } from './context';

export function register(server: McpServer, { call }: McpToolContext): void {
  server.registerTool('gitflare_list_branches', {
    title: 'List repository branches', description: 'List branches (streams) with head SHA, protection and ahead/behind counts, plus the Git clone URL (use a personal token as the HTTP password). Read-only.',
    inputSchema: z.object({ repository_id: repositoryId, offset, limit: pageLimit }).strict(), annotations: readOnly,
  }, input => guarded(async () => { const { branches, ...metadata } = await call<{ branches: unknown[] } & Record<string, unknown>>(`/api/repositories/${input.repository_id}/branches`); return { ...metadata, ...page(branches, input.offset, input.limit) }; }));
  server.registerTool('gitflare_create_branch', {
    title: 'Create a branch', description: 'Create a branch at an existing branch or full commit SHA (default: default-branch head). Writes no commits; existing names are refused and protection rules apply as for git push. Needs contribute permission and write access.',
    inputSchema: z.object({ repository_id: repositoryId, name: z.string().min(1).max(200).describe('New branch name.'), from: z.string().min(1).max(200).optional().describe('Branch name or full commit SHA; defaults to the default-branch head.'), idempotency_key: requestKey }).strict(), annotations: mutation,
  }, input => guarded(async () => call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/branches`, { name: input.name, ...(input.from ? { from: input.from } : {}) }, input.idempotency_key)));
  server.registerTool('gitflare_delete_branch', {
    title: 'Delete a branch', description: 'Delete a branch ref. The default and protected branches cannot be deleted; pass expected_head_sha to refuse if it moved. Commits stay reachable from other refs. Needs contribute permission and write access.',
    inputSchema: z.object({ repository_id: repositoryId, name: z.string().min(1).max(200).describe('Branch to delete.'), expected_head_sha: commit.optional().describe('Refuse if the branch head differs.'), idempotency_key: requestKey }).strict(), annotations: destructive,
  }, input => guarded(async () => call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/branches/delete`, { name: input.name, ...(input.expected_head_sha ? { expectedHeadSha: input.expected_head_sha } : {}) }, input.idempotency_key)));
  server.registerTool('gitflare_create_pull_request', {
    title: 'Open a pull request from a branch', description: 'Open a pull request (proposal) from a pushed branch: records its head, merges it onto the default branch in an isolated fork and runs the repository checks. Conflicts (collisions) show as a failed check. Nothing reaches the default branch until approved and landed. On a fork, target upstream proposes it upstream instead; checks wait for a maintainer. Needs contribute permission and write access.',
    inputSchema: z.object({ repository_id: repositoryId, branch: z.string().min(1).max(200).describe('Pushed source branch.'), title: z.string().min(1).max(120), description: z.string().max(8000).optional().describe('Markdown description.'), target: z.enum(['self', 'upstream']).default('self').describe('self: this repository. upstream: the repository this fork came from.'), idempotency_key: requestKey }).strict(), annotations: mutation,
  }, input => guarded(async () => {
    const body = { branch: input.branch, title: input.title, ...(input.description ? { description: input.description } : {}), ...(input.target === 'upstream' ? { target: 'upstream' } : {}) };
    return input.target === 'upstream' ? call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/pulls`, body, input.idempotency_key) : missionSummary(await call<Mission>(`/api/repositories/${input.repository_id}/pulls`, body, input.idempotency_key));
  }));
  server.registerTool('gitflare_update_pull_request', {
    title: 'Update, close or reopen a pull request', description: 'Update (re-record the branch head and rerun checks), close (cancel checks and withdraw approval) or reopen a pull request. Update invalidates earlier approvals; landed pull requests cannot change. Needs write access.',
    inputSchema: z.object({ mission_id: missionId, action: z.enum(['update', 'close', 'reopen']), idempotency_key: requestKey }).strict(), annotations: destructive,
  }, input => guarded(async () => missionSummary(await call<Mission>(`/api/missions/${input.mission_id}/pull`, { action: input.action }, input.idempotency_key))));
  server.registerTool('gitflare_branch_protection', {
    title: 'Read branch protection', description: 'Read a repository’s branch protection rules: required approvals, required check names, self-approval and who may land, plus availableChecks: the check names a rule can require. The default branch is always protected. Read-only.',
    inputSchema: z.object({ repository_id: repositoryId }).strict(), annotations: readOnly,
  }, input => guarded(async () => call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/branch-protection`)));
  server.registerTool('gitflare_set_branch_protection', {
    title: 'Replace branch protection rules', description: 'Replace all branch protection rules of a repository. Rules set required approvals, required check names, self-approval, who may land and whether code owners (.gitflare/CODEOWNERS at the base commit) must approve changes to their paths; the default branch stays protected. Needs the Owner role and admin access.',
    inputSchema: z.object({ repository_id: repositoryId, rules: z.array(z.object({ pattern: z.string().min(1).max(200), requirePullRequest: z.boolean().default(true), requiredApprovals: z.number().int().min(0).max(6).default(1), requiredCheckNames: z.array(z.string().min(1).max(200)).max(20).default([]).describe('Names from availableChecks of gitflare_branch_protection, such as Combined candidate tests. Names already saved may stay; other names are refused.'), preventSelfApproval: z.boolean().default(false), restrictLanders: z.array(z.enum(['Maintainer', 'Owner'])).max(2).default([]), codeowners: z.boolean().default(false).describe('Require an approval from a code owner of every changed path that has owners.') }).strict()).max(20).describe('Complete rule set; replaces all existing rules.'), idempotency_key: requestKey }).strict(), annotations: destructive,
  }, input => guarded(async () => call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/branch-protection`, { rules: input.rules }, input.idempotency_key)));
}
