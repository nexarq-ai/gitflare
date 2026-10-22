import type { AutoIncrease, Check, CheckInstall, CheckOverride, CheckPlan, CheckPolicyOverride, CheckSettings, InstallSetting, Mission, RepositoryCheckSettings, RunnerSize } from '../shared/types';
import { ApiError } from './domain';
import { autoIncreaseOf, isRunnerSize, MAX_TIMEOUT_SECONDS, RUNNER_SIZES } from './repository-policy';

export const MIN_SETTING_TIMEOUT_SECONDS = 60;
export const RETRY_TIMEOUT_SECONDS = 600;
export const RETRY_ADJUSTMENTS = ['timeout', 'runner'] as const;
export const DURATION_SAMPLES = 20;
export const MIN_DURATION_SAMPLES = 3;
export const AUTO_INCREASE_ACTOR = 'gitflare:auto-increase';
export type RetryAdjustment = typeof RETRY_ADJUSTMENTS[number];
export type CheckSettingsInput = Pick<CheckSettings, 'testTimeoutSeconds' | 'runner' | 'autoIncrease' | 'policyOverride' | 'install'>;
export const INSTALL_SETTINGS: readonly InstallSetting[] = ['npm', 'pnpm', 'yarn', 'auto', 'none'];
export const POLICY_OVERRIDE_FIELDS = ['test', 'evidence', 'testTimeoutSeconds', 'runner'] as const;
export interface LearnedLimits { testTimeoutSeconds?: number; runner?: RunnerSize }

const RETRYABLE_STATUSES: Mission['status'][] = ['failed', 'cancelled', 'needs_review'];
const invalid = (message: string): never => { throw new ApiError(400, 'INVALID_CHECK_SETTINGS', message); };

function timeoutSeconds(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_SETTING_TIMEOUT_SECONDS || value > MAX_TIMEOUT_SECONDS) invalid(`${label} must be a whole number of seconds between ${MIN_SETTING_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS}.`);
  return value as number;
}

function runnerSize(value: unknown): RunnerSize {
  if (!isRunnerSize(value)) invalid(`The runner size must be one of ${RUNNER_SIZES.join(', ')}.`);
  return value as RunnerSize;
}

function autoIncrease(value: unknown): AutoIncrease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Auto-increase must be an object with enabled, maxTimeoutSeconds and maxRunner.');
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !['enabled', 'maxTimeoutSeconds', 'maxRunner'].includes(key)) || typeof fields.enabled !== 'boolean') invalid('Auto-increase must be an object with enabled, maxTimeoutSeconds and maxRunner.');
  return { enabled: fields.enabled as boolean, maxTimeoutSeconds: timeoutSeconds(fields.maxTimeoutSeconds, 'The auto-increase time ceiling'), maxRunner: runnerSize(fields.maxRunner) };
}

function testCommand(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) invalid('The test command must be a single-line command of at most 500 characters.');
  return (value as string).trim();
}

export function normalizePolicyOverride(value: unknown): CheckPolicyOverride | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return invalid('The gitflare.json override must be an object with test, evidence, testTimeoutSeconds or runner.');
  const fields = value as Record<string, unknown>;
  const unknown = Object.keys(fields).find((key) => ![...POLICY_OVERRIDE_FIELDS, 'updatedAt', 'updatedBy'].includes(key));
  if (unknown) invalid(`Unsupported gitflare.json override "${unknown}". Use test, evidence, testTimeoutSeconds or runner.`);
  const override: CheckPolicyOverride = {};
  if (fields.test !== undefined && fields.test !== null) override.test = testCommand(fields.test);
  if (fields.evidence !== undefined && fields.evidence !== null) {
    if (fields.evidence !== 'tap' && fields.evidence !== 'exit-code') invalid('Evidence must be "tap" or "exit-code".');
    override.evidence = fields.evidence as CheckPolicyOverride['evidence'];
  }
  if (fields.testTimeoutSeconds !== undefined && fields.testTimeoutSeconds !== null) override.testTimeoutSeconds = timeoutSeconds(fields.testTimeoutSeconds, 'The overriding check time limit');
  if (fields.runner !== undefined && fields.runner !== null) override.runner = runnerSize(fields.runner);
  if (!POLICY_OVERRIDE_FIELDS.some((key) => override[key] !== undefined)) return undefined;
  if (typeof fields.updatedAt === 'string') override.updatedAt = fields.updatedAt.slice(0, 40);
  if (typeof fields.updatedBy === 'string') override.updatedBy = fields.updatedBy.slice(0, 200);
  return override;
}

export function normalizeInstall(value: unknown): CheckInstall | undefined {
  if (value === undefined || value === null) return undefined;
  const fields = typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value };
  if (Object.keys(fields).some((key) => !['value', 'updatedAt', 'updatedBy'].includes(key)) || !INSTALL_SETTINGS.includes(fields.value as InstallSetting)) invalid(`Dependency install must be one of ${INSTALL_SETTINGS.join(', ')}, or null to clear it.`);
  return { value: fields.value as InstallSetting, ...(typeof fields.updatedAt === 'string' ? { updatedAt: fields.updatedAt.slice(0, 40) } : {}), ...(typeof fields.updatedBy === 'string' ? { updatedBy: fields.updatedBy.slice(0, 200) } : {}) };
}

export function samePolicyOverride(left: CheckPolicyOverride | undefined, right: CheckPolicyOverride | undefined): boolean {
  return POLICY_OVERRIDE_FIELDS.every((key) => left?.[key] === right?.[key]);
}

export function normalizeCheckSettings(body: Record<string, unknown>): CheckSettingsInput {
  const unknown = Object.keys(body).find((key) => !['testTimeoutSeconds', 'runner', 'autoIncrease', 'policyOverride', 'install'].includes(key));
  if (unknown) invalid(`Unsupported check setting "${unknown}".`);
  const settings: CheckSettingsInput = {};
  if (body.testTimeoutSeconds !== undefined && body.testTimeoutSeconds !== null) settings.testTimeoutSeconds = timeoutSeconds(body.testTimeoutSeconds, 'The check time limit');
  if (body.runner !== undefined && body.runner !== null) settings.runner = runnerSize(body.runner);
  if (body.autoIncrease !== undefined && body.autoIncrease !== null) settings.autoIncrease = autoIncrease(body.autoIncrease);
  const policyOverride = normalizePolicyOverride(body.policyOverride);
  if (policyOverride) settings.policyOverride = policyOverride;
  const install = normalizeInstall(body.install);
  if (install) settings.install = install;
  return settings;
}

export function percentile90(durationsMs: number[]): number | undefined {
  if (durationsMs.length < MIN_DURATION_SAMPLES) return undefined;
  const sorted = [...durationsMs].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.9) - 1];
}

export function learnedTimeoutSeconds(durationsMs: number[]): number | undefined {
  const p90 = percentile90(durationsMs);
  return p90 === undefined ? undefined : Math.min(MAX_TIMEOUT_SECONDS, Math.ceil((2 * p90) / 60_000) * 60);
}

export function checkPlan(stored: CheckSettings | undefined | null, durationsMs: number[]): CheckPlan {
  const learned = learnedTimeoutSeconds(durationsMs);
  return { ...(stored ?? {}), ...(learned ? { learnedTimeoutSeconds: learned } : {}) };
}

export function checkSettingsSnapshot(repositoryId: string, stored: CheckSettings | undefined | null, durationsMs: number[] = []): RepositoryCheckSettings {
  const p90 = percentile90(durationsMs);
  const learned = learnedTimeoutSeconds(durationsMs);
  return { repositoryId, ...(stored ?? {}), autoIncrease: autoIncreaseOf(stored), history: { samples: durationsMs.length, ...(p90 !== undefined ? { p90Seconds: Math.ceil(p90 / 1000) } : {}), ...(learned ? { learnedTimeoutSeconds: learned } : {}) }, limits: { minTimeoutSeconds: MIN_SETTING_TIMEOUT_SECONDS, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS, runners: [...RUNNER_SIZES] } };
}

export function checkDurations(checks: Check[]): number[] {
  return checks.filter((check) => check.status === 'passed' && typeof check.durationMs === 'number' && check.durationMs > 0 && check.id !== 'integration').map((check) => check.durationMs!);
}

export function withLearnedLimits(current: CheckSettings | undefined | null, learned: LearnedLimits): CheckSettingsInput | null {
  const settings = keptSettings(current);
  const next = { ...settings };
  if (learned.testTimeoutSeconds && learned.testTimeoutSeconds > (settings.testTimeoutSeconds ?? 0)) next.testTimeoutSeconds = Math.min(learned.testTimeoutSeconds, MAX_TIMEOUT_SECONDS);
  if (learned.runner && RUNNER_SIZES.indexOf(learned.runner) > RUNNER_SIZES.indexOf(settings.runner ?? 'standard-1')) next.runner = learned.runner;
  return next.testTimeoutSeconds !== settings.testTimeoutSeconds || next.runner !== settings.runner ? next : null;
}

function keptSettings(current: CheckSettings | undefined | null): CheckSettingsInput {
  return { ...(current?.testTimeoutSeconds !== undefined ? { testTimeoutSeconds: current.testTimeoutSeconds } : {}), ...(current?.runner ? { runner: current.runner } : {}), ...(current?.autoIncrease ? { autoIncrease: current.autoIncrease } : {}), ...(current?.policyOverride ? { policyOverride: current.policyOverride } : {}), ...(current?.install ? { install: current.install } : {}) };
}

export function withInstall(current: CheckSettings | undefined | null, install: CheckInstall): CheckSettingsInput {
  return { ...keptSettings(current), install };
}

export function timedOutCheck(mission: Pick<Mission, 'checks'>): (Check & { timeout: NonNullable<Check['timeout']> }) | undefined {
  return mission.checks.find((check): check is Check & { timeout: NonNullable<Check['timeout']> } => !!check.timeout && check.status === 'failed');
}

export function nextRunner(runner: RunnerSize): RunnerSize | undefined {
  return RUNNER_SIZES[RUNNER_SIZES.indexOf(runner) + 1];
}

export type RetryPlan = { kind: 'settings'; settings: CheckSettingsInput } | { kind: 'override'; override: Pick<CheckOverride, 'testTimeoutSeconds' | 'runner'> };

export function retryPlan(mission: Pick<Mission, 'checks' | 'status'>, current: CheckSettings | undefined | null, adjustment: unknown, owner: boolean): RetryPlan {
  const check = timedOutCheck(mission);
  const fixed = adjustment === 'timeout' ? check?.timeout.timeoutSource : adjustment === 'runner' ? check?.timeout.runnerSource : undefined;
  if (!owner || !check || !RETRYABLE_STATUSES.includes(mission.status) || (fixed !== 'gitflare.json' && fixed !== 'owner')) return { kind: 'settings', settings: retryCheckSettings(mission, current, adjustment) };
  if (adjustment === 'timeout') {
    if (check.timeout.seconds >= MAX_TIMEOUT_SECONDS) throw new ApiError(409, 'LIMIT_AT_MAXIMUM', `The check already used the maximum ${MAX_TIMEOUT_SECONDS} s. Choose a larger runner instead.`);
    return { kind: 'override', override: { testTimeoutSeconds: check.timeout.seconds < RETRY_TIMEOUT_SECONDS ? RETRY_TIMEOUT_SECONDS : MAX_TIMEOUT_SECONDS } };
  }
  const larger = nextRunner(check.timeout.runner);
  if (!larger) throw new ApiError(409, 'LIMIT_AT_MAXIMUM', `The check already ran on the largest runner, ${check.timeout.runner}. Raise the time limit instead.`);
  return { kind: 'override', override: { runner: larger } };
}

export function retryCheckSettings(mission: Pick<Mission, 'checks' | 'status'>, current: CheckSettings | undefined | null, adjustment: unknown): CheckSettingsInput {
  if (!RETRY_ADJUSTMENTS.includes(adjustment as RetryAdjustment)) throw new ApiError(400, 'INVALID_RETRY_ADJUSTMENT', 'Choose "timeout" or "runner".');
  if (!RETRYABLE_STATUSES.includes(mission.status)) throw new ApiError(409, 'MISSION_ACTIVE', 'Wait for the current attempt to finish before retrying its checks.');
  const check = timedOutCheck(mission);
  if (!check) throw new ApiError(409, 'CHECK_NOT_TIMED_OUT', 'No check in the latest attempt timed out.');
  const settings = keptSettings(current);
  if (adjustment === 'timeout') {
    if (check.timeout.timeoutSource === 'gitflare.json') throw new ApiError(409, 'POLICY_FILE_SETS_LIMIT', 'gitflare.json at the base revision sets timeoutSeconds, which takes precedence over repository settings. Change it there, or ask an Owner to override it for this proposal or in the repository check settings (gitflare.json override).');
    if (check.timeout.seconds >= MAX_TIMEOUT_SECONDS) throw new ApiError(409, 'LIMIT_AT_MAXIMUM', `The check already used the maximum ${MAX_TIMEOUT_SECONDS} s. Choose a larger runner instead.`);
    return { ...settings, testTimeoutSeconds: check.timeout.seconds < RETRY_TIMEOUT_SECONDS ? RETRY_TIMEOUT_SECONDS : MAX_TIMEOUT_SECONDS };
  }
  if (check.timeout.runnerSource === 'gitflare.json') throw new ApiError(409, 'POLICY_FILE_SETS_LIMIT', 'gitflare.json at the base revision sets runner, which takes precedence over repository settings. Change it there, or ask an Owner to override it for this proposal or in the repository check settings (gitflare.json override).');
  const larger = nextRunner(check.timeout.runner);
  if (!larger) throw new ApiError(409, 'LIMIT_AT_MAXIMUM', `The check already ran on the largest runner, ${check.timeout.runner}. Raise the time limit instead.`);
  return { ...settings, runner: larger };
}
