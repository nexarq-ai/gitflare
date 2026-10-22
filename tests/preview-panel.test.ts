import { describe, expect, it } from 'vitest';
import { failureHeadline, hostSummary, remaining, type PreviewState } from '../src/ui/PreviewPanel';

const base: PreviewState = { previewUrl: 'https://pr-1.example.workers.dev', candidateSha: 'b08e7e088add0000', expiresAt: '2026-10-18T10:00:00Z', extended: false, access: 'link' };

describe('preview card', () => {
  it('puts the account behind details instead of the headline', () => {
    expect(hostSummary({ ...base, worker: { deploymentUrl: null, notes: [], host: { kind: 'connection', source: 'workspace', accountId: 'acct', workerName: 'shadow-fight', access: 'link' } } })).toEqual({ label: 'Worker Preview of shadow-fight', account: 'acct', via: 'workspace Cloudflare connection' });
    expect(hostSummary(base)).toEqual({ label: 'Isolated container on Gitflare’s preview origin' });
  });

  it('reduces a failure log to its first line', () => {
    expect(failureHeadline('\n  npm run build failed\nstack line 1\nstack line 2')).toBe('npm run build failed');
    expect(failureHeadline('x'.repeat(400))).toHaveLength(158);
    expect(failureHeadline('   ')).toBe('The preview stopped before it was ready.');
  });

  it('counts down in minutes and seconds', () => {
    expect(remaining('2026-10-18T10:00:00Z', Date.parse('2026-10-18T09:45:44Z'))).toBe('14:16');
    expect(remaining('2026-10-18T12:00:00Z', Date.parse('2026-10-18T09:45:00Z'))).toBe('2 h 15 min');
  });
});
