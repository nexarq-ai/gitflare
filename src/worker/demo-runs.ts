import type { Mission, MissionAttempt, Repository } from '../shared/types';
import { DEFAULT_REPLAY_SPEED, replayFrame, replaySummary, type MissionReplay, type ReplayStep, type ReplaySummary } from '../shared/demo-replay';
import { buildDemoHistory, type BuiltDemoHistory, type DemoPerson } from './demo-git';
import type { Principal } from './security';
import recorded from './demo-runs/neon-drift.json';

interface FixtureCommit { id: string; parent?: string; message: string; author: 'maya' | 'agent'; at: number; changes: Record<string, string> }
interface Fixture {
  repository: { name: string; description: string; createdAt: number };
  commits: FixtureCommit[];
  refs: Record<string, string>;
  missions: { key: string; record: Mission }[];
  replay: Omit<MissionReplay, 'missionId' | 'repositoryId' | 'title' | 'defaultSpeed'> & { missionKey: string };
}

export interface DemoRunsContext {
  generation: number;
  workspaceId: string;
  anchor: number;
  uuid(...parts: (string | number)[]): string;
  repository(name: string, description: string, headSha: string, created: string, updated: string): Repository;
  people: { maya: DemoPerson; agent: DemoPerson };
  principal: Principal;
}

export interface DemoRunsPlan { repository: Repository; history: BuiltDemoHistory; missions: Mission[]; attempts: [string, MissionAttempt][]; replay: MissionReplay }

const fixture = recorded as unknown as Fixture;
const RECORDED_DAY_OFFSET_MS = -86_400_000;
const TOKEN = /\{\{(id|sha|sha12|t):([^}]+)\}\}/g;
let historyCache: { context: DemoRunsContext['people']; history: BuiltDemoHistory } | null = null;

function history(people: DemoRunsContext['people']): BuiltDemoHistory {
  if (historyCache?.context === people) return historyCache.history;
  const built = buildDemoHistory({
    commits: fixture.commits.map((commit) => ({ id: commit.id, ...(commit.parent ? { parent: commit.parent } : {}), message: commit.message, author: people[commit.author], at: Math.floor((Date.UTC(2026, 9, 17) + commit.at) / 1000), changes: commit.changes })),
    refs: fixture.refs,
  });
  historyCache = { context: people, history: built };
  return built;
}

function resolver(context: DemoRunsContext, shas: Record<string, string>) {
  const at = (offset: number) => new Date(context.anchor + RECORDED_DAY_OFFSET_MS + offset).toISOString();
  const swap = (value: string) => value.replace(TOKEN, (_, kind: string, key: string) => {
    if (kind === 'id') return context.uuid(context.generation, 'neon-drift', key);
    if (kind === 't') return at(Number(key));
    const sha = shas[key];
    if (!sha) throw new Error(`Demo run fixture names unknown commit ${key}`);
    return kind === 'sha' ? sha : sha.slice(0, 12);
  });
  const walk = <T>(value: T): T => {
    if (typeof value === 'string') return swap(value) as T;
    if (Array.isArray(value)) return value.map(walk) as T;
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, walk(item)])) as T;
    return value;
  };
  return { walk, at };
}

export function neonDriftRuns(context: DemoRunsContext): DemoRunsPlan {
  const built = history(context.people);
  const { walk, at } = resolver(context, built.shas);
  const head = built.refs['refs/heads/main'];
  const missions = fixture.missions.map(({ record }) => walk(record));
  const repository = context.repository(fixture.repository.name, fixture.repository.description, head, at(fixture.repository.createdAt), missions.at(-1)!.updatedAt);
  const authorization = { principal: context.principal, workspaceId: context.workspaceId, creatorId: context.principal.userId };
  for (const mission of missions) Object.assign(mission, { repositoryId: repository.id, authorization });
  const resolved = walk(fixture.replay);
  const missionIndex = fixture.missions.findIndex((item) => item.key === fixture.replay.missionKey);
  const target = missions[missionIndex];
  const replay: MissionReplay = {
    id: resolved.id, missionId: target.id, repositoryId: repository.id, title: target.title, durationMs: resolved.durationMs, defaultSpeed: DEFAULT_REPLAY_SPEED,
    initial: { ...resolved.initial, id: target.id, repositoryId: repository.id }, steps: resolved.steps,
  };
  const recordedAt = (step: ReplayStep) => at(step.at);
  const attempts = replayFrame(replay, Number.POSITIVE_INFINITY, recordedAt).attempts.map((attempt): [string, MissionAttempt] => [`attempt:${target.id}:${attempt.id}`, { ...attempt, snapshot: { ...attempt.snapshot, authorization } }]);
  return { repository, history: built, missions, attempts, replay };
}

export function demoReplaySummaries(plan: DemoRunsPlan): ReplaySummary[] { return [replaySummary(plan.replay)]; }
