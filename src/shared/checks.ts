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
