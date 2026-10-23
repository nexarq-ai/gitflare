import { z } from 'zod';
import type { Mission, MissionAttempt, Workspace } from '../../shared/types';
import { ApiError, publicError, RETRY_GUIDANCE_MAX } from '../domain';
import { DEFAULT_MAX_AGENTS, DRAFT_GOAL_MAX, DRAFT_GOAL_MIN, MAX_ALLOWED_MODELS, MAX_MISSION_AGENTS } from '../../shared/mission-draft';
import { WORKSPACE_MISSION_LIMIT } from '../capacity';
import type { McpServer } from '@modelcontextprotocol/server';
import { identifier, repositoryId, missionId, requestKey, offset, pageLimit, readOnly, mutation, destructive, external, commit, commitMessageField, evidenceInput, agentBounds, agentLimitFields, agentLimitBody, agentOverridesBody } from '../mcp-schemas';
import { page, missionSummary, missionEvidence, withMcpFieldNames, guarded } from '../mcp-results';
import type { McpToolContext } from './context';

export function registerReads(server: McpServer, { call, fetchBytes }: McpToolContext): void {
  server.registerTool('gitflare_mission_screenshot', {
    title: 'Fetch a mission screenshot', description: 'Return one screenshot recorded as visual evidence for a mission candidate (base or candidate side, route, viewport, theme) as an image, with its outline, console errors and diff summary as text. Capture IDs come from gitflare_inspect_mission with view visual. Read-only.',
    inputSchema: z.object({ mission_id: missionId, capture_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/).describe('Capture ID from the visual view, or a diff image ID ending in .diff.') }).strict(), annotations: readOnly,
  }, async (input) => {
    try {
      const mission = await call<Mission>(`/api/missions/${input.mission_id}`);
      const capture = (mission.visual ?? []).flatMap((evidence) => evidence.captures).find((item) => item.id === input.capture_id || item.diff?.imageId === input.capture_id);
      if (!capture) throw new ApiError(404, 'NOT_FOUND', 'This capture is not part of the mission evidence.');
      if (!fetchBytes) throw new ApiError(503, 'UNAVAILABLE', 'Screenshots are not available over this connection.');
      const { bytes, contentType } = await fetchBytes(`/api/missions/${input.mission_id}/visual/${input.capture_id}`);
      let binary = '';
      for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      const summary = { captureId: input.capture_id, side: capture.side, route: capture.route, label: capture.label, frame: capture.frame, viewport: capture.viewport, theme: capture.theme, width: capture.width, height: capture.height, consoleErrors: capture.consoleErrors, overflow: capture.overflow, diff: capture.diff, outline: capture.outline };
      return { content: [{ type: 'image', data: btoa(binary), mimeType: contentType.startsWith('image/') ? contentType : 'image/png' }, { type: 'text', text: JSON.stringify(summary) }], structuredContent: summary };
    } catch (error) {
      const failure = publicError(error);
      return { content: [{ type: 'text', text: JSON.stringify({ error: failure }) }], isError: true };
    }
  });
  server.registerTool('gitflare_list_missions', {
    title: 'List repository missions', description: 'List missions with status, base and candidate SHAs and update time, optionally filtered by repository or status. Use gitflare_inspect_mission for evidence. Read-only.',
    inputSchema: z.object({ repository_id: repositoryId.optional(), status: z.enum(['draft', 'queued', 'running', 'checking', 'needs_review', 'approved', 'integrating', 'integrated', 'failed', 'cancelled']).optional().describe('Only missions in this status.'), offset, limit: pageLimit }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => {
    const workspace = await call<Workspace>('/api/workspace');
    const missions = workspace.missions.filter((mission) => (!input.repository_id || mission.repositoryId === input.repository_id) && (!input.status || mission.status === input.status)).map((mission) => ({ id: mission.id, repositoryId: mission.repositoryId, title: mission.title, status: mission.status, candidateSha: mission.candidateSha, baseSha: mission.baseSha, updatedAt: mission.updatedAt, epoch: mission.epoch }));
    return page(missions, input.offset, input.limit);
  }));
  server.registerTool('gitflare_inspect_mission', {
    title: 'Inspect mission evidence', description: 'Read mission evidence by view: summary, context, runs, changes (diffs), checks (logs), reviews or events. Lists and long text are paginated. Agent summaries are claims; rely on checks and diffs. Read-only.',
    inputSchema: z.object({ mission_id: missionId, ...evidenceInput }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => {
    const mission = await call<Mission>(`/api/missions/${input.mission_id}`);
    return missionEvidence(mission, input);
  }));
  server.registerTool('gitflare_proposal_base', {
    title: 'Read the current proposal Git baseline', description: 'Get the current default-branch commit and message for a new proposal. Pass the SHA as expected_base_sha to gitflare_create_mission. Read-only.',
    inputSchema: z.object({ repository_id: repositoryId }).strict(), annotations: readOnly,
  }, input => guarded(async () => call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/proposal-base`)));
}

const qualityBarInput = z.object({ target: z.string().min(1).max(1000).describe('The standard to reach, for example "AAA fighting game, Tekken-like lighting, fluid animation".'), references: z.array(z.object({ kind: z.enum(['url', 'text']), value: z.string().min(1).max(2000), note: z.string().max(300).optional() }).strict()).max(8).default([]).describe('Reference URLs (images, videos, sites) or text descriptions of the target look and feel.') }).strict().describe('Quality bar: carried into every agent brief and the critic rubric; with quality rounds configured, a critic scores screenshots against it and the builder iterates.');

export function register(server: McpServer, { call }: McpToolContext): void {
  server.registerTool('gitflare_draft_mission', {
    title: 'Draft a mission plan from a goal', description: `Suggest a mission plan for a goal from the repository files, README and package.json. auto: the planner picks combine, race or scaffold first, up to max_agents tasks, each task's model from allowed_models with a reason, and one coordinator when combining 2+ agents. One billed model call; saves nothing. Create it with gitflare_create_mission. Needs contribute permission and write access.`,
    inputSchema: z.object({ repository_id: repositoryId, goal: z.string().min(DRAFT_GOAL_MIN).max(DRAFT_GOAL_MAX).describe('What the change should achieve, in plain language.'), mode: z.enum(['auto', 'combine', 'race']).default('combine').describe('auto: the planner chooses the strategy, tasks and models. combine merges complementary agent work; race keeps the best of competing attempts.'), agents: z.number().int().min(1).max(MAX_MISSION_AGENTS).default(1).describe('combine and race: number of agents to plan.'), max_agents: z.number().int().min(1).max(MAX_MISSION_AGENTS).optional().describe(`auto: most agents the plan may use, coordinator included; default ${DEFAULT_MAX_AGENTS}.`), allowed_models: z.array(z.string().min(1).max(200)).min(1).max(MAX_ALLOWED_MODELS).optional().describe('auto: verified, enabled model IDs from gitflare_model_connections the planner may assign.'), title: z.string().max(120).optional(), quality_bar: qualityBarInput.optional(), model: z.string().min(1).max(200).optional().describe(`Enabled model ID from gitflare_model_connections that drafts the plan; defaults to the workspace default model.`), idempotency_key: requestKey }).strict(), annotations: { ...external, idempotentHint: false },
  }, (input) => guarded(async () => {
    const auto = input.mode === 'auto';
    if (!auto && (input.max_agents !== undefined || input.allowed_models)) throw new ApiError(400, 'INVALID_INPUT', 'max_agents and allowed_models apply only to mode auto.');
    return call<Record<string, unknown>>('/api/missions/draft', { repositoryId: input.repository_id, goal: input.goal, mode: input.mode, ...(auto ? { ...(input.max_agents !== undefined ? { maxAgents: input.max_agents } : {}), ...(input.allowed_models ? { allowedModels: input.allowed_models } : {}) } : { agents: input.agents }), title: input.title, ...(input.quality_bar ? { qualityBar: input.quality_bar } : {}), ...(input.model ? { model: input.model } : {}) }, input.idempotency_key);
  }));
  server.registerTool('gitflare_create_mission', {
    title: 'Plan a proposal with agent assignments', description: 'Create a draft mission on the latest default-branch commit with a goal, acceptance criteria and one to ten agent assignments (default: two agents). Runs nothing; call gitflare_start_mission only after the user agrees. expected_base_sha rejects a moved base; issue_number links an issue that closes when the mission lands. Needs contribute permission and write access.',
    inputSchema: z.object({ repository_id: repositoryId, title: z.string().min(1).max(120), prompt: z.string().min(10).max(8000).describe('Desired outcome and constraints for all agents.'), expected_base_sha: commit.optional().describe('Head from gitflare_proposal_base; refuses creation if the branch moved.'), issue_number: z.number().int().min(1).max(5000).optional().describe('Issue to close when this mission lands.'), mode: z.enum(['combine', 'race']).default('combine').describe('combine merges complementary agent work; race keeps the best of competing attempts.'), attachments: z.array(z.object({ name: z.string().min(1).max(120), content: z.string().max(16384) }).strict()).max(5).optional(), acceptance_criteria: z.array(z.string().min(1).max(500)).max(12).default([]), tasks: z.array(z.object({ name: z.string().min(1).max(60), role: z.string().min(1).max(80), task: z.string().min(10).max(2500), model: z.string().min(1).max(200).optional().describe('Enabled model ID from gitflare_model_connections.'), coordinator: z.boolean().optional().describe('combine with two or more agents: this agent starts after the others pass, with their candidates merged, and integrates them. At most one.'), ...agentLimitFields }).strict()).min(1).max(MAX_MISSION_AGENTS).refine(tasks => new Set(tasks.map(task => task.name.trim().toLowerCase())).size === tasks.length, { message: 'Give each agent a distinct name.' }).refine(tasks => tasks.filter(task => task.coordinator).length <= 1, { message: 'A mission has at most one coordinator.' }).optional(), agent_defaults: z.object(agentLimitFields).strict().optional().describe('Limits for every agent without its own: edit_scope, run_seconds, max_steps.'), quality_bar: qualityBarInput.optional(), idempotency_key: requestKey }).strict(), annotations: mutation,
  }, (input) => guarded(async () => missionSummary(await call<Mission>('/api/missions', { repositoryId: input.repository_id, title: input.title, prompt: input.prompt, acceptanceCriteria: input.acceptance_criteria, ...(input.tasks ? { tasks: input.tasks.map(({ edit_scope, run_seconds, max_steps, ...task }) => ({ ...task, ...agentLimitBody({ edit_scope, run_seconds, max_steps }) })) } : {}), ...(input.agent_defaults ? { agentOverrides: agentOverridesBody(input.agent_defaults) } : {}), ...(input.attachments ? { attachments: input.attachments } : {}), ...(input.quality_bar ? { qualityBar: input.quality_bar } : {}), mode: input.mode, expectedBaseSha: input.expected_base_sha, ...(input.issue_number ? { issueNumber: input.issue_number } : {}) }, input.idempotency_key))));
  server.registerTool('gitflare_start_mission', {
    title: 'Start a mission or retry its failed agents',
    description: `Run agents (billed). start reruns all. After failure: retry_failed reruns failed, collided or named agents from their last candidate (collided: merged peers) and reuses verified ones; drop_failed skips failed ones. In review: address_review sends open change requests to agents. guidance is appended to rerun tasks. A workspace runs ${WORKSPACE_MISSION_LIMIT} missions at once, 3 agents at a time each. Needs execute and write access.`,
    inputSchema: z.object({ mission_id: missionId, action: z.enum(['start', 'retry_failed', 'drop_failed', 'address_review']).default('start'), run_ids: z.array(identifier).min(1).max(MAX_MISSION_AGENTS).optional().describe('retry_failed: also rerun these agents even if they have verified candidates. address_review: the agents that address the review.'), guidance: z.string().min(1).max(RETRY_GUIDANCE_MAX).optional().describe('retry_failed and address_review: extra instructions appended to the rerun agents’ task, for example exact dependency versions.'), agent_overrides: z.record(identifier, z.object({ run_seconds: agentBounds.runSeconds.optional(), max_steps: agentBounds.maxSteps.optional(), model_answer_seconds: agentBounds.modelAnswerSeconds.optional(), model: z.string().min(1).max(200).optional().describe('Enabled model ID from gitflare_model_connections.') }).strict()).optional().describe('retry_failed with run_ids: per agent ID, more time, more steps, a longer model answer time or another enabled model for the rerun.'), idempotency_key: requestKey }).strict(), annotations: external,
  }, (input) => guarded(async () => {
    const targeted = input.action === 'retry_failed' || input.action === 'address_review';
    if (input.run_ids && !targeted) throw new ApiError(400, 'INVALID_INPUT', 'run_ids applies only to retry_failed and address_review.');
    if (input.guidance && !targeted) throw new ApiError(400, 'INVALID_INPUT', 'guidance applies only to retry_failed and address_review.');
    if (input.agent_overrides && (input.action !== 'retry_failed' || !input.run_ids)) throw new ApiError(400, 'INVALID_INPUT', 'agent_overrides applies only to retry_failed with run_ids.');
    const overrides = input.agent_overrides ? Object.fromEntries(Object.entries(input.agent_overrides).map(([runId, override]) => [runId, { ...(override.run_seconds ? { runSeconds: override.run_seconds } : {}), ...(override.max_steps ? { maxSteps: override.max_steps } : {}), ...(override.model_answer_seconds ? { modelAnswerSeconds: override.model_answer_seconds } : {}), ...(override.model ? { model: override.model } : {}) }])) : undefined;
    const path = input.action === 'retry_failed' ? 'retry-agents' : input.action === 'address_review' ? 'address-review' : input.action === 'drop_failed' ? 'drop-failed-agents' : 'start';
    return missionSummary(await call<Mission>(`/api/missions/${input.mission_id}/${path}`, { ...(input.run_ids ? { runIds: input.run_ids } : {}), ...(input.guidance ? { guidance: input.guidance } : {}), ...(overrides ? { overrides } : {}) }, input.idempotency_key as string));
  }));
  server.registerTool('gitflare_cancel_mission', {
    title: 'Cancel a mission',
    description: 'Cancel a mission that is not approved or landed. Running steps stop at the next checkpoint and late results are discarded. Needs write access.',
    inputSchema: z.object({ mission_id: missionId, idempotency_key: requestKey }).strict(), annotations: destructive,
  }, (input) => guarded(async () => missionSummary(await call<Mission>(`/api/missions/${input.mission_id}/cancel`, {}, input.idempotency_key))));
  server.registerTool('gitflare_review_mission', {
    title: 'Discuss or request changes to a proposal revision', description: 'Comment on, request changes to, or resolve your change request on the exact candidate (epoch, candidate_sha, base_sha). Pass path, line and side (old or new) together to anchor a comment or change request to a line in the current candidate diff. A change request blocks approval and landing until its author resolves it. Comments need contribute permission, the rest review permission; all need write access.',
    inputSchema: z.object({ mission_id: missionId, action: z.enum(['comment', 'request_changes', 'resolve']), epoch: z.number().int().min(1).describe('Current mission epoch.'), candidate_sha: commit, base_sha: commit, body: z.string().min(1).max(8000).optional().describe('Markdown; required for comment and request_changes.'), review_id: identifier.optional().describe('Your change request to resolve.'), path: z.string().min(1).max(1000).optional().describe('File path in the candidate diff.'), line: z.number().int().min(1).optional().describe('Line number on the chosen side.'), side: z.enum(['old', 'new']).optional().describe('old for removed lines, new for added or unchanged lines.'), idempotency_key: requestKey }).strict(), annotations: mutation,
  }, (input) => guarded(async () => missionSummary(await call<Mission>(`/api/missions/${input.mission_id}/review`, { action: input.action, epoch: input.epoch, candidateSha: input.candidate_sha, baseSha: input.base_sha, body: input.body, reviewId: input.review_id, path: input.path, line: input.line, side: input.side }, input.idempotency_key))));
  server.registerTool('gitflare_revert_mission', {
    title: 'Revert a landed mission', description: 'Create a new mission that reverts (restores) a landed mission with a new commit on the current default branch. No model call; history is not rewritten. The revert still needs checks, approval and landing, and fails if later commits changed the same lines. Needs write access.',
    inputSchema: z.object({ mission_id: missionId, idempotency_key: requestKey }).strict(), annotations: mutation,
  }, (input) => guarded(async () => missionSummary(await call<Mission>(`/api/missions/${input.mission_id}/revert`, {}, input.idempotency_key))));
  server.registerTool('gitflare_select_candidate', {
    title: 'Select a race candidate for review', description: 'In a race mission, choose which passing agent candidate goes to review. Clears earlier approvals; can change until approval. Compare raceCandidates, changes and checks first. Needs review permission and write access.',
    inputSchema: z.object({ mission_id: missionId, run_id: identifier.describe('Run ID from raceCandidates.'), epoch: z.number().int().min(1).describe('Current mission epoch.'), idempotency_key: requestKey }).strict(), annotations: destructive,
  }, (input) => guarded(async () => missionSummary(await call<Mission>(`/api/missions/${input.mission_id}/select`, { runId: input.run_id, epoch: input.epoch }, input.idempotency_key))));
  server.registerTool('gitflare_approve_mission', {
    title: 'Approve an exact checked candidate',
    description: 'Approve the exact checked candidate and base SHAs of a mission. Requires passing checks and an unchanged base; does not land. Inspect diffs and checks first and act only on the user’s instruction. If dependencyChanges is not empty, only an Owner can approve, and approve_dependencies must be true after the user explicitly accepts those package changes. Needs review permission and land access.',
    inputSchema: z.object({ mission_id: missionId, candidate_sha: commit, base_sha: commit, approve_dependencies: z.boolean().optional().describe('Owner acknowledgement of the candidate’s dependencyChanges. Required when dependencyChanges is not empty.'), commit_message: commitMessageField, idempotency_key: requestKey }).strict(), annotations: mutation,
  }, (input) => guarded(async () => missionSummary(await withMcpFieldNames(call<Mission>(`/api/missions/${input.mission_id}/approve`, { candidateSha: input.candidate_sha, baseSha: input.base_sha, ...(input.approve_dependencies !== undefined ? { approveDependencies: input.approve_dependencies } : {}), ...(input.commit_message !== undefined ? { commitMessage: input.commit_message } : {}) }, input.idempotency_key)))));
  for (const action of ['integrate', 'revoke'] as const) {
    const name = action === 'revoke' ? 'gitflare_revoke_approval' : `gitflare_${action}_mission`;
    server.registerTool(name, {
      title: action === 'integrate' ? 'Integrate an approved candidate' : 'Revoke an exact approval',
      description: action === 'integrate' ? 'Land an approved candidate on the default branch through the protected integration path. Writes the canonical branch and is undone only by a revert; deploys only if deploy on land is enabled. Runs in the background: status integrating means still running; repeat calls never push twice. Needs the exact candidate and base SHAs, a current approval, land permission and land access.' : 'Withdraw approval for the exact candidate and base, returning the mission to review. Not possible while landing or after landing. Needs review permission and land access.',
      inputSchema: z.object({ mission_id: missionId, candidate_sha: commit, base_sha: commit, ...(action === 'integrate' ? { commit_message: commitMessageField } : {}), idempotency_key: requestKey }).strict(), annotations: destructive,
    }, (input) => guarded(async () => missionSummary(await withMcpFieldNames(call<Mission>(`/api/missions/${input.mission_id}/${action}`, { candidateSha: input.candidate_sha, baseSha: input.base_sha, ...('commit_message' in input && input.commit_message !== undefined ? { commitMessage: input.commit_message } : {}) }, input.idempotency_key)))));
  }
  server.registerTool('gitflare_preview_mission', {
    title: 'Open, extend or stop a candidate preview', description: 'start a preview of the passing candidate in the background; extend a running one once (Owner or Maintainer, land access); stop retires or cancels it. Repeat starts return the running one. Worker projects become a Worker Preview of the repository’s Worker (public to anyone with the link); others run in a members-only container. Previews retire on land or after the lifetime. Needs write access.',
    inputSchema: z.object({ mission_id: missionId, action: z.enum(['start', 'extend', 'stop']).default('start'), idempotency_key: requestKey }).strict(), annotations: { ...destructive, idempotentHint: false },
  }, (input) => guarded(async () => call<Record<string, unknown>>(`/api/missions/${input.mission_id}/${input.action === 'extend' ? 'preview-extend' : input.action === 'stop' ? 'preview-stop' : 'preview'}`, {}, input.idempotency_key)));
  server.registerTool('gitflare_preview_status', {
    title: 'Read candidate preview status', description: 'Read a mission’s candidate preview. While status is starting, step (queued, cloning, installing, building, publishing, starting) and startedAt show progress; the preparation runs server-side, so poll until ready or failed. Otherwise host, access mode, expiresAt or the failure. Read-only.',
    inputSchema: z.object({ mission_id: missionId }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => call<Record<string, unknown>>(`/api/missions/${input.mission_id}/preview`)));
  server.registerTool('gitflare_mission_history', {
    title: 'Read immutable mission history', description: 'List a mission’s immutable attempt snapshots (approvals, revocations, retries, checks, landing), or open one by snapshot_id with the same views as gitflare_inspect_mission. Read-only.',
    inputSchema: z.object({ mission_id: missionId, snapshot_id: identifier.optional().describe('Snapshot ID from the list; omit to list snapshots.'), ...evidenceInput }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => {
    const { attempts } = await call<{ attempts: MissionAttempt[] }>(`/api/missions/${input.mission_id}/attempts`);
    if (input.snapshot_id) {
      const attempt = attempts.find((entry) => entry.id === input.snapshot_id);
      if (!attempt) throw new ApiError(404, 'SNAPSHOT_NOT_FOUND', 'This history snapshot was not found for the selected mission.');
      return { snapshotId: attempt.id, recordedAt: attempt.recordedAt, reason: attempt.reason, ...missionEvidence(attempt.snapshot, input) };
    }
    return { missionId: input.mission_id, ...page(attempts.map((attempt) => ({ id: attempt.id, epoch: attempt.epoch, recordedAt: attempt.recordedAt, reason: attempt.reason, status: attempt.snapshot.status, candidateSha: attempt.snapshot.candidateSha, baseSha: attempt.snapshot.baseSha, approvedAt: attempt.snapshot.approvedAt, approvedBy: attempt.snapshot.approvedBy })), input.offset, input.limit) };
  }));
}

export function registerReview(server: McpServer, { call }: McpToolContext): void {
  server.registerTool('gitflare_submit_review', {
    title: 'Submit a review of a proposal revision', description: 'Submit a review summary of the exact candidate (epoch, candidate_sha, base_sha): comment, approve or request_changes. approve records your approval like gitflare_approve_mission, including code owner rules, and needs review permission and land access. request_changes blocks approval until you resolve it. Act only on the user’s instruction after inspecting checks and diffs. Needs write access.',
    inputSchema: z.object({ mission_id: missionId, verdict: z.enum(['comment', 'approve', 'request_changes']), epoch: z.number().int().min(1).describe('Current mission epoch.'), candidate_sha: commit, base_sha: commit, body: z.string().max(8000).optional().describe('Markdown summary; required for comment and request_changes.'), approve_dependencies: z.boolean().optional().describe('For approve: Owner acknowledgement of dependencyChanges.'), commit_message: commitMessageField, idempotency_key: requestKey }).strict(), annotations: mutation,
  }, input => guarded(async () => missionSummary(await withMcpFieldNames(call<Mission>(`/api/missions/${input.mission_id}/submit-review`, { verdict: input.verdict, epoch: input.epoch, candidateSha: input.candidate_sha, baseSha: input.base_sha, ...(input.body !== undefined ? { body: input.body } : {}), ...(input.approve_dependencies !== undefined ? { approveDependencies: input.approve_dependencies } : {}), ...(input.commit_message !== undefined ? { commitMessage: input.commit_message } : {}) }, input.idempotency_key)))));
}
