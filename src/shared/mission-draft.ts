import type { AgentTask, ModelConnection } from './types';

export const DRAFT_GOAL_MIN = 10;
export const DRAFT_GOAL_MAX = 4000;
export const MISSION_PROMPT_MAX = 8000;
export const MAX_MISSION_AGENTS = 10;
export const DEFAULT_MAX_AGENTS = 4;
export const MAX_ALLOWED_MODELS = 20;

export interface MissionDraftResult { title: string; acceptanceCriteria: string[]; tasks: AgentTask[]; warnings?: string[] }
export type MissionStrategy = 'combine' | 'race' | 'scaffold';
export interface PlannedTask extends AgentTask { model: string; reason: string }
export interface MissionPlanResult { auto: true; title: string; acceptanceCriteria: string[]; strategy: MissionStrategy; strategyReason: string; mode: 'combine' | 'race'; tasks: PlannedTask[]; followUp?: string; warnings?: string[]; baseSha?: string | null; model?: string }

const STRENGTH: [RegExp, number][] = [
  [/claude-opus/, 100], [/claude-fable/, 95], [/gpt-6\.1-sol/, 90], [/claude-sonnet/, 85], [/gpt-6-luna/, 70], [/claude-haiku/, 50],
];

export function modelStrength(model: Pick<ModelConnection, 'id' | 'source'>): number {
  const match = STRENGTH.find(([pattern]) => pattern.test(model.id));
  return match ? match[1] : model.source === 'workers-ai' ? 10 : 30;
}

export function byStrength<T extends Pick<ModelConnection, 'id' | 'source'>>(models: T[]): T[] {
  return [...models].sort((a, b) => modelStrength(b) - modelStrength(a) || a.id.localeCompare(b.id));
}

export function verifiedModels(models: ModelConnection[]): ModelConnection[] {
  return models.filter(model => model.verification?.status === 'verified');
}

export function defaultAllowedModels(models: ModelConnection[]): string[] {
  return verifiedModels(models).filter(model => model.id.startsWith('anthropic/claude-')).map(model => model.id);
}

export function strategyLabel(strategy: MissionStrategy): string {
  return strategy === 'race' ? 'Race' : strategy === 'scaffold' ? 'Scaffold first' : 'Combine';
}

export function planToManual(plan: MissionPlanResult): { mode: 'combine' | 'race'; title: string; criteria: string; tasks: AgentTask[] } {
  return { mode: plan.mode, title: plan.title, criteria: plan.acceptanceCriteria.join('\n'), tasks: plan.tasks.map(({ name, role, task, model, coordinator }) => ({ name, role, task, model, ...(coordinator ? { coordinator: true } : {}) })) };
}

export function firstLine(text: string, max = 90): string {
  const line = text.trim().split(/\n|(?<=[.!?])\s/)[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
export interface DraftRequestState { repositoryId: string; goal: string }

export function draftGoalProblem(goal: string): string | null {
  const length = goal.trim().length;
  if (length < DRAFT_GOAL_MIN) return `Describe the goal in at least ${DRAFT_GOAL_MIN} characters to draft with AI.`;
  if (length > DRAFT_GOAL_MAX) return `Drafting with AI accepts goals up to ${DRAFT_GOAL_MAX.toLocaleString('en-US')} characters (this one has ${length.toLocaleString('en-US')}). Shorten it, or fill the fields yourself: missions accept up to ${MISSION_PROMPT_MAX.toLocaleString('en-US')}.`;
  return null;
}

export function draftIsStale(requested: DraftRequestState, latest: DraftRequestState): boolean {
  return requested.repositoryId !== latest.repositoryId || requested.goal.trim() !== latest.goal.trim();
}

export function fillBlank(current: string, drafted: string): string {
  return current.trim() ? current : drafted;
}

export function mergeDraftAgents<T extends AgentTask & { id: string }>(current: T[], tasks: AgentTask[], requestedIds: string[]): T[] {
  return current.map(agent => {
    const drafted = tasks[requestedIds.indexOf(agent.id)];
    if (!drafted) return agent;
    return { ...agent, name: fillBlank(agent.name, drafted.name), role: fillBlank(agent.role, drafted.role), task: fillBlank(agent.task, drafted.task) };
  });
}

export function modelVerificationLabel(model: ModelConnection): string {
  if (model.verification?.status === 'verified') return 'Verified';
  if (model.verification?.status === 'failed') return 'Verification failed';
  return 'Not verified';
}

export function modelOptionLabel(model: ModelConnection): string {
  return `${model.label}${model.source === 'workers-ai' ? ' · Workers AI' : ''} · ${modelVerificationLabel(model)}`;
}

export function modelVerificationNote(model: ModelConnection): string {
  if (!model.verification) return 'This model has not been verified. Its first use is the first inference check.';
  const checked = Number.isNaN(Date.parse(model.verification.checkedAt)) ? model.verification.checkedAt : new Date(model.verification.checkedAt).toLocaleString();
  if (model.verification.status === 'failed') return `The last verification failed (${checked}): ${model.verification.detail} This may have changed since; verify it again in AI model settings before relying on it.`;
  return `Text inference verified ${checked}.`;
}
