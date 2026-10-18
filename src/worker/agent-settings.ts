import type { AgentLimits, AgentOverrides, AgentRetryOverride, AgentSettings, AgentSettingsBounds, RepositoryAgentSettings } from '../shared/types';
import { ApiError } from './domain';
import { matchesGlobs } from './repository-policy';

export const AGENT_SETTINGS_BOUNDS: AgentSettingsBounds = {
  modelAnswerSeconds: { min: 60, max: 600 },
  modelRetries: { min: 0, max: 3 },
  maxSteps: { min: 1, max: 32 },
  runSeconds: { min: 120, max: 1800 },
  editScope: { maxEntries: 20, maxLength: 200 },
};

export const DEFAULT_AGENT_LIMITS: AgentLimits = { modelAnswerSeconds: null, modelRetries: 2, maxSteps: 32, runSeconds: 600, autoRetry: true };

const SETTING_FIELDS = ['modelAnswerSeconds', 'modelRetries', 'maxSteps', 'runSeconds', 'autoRetry'] as const;
const OVERRIDE_FIELDS = ['runSeconds', 'maxSteps', 'modelAnswerSeconds'] as const;
const LABELS: Record<typeof SETTING_FIELDS[number], string> = { modelAnswerSeconds: 'Time per model answer', modelRetries: 'Automatic model retries', maxSteps: 'Max steps per agent', runSeconds: 'Time limit per agent run', autoRetry: 'Automatic agent retry' };

const invalid = (code: string, message: string): never => { throw new ApiError(400, code, message); };

function bounded(value: unknown, field: keyof Omit<AgentSettingsBounds, 'editScope'>, code: string): number {
  const { min, max } = AGENT_SETTINGS_BOUNDS[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) invalid(code, `${LABELS[field]} must be a whole number between ${min} and ${max}.`);
  return value as number;
}

export function normalizeAgentSettings(body: Record<string, unknown>): AgentSettings {
  const unknown = Object.keys(body).find((key) => !(SETTING_FIELDS as readonly string[]).includes(key));
  if (unknown) invalid('INVALID_AGENT_SETTINGS', `Unsupported agent setting "${unknown.slice(0, 60)}".`);
  const settings: AgentSettings = {};
  if (body.modelAnswerSeconds !== undefined && body.modelAnswerSeconds !== null) settings.modelAnswerSeconds = bounded(body.modelAnswerSeconds, 'modelAnswerSeconds', 'INVALID_AGENT_SETTINGS');
  if (body.modelRetries !== undefined && body.modelRetries !== null) settings.modelRetries = bounded(body.modelRetries, 'modelRetries', 'INVALID_AGENT_SETTINGS');
  if (body.maxSteps !== undefined && body.maxSteps !== null) settings.maxSteps = bounded(body.maxSteps, 'maxSteps', 'INVALID_AGENT_SETTINGS');
  if (body.runSeconds !== undefined && body.runSeconds !== null) settings.runSeconds = bounded(body.runSeconds, 'runSeconds', 'INVALID_AGENT_SETTINGS');
  if (body.autoRetry !== undefined && body.autoRetry !== null) {
    if (typeof body.autoRetry !== 'boolean') invalid('INVALID_AGENT_SETTINGS', 'Automatic agent retry must be true or false.');
    settings.autoRetry = body.autoRetry as boolean;
  }
  return settings;
}

export function normalizeAgentOverrides(value: unknown, code = 'INVALID_AGENT_OVERRIDES'): AgentOverrides | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return invalid(code, 'Agent overrides must be an object with runSeconds, maxSteps or modelAnswerSeconds.');
  const fields = value as Record<string, unknown>;
  const unknown = Object.keys(fields).find((key) => !(OVERRIDE_FIELDS as readonly string[]).includes(key));
  if (unknown) invalid(code, `Unsupported agent override "${unknown.slice(0, 60)}".`);
  const overrides: AgentOverrides = {};
  for (const field of OVERRIDE_FIELDS) if (fields[field] !== undefined && fields[field] !== null) overrides[field] = bounded(fields[field], field, code);
  return Object.keys(overrides).length ? overrides : undefined;
}

export function normalizeEditScope(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const { maxEntries, maxLength } = AGENT_SETTINGS_BOUNDS.editScope;
  if (!Array.isArray(value) || value.length > maxEntries) return invalid('INVALID_EDIT_SCOPE', `Files this agent may edit must be a list of at most ${maxEntries} paths or globs.`);
  const scope = value.map((entry) => {
    if (typeof entry !== 'string') return invalid('INVALID_EDIT_SCOPE', 'Each editable path must be text.');
    const path = entry.trim().replace(/^\.\//, '');
    if (!path || path.length > maxLength || path.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(path) || path.split('/').some((part, index, parts) => part === '..' || part === '.' || (!part && index !== parts.length - 1))) invalid('INVALID_EDIT_SCOPE', `"${path.slice(0, 80)}" must be a repository-relative file, directory ending in "/", or glob such as public/pose*.mjs.`);
    return path;
  });
  const unique = [...new Set(scope)];
  return unique.length ? unique : undefined;
}

export function normalizeRetryOverrides(value: unknown, runIds: string[]): Record<string, AgentRetryOverride> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return invalid('INVALID_RETRY_OVERRIDES', 'overrides must map agent IDs to { runSeconds, maxSteps, modelAnswerSeconds, model }.');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 10) invalid('INVALID_RETRY_OVERRIDES', 'Override at most 10 agents.');
  const result: Record<string, AgentRetryOverride> = {};
  for (const [runId, raw] of entries) {
    if (!runIds.includes(runId)) invalid('INVALID_RETRY_OVERRIDES', 'Each overridden agent must also be listed in runIds.');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('INVALID_RETRY_OVERRIDES', 'Each override must be an object.');
    const { model, ...rest } = raw as Record<string, unknown>;
    if (model !== undefined && (typeof model !== 'string' || !model.trim() || model.length > 200)) invalid('INVALID_RETRY_OVERRIDES', 'model must be a model identifier enabled in this workspace.');
    const overrides = normalizeAgentOverrides(rest, 'INVALID_RETRY_OVERRIDES');
    const entry: AgentRetryOverride = { ...overrides, ...(typeof model === 'string' ? { model: model.trim() } : {}) };
    if (Object.keys(entry).length) result[runId] = entry;
  }
  return Object.keys(result).length ? result : undefined;
}

export function effectiveAgentLimits(settings: AgentSettings | undefined | null, overrides?: AgentOverrides): AgentLimits {
  return {
    modelAnswerSeconds: overrides?.modelAnswerSeconds ?? settings?.modelAnswerSeconds ?? DEFAULT_AGENT_LIMITS.modelAnswerSeconds,
    modelRetries: settings?.modelRetries ?? DEFAULT_AGENT_LIMITS.modelRetries,
    maxSteps: overrides?.maxSteps ?? settings?.maxSteps ?? DEFAULT_AGENT_LIMITS.maxSteps,
    runSeconds: overrides?.runSeconds ?? settings?.runSeconds ?? DEFAULT_AGENT_LIMITS.runSeconds,
    autoRetry: settings?.autoRetry ?? DEFAULT_AGENT_LIMITS.autoRetry,
  };
}

export function agentSettingsSnapshot(repositoryId: string, stored: AgentSettings | undefined | null): RepositoryAgentSettings {
  return { repositoryId, settings: { ...(stored ?? {}) }, effective: effectiveAgentLimits(stored), defaults: { ...DEFAULT_AGENT_LIMITS }, bounds: structuredClone(AGENT_SETTINGS_BOUNDS) };
}

export function outsideEditScope(paths: string[], scope: string[] | undefined): string[] {
  if (!scope?.length) return [];
  return paths.filter((path) => !scope.some((entry) => entry.endsWith('/') ? path.startsWith(entry) : matchesGlobs(path, [entry])));
}

export function editScopeFailure(name: string, outside: string[], scope: string[]): string {
  const shown = outside.slice(0, 20).join(', ');
  return `${name} changed ${outside.length} file${outside.length === 1 ? '' : 's'} outside the files it may edit (${scope.join(', ')}): ${shown}${outside.length > 20 ? `, and ${outside.length - 20} more` : ''}. Widen "Files this agent may edit" or retry with guidance.`;
}
