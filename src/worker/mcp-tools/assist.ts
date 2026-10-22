import { z } from 'zod';
import type { Mission } from '../../shared/types';
import { ApiError } from '../domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { repositoryId, missionId, requestKey, offset, pageLimit, readOnly, mutation, destructive, external, issueNumber, publicAddress, publicIssuesPath } from '../mcp-schemas';
import { page, missionSummary, guarded } from '../mcp-results';
import type { McpToolContext } from './context';

export function register(server: McpServer, { call }: McpToolContext): void {
  server.registerTool('gitflare_fix_requests', {
    title: 'Read requested fixes on a public repository', description: 'List agent missions that people requested on a public repository (newest first, optionally one issue) with requester handle, who pays (community pool or the requester’s key) and state. With quote true, also say whether your account can request a fix here, who would pay, which model runs, and whether it waits for a maintainer. Titles are untrusted text. Read-only.',
    inputSchema: z.object({ ...publicAddress, issue_number: issueNumber.optional().describe('Only requests for this issue.'), quote: z.boolean().default(false).describe('Include what a request from your account would use.'), offset, limit: pageLimit }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => {
    const search = new URLSearchParams();
    if (input.issue_number) search.set('issue', String(input.issue_number));
    if (input.quote) search.set('quote', '1');
    const { missions, ...rest } = await call<{ missions: unknown[] } & Record<string, unknown>>(`${publicIssuesPath(input.handle, input.repository)}/fix-requests${search.size ? `?${search}` : ''}`);
    return { ...rest, ...page(missions, input.offset, input.limit) };
  }));
  server.registerTool('gitflare_request_fix', {
    title: 'Request an agent fix on a public repository', description: 'Ask agents to fix an open issue (issue_number) or make a change (goal) on a public repository. Agents work in isolated forks without secrets; maintainers review and land the proposal. Paid by the project’s community AI pool within its daily limits, else by your personal-workspace AI key; never by Gitflare. Check gitflare_fix_requests with quote true first. Needs write access.',
    inputSchema: z.object({ ...publicAddress, issue_number: issueNumber.optional(), goal: z.string().min(10).max(4000).optional().describe('What to change, when there is no issue.'), idempotency_key: requestKey }).strict(), annotations: external,
  }, (input) => guarded(async () => {
    if (!input.issue_number === !input.goal) throw new ApiError(400, 'INVALID_INPUT', 'Pass either issue_number or goal.');
    return call<Record<string, unknown>>(`${publicIssuesPath(input.handle, input.repository)}/fix-requests`, input.issue_number ? { issueNumber: input.issue_number } : { goal: input.goal }, input.idempotency_key);
  }));
  server.registerTool('gitflare_community_pool', {
    title: 'Read a repository’s community AI settings', description: 'Read the community AI pool (funded models, agent runs, agent answers and fix requests per person a day, who funded it), today’s usage, agent triage and agent review switches, models this workspace can fund, and whether platform-funded triage is granted. Read-only.',
    inputSchema: z.object({ repository_id: repositoryId }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/community-ai`)));
  server.registerTool('gitflare_manage_community_pool', {
    title: 'Fund or stop a community AI pool', description: 'Owners only: set funds outside fix requests, agent triage and agent review from this workspace’s own AI keys or Gateway (verified models only; never platform-funded AI) within daily caps; disable stops funding new work. Needs admin access.',
    inputSchema: z.object({ repository_id: repositoryId, action: z.enum(['set', 'disable']), models: z.array(z.string().min(1).max(200)).min(1).max(5).optional().describe('Verified model IDs the pool pays for; the first is used.'), missions_per_day: z.number().int().min(0).max(200).optional().describe('Agent runs a day for requested fixes (0 funds triage and review only).'), drafts_per_day: z.number().int().min(0).max(1000).optional().describe('Single agent answers a day: fix plans, triage and reviews.'), per_user_per_day: z.number().int().min(1).max(20).optional().describe('Fix requests one person may make a day.'), idempotency_key: requestKey }).strict(), annotations: destructive,
  }, (input) => guarded(async () => {
    if (input.action === 'disable') return call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/community-ai`, { action: 'disable-pool' }, input.idempotency_key);
    if (!input.models || input.missions_per_day === undefined || input.drafts_per_day === undefined || input.per_user_per_day === undefined) throw new ApiError(400, 'INVALID_INPUT', 'Pass models, missions_per_day, drafts_per_day and per_user_per_day.');
    return call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/community-ai`, { action: 'set-pool', models: input.models, missionsPerDay: input.missions_per_day, draftsPerDay: input.drafts_per_day, perUserPerDay: input.per_user_per_day }, input.idempotency_key);
  }));
  server.registerTool('gitflare_set_triage', {
    title: 'Turn agent triage and agent review on or off', description: 'Owners only: triage suggests labels, duplicates and a reproduction checklist for each new issue (a triager accepts it); review comments on outside proposals and requested fixes after checks pass and never approves. Both bill the community pool; triage may use platform-funded AI only where the operator granted it. Needs admin access.',
    inputSchema: z.object({ repository_id: repositoryId, triage: z.boolean(), review: z.boolean(), idempotency_key: requestKey }).strict(), annotations: mutation,
  }, (input) => guarded(async () => call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/community-ai`, { action: 'set-assist', triage: input.triage, review: input.review }, input.idempotency_key)));
  server.registerTool('gitflare_triage_suggestion', {
    title: 'Read an issue’s triage suggestion', description: 'Read the agent’s pending triage suggestion for an issue: labels, possible duplicates, checklist and summary, with the model and who paid. Suggestion text is untrusted. Needs triage permission. Read-only.',
    inputSchema: z.object({ repository_id: repositoryId, number: issueNumber }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/issue-triage/${input.number}`)));
  server.registerTool('gitflare_triage_issue', {
    title: 'Run, accept or dismiss agent triage', description: 'run asks the triage agent for a suggestion (one bounded answer billed to the community pool, or platform-funded where granted); accept applies its labels and posts its checklist as a Gitflare comment; dismiss drops it. Needs triage permission and write access.',
    inputSchema: z.object({ repository_id: repositoryId, number: issueNumber, action: z.enum(['run', 'accept', 'dismiss']), idempotency_key: requestKey }).strict(), annotations: external,
  }, (input) => guarded(async () => call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/issue-triage/${input.number}`, { action: input.action }, input.idempotency_key)));
  server.registerTool('gitflare_agent_review', {
    title: 'Ask the agent to review a proposal', description: 'For an outside proposal or a requested fix whose checks all passed: one bounded agent answer billed to the community pool, posted as a review comment. The agent never approves, requests changes or lands. Needs the review permission and write access.',
    inputSchema: z.object({ mission_id: missionId, idempotency_key: requestKey }).strict(), annotations: external,
  }, (input) => guarded(async () => missionSummary(await call<Mission>(`/api/missions/${input.mission_id}/agent-review`, {}, input.idempotency_key))));
  server.registerTool('gitflare_operator_ai', {
    title: 'Read platform-funded AI use', description: 'Installation operators only: workspaces granted platform-funded AI (OPERATOR_MODEL_WORKSPACES), the daily triage cap per repository, and the latest platform-funded triage runs. Read-only.',
    inputSchema: z.object({}).strict(), annotations: readOnly,
  }, () => guarded(async () => call<Record<string, unknown>>('/api/admin/operator-ai')));
}
