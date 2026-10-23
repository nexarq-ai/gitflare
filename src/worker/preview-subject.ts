import type { AgentRun, Mission } from '../shared/types';
import { ApiError } from './domain';

export const PREVIEW_LIVE_STATUSES: Mission['status'][] = ['needs_review', 'approved', 'integrating', 'integrated'];

const SEPARATOR = '.';

export interface PreviewSubject { missionId: string; runId?: string }

export function eligibleRaceRuns(mission: Mission): AgentRun[] {
  const checks = mission.raceChecks ?? mission.checks;
  return mission.runs.filter((run) => run.status === 'completed' && !!run.commitSha && !!run.forkName && checks.some((check) => check.runId === run.id && check.status === 'passed' && check.candidateSha === run.commitSha));
}

export function previewKey(missionId: string, runId?: string): string {
  return runId ? `${missionId}${SEPARATOR}${runId}` : missionId;
}

export function candidateKeyPrefix(missionId: string): string {
  return `${missionId}${SEPARATOR}`;
}

export function previewSubject(key: string): PreviewSubject {
  const at = key.indexOf(SEPARATOR);
  return at < 0 ? { missionId: key } : { missionId: key.slice(0, at), runId: key.slice(at + 1) };
}

export function raceCandidate(mission: Mission, runId: string): AgentRun | undefined {
  return mission.mode === 'race' ? eligibleRaceRuns(mission).find((run) => run.id === runId) : undefined;
}

export function previewCandidateSha(mission: Mission, runId?: string): string | null {
  return runId ? raceCandidate(mission, runId)?.commitSha ?? null : mission.candidateSha;
}

export function requireRaceCandidate(mission: Mission, runId: string): AgentRun {
  if (mission.mode !== 'race') throw new ApiError(409, 'NOT_A_RACE', 'Only a race mission has candidates to preview separately.');
  const run = raceCandidate(mission, runId);
  if (!run) throw new ApiError(409, 'CANDIDATE_NOT_ELIGIBLE', 'Only an agent candidate that passed its checks can be previewed.');
  return run;
}

export function candidateView(mission: Mission, runId?: string): Mission {
  if (!runId) return mission;
  const run = requireRaceCandidate(mission, runId);
  return { ...mission, id: previewKey(mission.id, runId), candidateSha: run.commitSha!, integrationForkName: run.forkName };
}
