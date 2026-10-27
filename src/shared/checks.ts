import type { Check } from './types';

export function blockingChecks<T extends Pick<Check, 'advisory'>>(checks: T[]): T[] {
  return checks.filter((check) => !check.advisory);
}

export function blockingChecksPassed(checks: Pick<Check, 'advisory' | 'status'>[]): boolean {
  return blockingChecks(checks).every((check) => check.status === 'passed');
}

export function candidateVerified(checks: Pick<Check, 'advisory' | 'status' | 'candidateSha'>[], candidateSha: string | null | undefined): boolean {
  return !!candidateSha && checks.some((check) => check.candidateSha === candidateSha && check.status === 'passed' && !check.advisory) && blockingChecksPassed(checks);
}

export const LANDING_TESTS = 'Combined candidate tests';
export const VISUAL_CHECK_NAMES = { consoleErrors: 'Visual: console errors', overflow: 'Visual: no overflow at 390px', regression: 'Visual: regression', axe: 'Accessibility (axe)', lighthouse: 'Lighthouse' } as const;

export interface RequirableCheck { name: string; label: string; visual?: true }

export const REQUIRABLE_CHECKS: readonly RequirableCheck[] = [
  { name: LANDING_TESTS, label: 'Tests' },
  { name: VISUAL_CHECK_NAMES.consoleErrors, label: 'Console errors', visual: true },
  { name: VISUAL_CHECK_NAMES.overflow, label: 'Mobile overflow', visual: true },
  { name: VISUAL_CHECK_NAMES.regression, label: 'Visual regression', visual: true },
  { name: VISUAL_CHECK_NAMES.axe, label: 'Accessibility', visual: true },
  { name: VISUAL_CHECK_NAMES.lighthouse, label: 'Lighthouse', visual: true },
];

// Checks recorded before Check.detail existed carry their evidence notes in the name
const LEGACY_NOTE = /\s*\((?:exit code only|exit code and [^()]+ summary|tests added by the agent; the repository had none|single agent: reused the exact verified candidate checks|tests of the restored revision [0-9a-f]+)\)$/;

export function checkIdentity(name: string): string {
  const trimmed = name.trim();
  const stripped = trimmed.replace(LEGACY_NOTE, '');
  return stripped === trimmed ? trimmed : checkIdentity(stripped);
}

export function withDetail<T extends Pick<Check, 'detail'>>(check: T, note: string): T {
  check.detail = check.detail ? `${check.detail}; ${note}` : note;
  return check;
}

export function checkLabel(check: Pick<Check, 'name' | 'detail'>): string {
  return check.detail ? `${check.name} (${check.detail})` : check.name;
}

export function requiredCheckPassed(checks: { name: string; status: string; candidateSha?: string }[], required: string, candidateSha: string): boolean {
  const identity = checkIdentity(required);
  return checks.some((check) => check.status === 'passed' && check.candidateSha === candidateSha && checkIdentity(check.name) === identity);
}

export function requirableCheck(name: string): RequirableCheck | undefined {
  const identity = checkIdentity(name);
  return REQUIRABLE_CHECKS.find((check) => check.name === identity);
}

export function normalizeRequiredChecks(names: string[], saved: readonly string[]): { names: string[]; unknown: string[] } {
  const kept = new Set(saved.map(checkIdentity));
  const normalized = [...new Set(names.map(checkIdentity).filter(Boolean))];
  return { names: normalized, unknown: normalized.filter((name) => !requirableCheck(name) && !kept.has(name)) };
}

export function unknownCheckMessage(name: string): string {
  return `"${name}" is not a check that runs on every landing revision. Require one of: ${REQUIRABLE_CHECKS.map((check) => check.name).join(', ')}.`;
}
