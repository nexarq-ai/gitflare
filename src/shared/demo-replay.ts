import type { AgentRun, Check, FileChange, Mission, MissionAttempt, MissionEvent, ProposalReview } from './types';

export type ReplayRunPatch = { [K in keyof AgentRun]?: AgentRun[K] | null } & { startedAt?: string | true | null; completedAt?: string | true | null };
export type ReplayCheckPatch = Pick<Check, 'id' | 'name' | 'status'> & Partial<Check>;

export interface ReplayStep {
  t: number;
  at: number;
  event: MissionEvent;
  archive?: { id: string; reason: MissionAttempt['reason'] };
  mission?: { status?: Mission['status']; epoch?: number; candidateSha?: string | null; error?: string | null };
  runs?: Record<string, ReplayRunPatch>;
  checks?: ReplayCheckPatch[];
  dropChecks?: string[];
  changes?: FileChange[];
  review?: Omit<ProposalReview, 'createdAt'>;
}

export interface MissionReplay {
  id: string;
  missionId: string;
  repositoryId: string;
  title: string;
  durationMs: number;
  defaultSpeed: number;
  initial: Mission;
  steps: ReplayStep[];
}

export interface ReplaySummary { id: string; missionId: string; repositoryId: string; title: string; durationMs: number; defaultSpeed: number; agents: number }
export interface ReplayFrame { mission: Mission; attempts: MissionAttempt[]; applied: number; done: boolean }

export const REPLAY_SPEEDS = [1, 5, 10, 25] as const;
export const DEFAULT_REPLAY_SPEED = 10;

function assign<T extends object>(target: T, patch: Record<string, unknown>, now: string): T {
  const record = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete record[key];
    else if (value === true && (key === 'startedAt' || key === 'completedAt')) record[key] = now;
    else if (value !== undefined) record[key] = structuredClone(value);
  }
  return target;
}

export function replayFrame(replay: MissionReplay, elapsedMs: number, timeOf: (step: ReplayStep) => string): ReplayFrame {
  const mission = structuredClone(replay.initial);
  const attempts: MissionAttempt[] = [];
  let applied = 0;
  for (const step of replay.steps) {
    if (step.t > elapsedMs) break;
    const now = timeOf(step);
    if (step.archive) attempts.push({ id: step.archive.id, epoch: mission.epoch, recordedAt: now, reason: step.archive.reason, snapshot: structuredClone(mission) });
    if (step.mission) assign(mission, step.mission, now);
    for (const [name, patch] of Object.entries(step.runs ?? {})) {
      const run = mission.runs.find((item) => item.name === name);
      if (run) assign(run, patch, now);
    }
    if (step.dropChecks) mission.checks = mission.checks.filter((check) => !step.dropChecks!.includes(check.name));
    for (const patch of step.checks ?? []) {
      const index = mission.checks.findIndex((check) => check.name === patch.name);
      const next = { ...structuredClone(patch) } as Check;
      if (index < 0) mission.checks.push(next); else mission.checks[index] = next;
    }
    if (step.changes) mission.changes = structuredClone(step.changes);
    if (step.review) mission.reviews = [...(mission.reviews ?? []), { ...structuredClone(step.review), createdAt: now }];
    mission.events.push({ ...step.event, timestamp: now });
    mission.updatedAt = now;
    applied++;
  }
  return { mission, attempts: attempts.reverse(), applied, done: applied === replay.steps.length };
}

export function replaySummary(replay: MissionReplay): ReplaySummary {
  return { id: replay.id, missionId: replay.missionId, repositoryId: replay.repositoryId, title: replay.title, durationMs: replay.durationMs, defaultSpeed: replay.defaultSpeed, agents: replay.initial.runs.length };
}
