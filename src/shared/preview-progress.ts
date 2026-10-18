export const PREVIEW_FAILURE_MAX = 6_000;

export const PREVIEW_STEPS = ['queued', 'cloning', 'installing', 'building', 'publishing', 'starting'] as const;
export type PreviewStep = typeof PREVIEW_STEPS[number];

export const PREVIEW_STEP_LABELS: Record<PreviewStep, string> = {
  queued: 'Waiting for the preview runner',
  cloning: 'Cloning this revision',
  installing: 'Installing dependencies',
  building: 'Building',
  publishing: 'Publishing the Worker Preview',
  starting: 'Starting the preview container',
};

export interface PreviewProgress { startedAt?: string; step?: PreviewStep; message?: string }
export interface PreviewStatusLike extends PreviewProgress { status?: string; error?: string }

export type ResumedPreview =
  | { kind: 'preparing'; progress: PreviewProgress }
  | { kind: 'ready' }
  | { kind: 'failed'; error: string }
  | { kind: 'none' };

export function resumePreview(status: PreviewStatusLike): ResumedPreview {
  if (status.status === 'starting') return { kind: 'preparing', progress: { ...(status.startedAt ? { startedAt: status.startedAt } : {}), ...(status.step ? { step: status.step } : {}), ...(status.message ? { message: status.message } : {}) } };
  if (status.status === 'ready') return { kind: 'ready' };
  if (status.status === 'failed') return { kind: 'failed', error: status.error ?? 'The preview stopped before it was ready. Prepare it again.' };
  return { kind: 'none' };
}

export function elapsedLabel(startedAt: string | undefined, now: number): string | null {
  const started = Date.parse(startedAt ?? '');
  if (!Number.isFinite(started)) return null;
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function previewProgressLine(progress: PreviewProgress, now: number): string {
  const step = PREVIEW_STEP_LABELS[progress.step ?? 'queued'];
  const elapsed = elapsedLabel(progress.startedAt, now);
  return elapsed ? `${step} · ${elapsed} elapsed` : step;
}
