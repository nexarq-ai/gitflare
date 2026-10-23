import type { CallToolResult } from '@modelcontextprotocol/server';
import type { IssueDetail, Mission } from '../shared/types';
import { ApiError, publicError } from './domain';
import { pullRequestState, waitingForMaintainer } from '../shared/pull-requests';
import { activeLandingMessage } from '../shared/commit-message';
import { isOutdatedReview } from './proposal-review';

export function excerpt(value: string, start = 0, limit = 4000) {
  const text = value.slice(start, start + limit);
  return { text, totalCharacters: value.length, offset: start, nextOffset: start + text.length < value.length ? start + text.length : null };
}

export function page<T>(values: T[], start: number, limit: number) {
  const items = values.slice(start, start + limit);
  while (items.length > 1 && JSON.stringify(items).length > 20_000) items.pop();
  return { items, total: values.length, offset: start, count: items.length, nextOffset: start + items.length < values.length ? start + items.length : null };
}

export function missionSummary(mission: Mission) {
  return {
    id: mission.id, repositoryId: mission.repositoryId, title: mission.title, status: mission.status,
    baseSha: mission.baseSha, candidateSha: mission.candidateSha, epoch: mission.epoch,
    mode: mission.mode ?? 'combine', selectedRunId: mission.selectedRunId, issueNumber: mission.issueNumber,
    raceCandidates: mission.mode === 'race' ? mission.runs.filter((run) => run.commitSha).map((run) => ({ runId: run.id, name: run.name, commitSha: run.commitSha, check: (mission.raceChecks ?? mission.checks).find((check) => check.runId === run.id)?.status ?? 'pending', changedFiles: run.changedFiles })) : undefined,
    createdAt: mission.createdAt, updatedAt: mission.updatedAt, error: mission.error,
    failedAgents: mission.runs.filter((run) => run.status === 'failed').map((run) => ({ runId: run.id, name: run.name, reason: run.error ?? 'No reason was recorded' })),
    acceptanceCriteria: mission.acceptanceCriteria ?? [], prompt: excerpt(mission.prompt, 0, 1600),
    runs: mission.runs.map((run) => ({ id: run.id, name: run.name, role: run.role, status: run.status, reusedFromEpoch: run.reusedFromEpoch, skipReason: run.skipReason, commitSha: run.commitSha, forkName: run.forkName, startedAt: run.startedAt, completedAt: run.completedAt, task: excerpt(run.task, 0, 800), summary: excerpt(run.summary ?? '', 0, 1000), note: run.note, touchedFiles: run.touchedFiles ?? run.changedFiles, error: run.error, model: run.model, limits: run.limits, editScope: run.editScope, autoRetried: run.autoRetried })),
    checkCount: mission.checks.length, changeCount: mission.changes.length, eventCount: mission.events.length,
    attachments: (mission.attachments ?? []).map((file) => ({ name: file.name, bytes: new TextEncoder().encode(file.content).length })),
    reviewCount: mission.reviews?.length ?? 0,
    skillChange: mission.skillChange ? { action: mission.skillChange.action, path: mission.skillChange.path, baseSha: mission.skillChange.baseSha } : undefined,
    approvedAt: mission.approvedAt, approvedBy: mission.approvedBy,
    commitMessage: activeLandingMessage(mission), landedSha: mission.landedSha,
    dependencyChanges: mission.dependencyChanges ?? [], dependencyApproval: mission.dependencyApproval,
    pullRequest: mission.branchChange ? { ...mission.branchChange, description: mission.branchChange.description ? excerpt(mission.branchChange.description, 0, 1600) : undefined, state: pullRequestState(mission), ...(mission.branchChange.source ? { outside: true, executionProfile: 'untrusted', waitingForMaintainer: waitingForMaintainer(mission) } : {}) } : undefined,
    fixRequest: mission.fixRequest ? { requester: mission.fixRequest.requester, issueNumber: mission.fixRequest.issueNumber, paidBy: mission.fixRequest.source === 'pool' ? 'community pool' : 'requester AI key', model: mission.fixRequest.model, executionProfile: 'untrusted', waitingForMaintainer: !!mission.fixRequest.waiting && mission.status === 'draft' } : undefined,
    review: 'Owner UI and authenticated owner MCP clients share exact-candidate approval and integration checks.',
  };
}

export const CHANGES_GUIDANCE = `Stored patches are capped in length, so a large change can end early. Each is returned detail_limit characters at a time: follow patch.nextOffset with detail_offset. To read a whole changed file, call gitflare_read_file with the change's readFile ref and path.`;

export function candidateRef(mission: Mission, runIds: string[]): string | undefined {
  if (mission.mode === 'race') return mission.runs.find((run) => runIds.includes(run.id) && run.commitSha)?.commitSha ?? mission.candidateSha ?? undefined;
  return mission.candidateSha ?? undefined;
}

export function missionEvidence(mission: Mission, input: { view: 'summary' | 'context' | 'runs' | 'changes' | 'checks' | 'events' | 'reviews'; offset: number; limit: number; detail_offset: number; detail_limit: number }): Record<string, unknown> {
  if (input.view === 'summary') return missionSummary(mission);
  const detail = (value: string) => excerpt(value, input.detail_offset, input.detail_limit);
  const reference = { missionId: mission.id, status: mission.status, candidateSha: mission.candidateSha, baseSha: mission.baseSha, epoch: mission.epoch, view: input.view };
  if (input.view === 'context') return { ...reference, title: mission.title, prompt: detail(mission.prompt), acceptanceCriteria: mission.acceptanceCriteria ?? [], attachments: (mission.attachments ?? []).slice(input.offset, input.offset + input.limit).map((file) => ({ name: file.name, bytes: new TextEncoder().encode(file.content).length, content: detail(file.content) })), attachmentCount: mission.attachments?.length ?? 0, skillChange: mission.skillChange ? { ...mission.skillChange, content: detail(mission.skillChange.content) } : undefined };
  const values: Record<string, unknown>[] = input.view === 'reviews' ? (mission.reviews ?? []).map(({ body, ...review }) => ({ ...review, outdated: isOutdatedReview(mission, review), body: detail(body) })) : input.view === 'changes' ? (mission.raceChanges ?? mission.changes).map(({ patch, ...change }) => ({ ...change, patch: detail(patch), ...(candidateRef(mission, change.runIds) ? { readFile: { tool: 'gitflare_read_file', ref: candidateRef(mission, change.runIds), path: change.path } } : {}) })) : input.view === 'checks' ? (mission.raceChecks ?? mission.checks).map(({ output, ...check }) => ({ ...check, output: detail(output ?? '') })) : input.view === 'runs' ? mission.runs.map(({ task, assignment, summary, ...run }) => ({ ...run, task: detail(task), assignment: detail(assignment ?? ''), summary: detail(summary ?? '') })) : mission.events.map((event) => ({ ...event, message: detail(event.message) }));
  return { ...reference, ...page(values, input.offset, input.limit), ...(input.view === 'changes' ? { patchGuidance: CHANGES_GUIDANCE } : {}) };
}

export function result(value: Record<string, unknown>): CallToolResult {
  const serialized = JSON.stringify(value);
  if (serialized.length > 24_000) {
    const limited = { truncated: true, excerpt: serialized.slice(0, 20_000), guidance: 'Reduce limit or request a more specific mission view. The excerpt is not complete evidence.' };
    return { content: [{ type: 'text', text: JSON.stringify(limited) }], structuredContent: limited };
  }
  return { content: [{ type: 'text', text: serialized }], structuredContent: value };
}

export const MCP_FIELD_NAMES: Record<string, string> = { approveDependencies: 'approve_dependencies', commitMessage: 'commit_message', acknowledgeNoLicense: 'acknowledge_no_license' };

export async function withMcpFieldNames<T>(operation: Promise<T>): Promise<T> {
  try { return await operation; }
  catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const detail = Object.entries(MCP_FIELD_NAMES).reduce((text, [api, mcp]) => text.replaceAll(api, mcp), error.detail);
    throw detail === error.detail ? error : new ApiError(error.status, error.code, detail);
  }
}

export async function guarded(operation: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try { return result(await operation()); }
  catch (error) {
    const failure = publicError(error);
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: failure.code, message: failure.message } }) }] };
  }
}
export const issueView = (issue: IssueDetail, offset = 0, limit = 20) => { const { comments, body, ...rest } = issue; return { ...rest, body: excerpt(body, 0, 8000), comments: page(comments.map((comment) => ({ ...comment, body: excerpt(comment.body, 0, 4000) })), offset, limit) }; };
