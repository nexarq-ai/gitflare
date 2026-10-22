import { describe, expect, it } from 'vitest';
import { elapsedLabel, previewProgressLine, resumePreview } from '../src/shared/preview-progress';

describe('mission page preview resume', () => {
  const startedAt = '2026-10-18T10:00:00.000Z';
  const now = Date.parse(startedAt) + 83_000;

  it('resumes a preparing preview from the server status with its step and elapsed time', () => {
    const resumed = resumePreview({ status: 'starting', startedAt, step: 'installing', message: 'Building a preview.' });
    expect(resumed).toEqual({ kind: 'preparing', progress: { startedAt, step: 'installing', message: 'Building a preview.' } });
    if (resumed.kind !== 'preparing') throw new Error('expected preparing');
    expect(previewProgressLine(resumed.progress, now)).toBe('Installing dependencies · 1:23 elapsed');
  });

  it('shows the same progress line in every tab reading the same status', () => {
    const status = { status: 'starting', startedAt, step: 'publishing' as const };
    const first = resumePreview(status);
    const second = resumePreview(JSON.parse(JSON.stringify(status)));
    expect(second).toEqual(first);
    if (first.kind !== 'preparing') throw new Error('expected preparing');
    expect(previewProgressLine(first.progress, now)).toBe('Publishing the Worker Preview · 1:23 elapsed');
  });

  it('falls back to the queued step when an older status has no progress fields', () => {
    const resumed = resumePreview({ status: 'starting' });
    if (resumed.kind !== 'preparing') throw new Error('expected preparing');
    expect(previewProgressLine(resumed.progress, now)).toBe('Waiting for the preview runner');
    expect(elapsedLabel(undefined, now)).toBeNull();
    expect(elapsedLabel('2026-10-18T10:00:30.000Z', Date.parse(startedAt))).toBe('0:00');
  });

  it('ends the preparing state on ready, failed and none', () => {
    expect(resumePreview({ status: 'ready' })).toEqual({ kind: 'ready' });
    expect(resumePreview({ status: 'failed', error: 'npm install failed' })).toEqual({ kind: 'failed', error: 'npm install failed' });
    expect(resumePreview({ status: 'none' })).toEqual({ kind: 'none' });
  });
});
