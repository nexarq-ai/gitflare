import { z } from 'zod';
import { COMMIT_MESSAGE_MAX, COMMIT_SUBJECT_MAX } from '../shared/commit-message';
import { AGENT_SETTINGS_BOUNDS } from './agent-settings';

export const identifier = z.string().min(1).max(100).regex(/^[a-zA-Z0-9-]+$/);
export const repositoryId = identifier.describe('Repository ID from gitflare_list_repositories.');
export const missionId = identifier.describe('Mission ID from gitflare_list_missions.');
export const requestKey = z.string().min(16).max(128).regex(/^[a-zA-Z0-9_-]+$/).describe('Unique key for this intended change. Reuse the same key and payload only to retry the same action.');
export const offset = z.number().int().min(0).max(1_000_000).default(0).describe('Zero-based start; pass nextOffset from the previous page.');
export const pageLimit = z.number().int().min(1).max(50).default(20).describe('Items per page.');
export const gitRef = z.string().max(200).describe('Branch, tag or commit SHA: full, or a unique prefix of at least 7 characters.');
export const filePath = z.string().max(2000).describe('Path relative to the repository root.');
export const repositoryInput = { initializeReadme: z.boolean().optional().describe('Add a README commit.'), gitignore: z.enum(['none', 'Node', 'Python']).optional(), license: z.enum(['none', 'MIT', 'Apache-2.0']).optional(), copyrightHolder: z.string().max(200).optional().describe('Name for the license notice.'), name: z.string().min(1).max(64).describe('Repository name.'), description: z.string().max(500).optional(), idempotency_key: requestKey };
export const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const destructive = { ...mutation, destructiveHint: true };
export const external = { ...mutation, openWorldHint: true };
export const commit = z.string().regex(/^[a-f0-9]{40}$/).describe('Exact 40-character commit SHA observed in current evidence.');
export const commitMessageField = z.string().min(1).max(COMMIT_MESSAGE_MAX).optional().describe(`Commit message for the commit that lands on the default branch: a subject line of at most ${COMMIT_SUBJECT_MAX} characters, optionally a blank line and a body. Control characters are removed and the "Gitflare mission <id>" trailer is kept. The landed commit carries exactly the approved tree; omit to keep the candidate commit as is.`);
export const evidenceInput = { view: z.enum(['summary', 'context', 'runs', 'changes', 'checks', 'events', 'reviews', 'visual']).default('summary').describe('Evidence to return; visual lists screenshot captures (base and candidate per route, viewport and theme) with diff ratios and the image path for gitflare_mission_screenshot.'), offset, limit: z.number().int().min(1).max(20).default(5).describe('Items per page.'), detail_offset: offset.describe('Start character within each long text field.'), detail_limit: z.number().int().min(1).max(8000).default(3000).describe('Characters per long text field.') };
export const agentBounds = {
  modelAnswerSeconds: z.number().int().min(AGENT_SETTINGS_BOUNDS.modelAnswerSeconds.min).max(AGENT_SETTINGS_BOUNDS.modelAnswerSeconds.max),
  modelRetries: z.number().int().min(AGENT_SETTINGS_BOUNDS.modelRetries.min).max(AGENT_SETTINGS_BOUNDS.modelRetries.max),
  maxSteps: z.number().int().min(AGENT_SETTINGS_BOUNDS.maxSteps.min).max(AGENT_SETTINGS_BOUNDS.maxSteps.max),
  runSeconds: z.number().int().min(AGENT_SETTINGS_BOUNDS.runSeconds.min).max(AGENT_SETTINGS_BOUNDS.runSeconds.max),
};
export const agentLimitFields = {
  edit_scope: z.array(z.string().min(1).max(AGENT_SETTINGS_BOUNDS.editScope.maxLength)).max(AGENT_SETTINGS_BOUNDS.editScope.maxEntries).optional().describe('Files this agent may edit: repository-relative files, directories ending in "/" or globs such as public/pose*.mjs. Changes elsewhere fail the agent. Omit for the whole repository.'),
  run_seconds: agentBounds.runSeconds.optional().describe('Time limit for this agent run in seconds.'),
  max_steps: agentBounds.maxSteps.optional().describe('Model turns for this agent.'),
};
export type AgentLimitInput = { edit_scope?: string[]; run_seconds?: number; max_steps?: number };
export function agentLimitBody(input: AgentLimitInput): { editScope?: string[]; overrides?: { runSeconds?: number; maxSteps?: number } } {
  const overrides = { ...(input.run_seconds ? { runSeconds: input.run_seconds } : {}), ...(input.max_steps ? { maxSteps: input.max_steps } : {}) };
  return { ...(input.edit_scope?.length ? { editScope: input.edit_scope } : {}), ...(Object.keys(overrides).length ? { overrides } : {}) };
}
export function agentOverridesBody(input: AgentLimitInput): Record<string, unknown> {
  const { editScope, overrides } = agentLimitBody(input);
  return { ...overrides, ...(editScope ? { editScope } : {}) };
}
export const accessId = z.string().min(1).max(200);
export const userId = accessId.describe('Member user ID from gitflare_access_status.');
export const issueNumber = z.number().int().min(1).max(5000).describe('Issue number in this repository.');
export const templateFile = z.string().min(4).max(103).regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*\.md$/).describe('Template file name from gitflare_issue_templates, such as bug_report.md.');
export const handleValue = z.string().min(1).max(39).regex(/^[a-z0-9-]+$/).describe('Handle: 1–39 lowercase letters, numbers or single hyphens.');
export const publicRepositoryName = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).describe('Repository name from the public address.');
export const publicAddress = {
  handle: handleValue.describe('Owner handle from the public address.'),
  repository: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).describe('Repository name from the public address.'),
};
export const publicIssuesPath = (handle: string, repository: string) => `/api/public/repos/${encodeURIComponent(handle)}/${encodeURIComponent(repository)}`;
