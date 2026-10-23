import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission, MissionStatus } from '../src/shared/types';
import { createMissionPoller, elapsedLabel, FAST_POLL_MS, IDLE_POLL_MS, landingOutcome, missionPollDelay, SETTLE_POLL_MS, STALL_MS, supersedes } from '../src/ui/mission-refresh';

const candidateSha = 'b'.repeat(40);
const landedSha = 'c'.repeat(40);

function mission(status: MissionStatus, updatedAt: string, extra: Partial<Mission> = {}): Mission {
  return { id: 'm-1', repositoryId: 'r-1', title: 'Fix', prompt: 'Fix', status, baseSha: 'a'.repeat(40), candidateSha, epoch: 2, runs: [], checks: [], events: [], changes: [], createdAt: '2026-10-23T13:00:00.000Z', updatedAt, ...extra };
}

type Harness = { state: Mission | undefined; toasts: string[]; failures: unknown[]; visible: boolean; replies: (() => Promise<Mission>)[]; calls: number };

function harness(initial: Mission, since: number) {
  const h: Harness = { state: initial, toasts: [], failures: [], visible: true, replies: [], calls: 0 };
  const poller = createMissionPoller<Mission>({
    fetch: () => { h.calls++; return (h.replies.shift() ?? (() => Promise.resolve(h.state!)))(); },
    accept: (next) => {
      if (!supersedes(next, h.state)) return;
      const outcome = landingOutcome(h.state, next);
      h.state = next;
      if (outcome?.kind === 'landed') h.toasts.push(`Landed ${outcome.sha.slice(0, 12)}.`);
    },
    fail: (error) => h.failures.push(error),
    delay: () => missionPollDelay({ status: h.state?.status, pending: false, since, now: Date.now() }),
    visible: () => h.visible,
  });
  return { h, poller };
}

describe('mission refresh while landing', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-10-23T13:32:02Z') }); });
  afterEach(() => { vi.useRealTimers(); });

  it('polls every 1.5 s while landing and backs off to 5 s after 30 s', () => {
    const since = Date.now();
    expect(missionPollDelay({ status: 'integrating', pending: false, since, now: since + 1000 })).toBe(FAST_POLL_MS);
    expect(missionPollDelay({ status: 'integrating', pending: false, since, now: since + 31_000 })).toBe(SETTLE_POLL_MS);
    expect(missionPollDelay({ status: 'approved', pending: true, since, now: since + 2000 })).toBe(FAST_POLL_MS);
    expect(missionPollDelay({ status: 'running', pending: false, since, now: since })).toBe(SETTLE_POLL_MS);
    expect(missionPollDelay({ status: 'integrated', pending: false, since, now: since })).toBe(IDLE_POLL_MS);
  });

  it('moves from Landing… to Landed with a toast once the server reports the landed revision', async () => {
    const landing = mission('integrating', '2026-10-23T13:32:03.000Z');
    const { h, poller } = harness(landing, Date.now());
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toBe(1);
    expect(h.state?.status).toBe('integrating');
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    expect(h.calls).toBe(2);
    h.replies.push(() => Promise.resolve(mission('integrated', '2026-10-23T13:32:18.000Z', { landedSha })));
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    expect(h.calls).toBe(3);
    expect(h.state?.status).toBe('integrated');
    expect(h.toasts).toEqual([`Landed ${landedSha.slice(0, 12)}.`]);
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 4);
    expect(h.calls).toBe(3);
    poller.stop();
  });

  it('keeps the landed state when the slower land POST answers with its earlier snapshot', () => {
    const landed = mission('integrated', '2026-10-23T13:32:18.000Z', { landedSha });
    const claimSnapshot = mission('integrating', '2026-10-23T13:32:03.000Z');
    expect(supersedes(claimSnapshot, landed)).toBe(false);
    expect(supersedes(landed, claimSnapshot)).toBe(true);
    expect(supersedes(mission('running', '2026-10-23T13:00:00.000Z', { epoch: 3 }), landed)).toBe(true);
  });

  it('reports a failed landing with the server’s reason', () => {
    const landing = mission('integrating', '2026-10-23T13:32:03.000Z');
    const failed = mission('approved', '2026-10-23T13:32:10.000Z', { error: 'Integration stopped before attempting a canonical push. Retry integration.' });
    expect(landingOutcome(landing, failed)).toEqual({ kind: 'failed', reason: failed.error });
    expect(landingOutcome(undefined, mission('integrated', '2026-10-23T13:32:18.000Z'))).toBeNull();
  });

  it('recovers a stalled poll when the window regains focus', async () => {
    const landing = mission('integrating', '2026-10-23T13:32:03.000Z');
    const { h, poller } = harness(landing, Date.now());
    h.replies.push(() => new Promise<Mission>(() => {}));
    poller.start();
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 3);
    expect(h.calls).toBe(1);
    h.replies.push(() => Promise.resolve(mission('integrated', '2026-10-23T13:32:18.000Z', { landedSha })));
    poller.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toBe(2);
    expect(h.state?.status).toBe('integrated');
    expect(h.toasts).toHaveLength(1);
    poller.stop();
  });

  it('retries a stalled poll on its own after the stall window', async () => {
    const { h, poller } = harness(mission('integrating', '2026-10-23T13:32:03.000Z'), Date.now());
    h.replies.push(() => new Promise<Mission>(() => {}));
    poller.start();
    await vi.advanceTimersByTimeAsync(STALL_MS - 1);
    expect(h.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toBe(2);
    poller.stop();
  });

  it('pauses while hidden and resumes when the tab becomes visible', async () => {
    const { h, poller } = harness(mission('integrating', '2026-10-23T13:32:03.000Z'), Date.now());
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    h.visible = false;
    poller.wake();
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 10);
    expect(h.calls).toBe(1);
    h.visible = true;
    h.replies.push(() => Promise.resolve(mission('integrated', '2026-10-23T13:32:18.000Z', { landedSha })));
    poller.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toBe(2);
    expect(h.state?.status).toBe('integrated');
    poller.stop();
  });

  it('shows elapsed time on a pending button after 5 s', () => {
    const since = Date.now();
    expect(elapsedLabel('Landing…', since, since + 4999)).toBe('Landing…');
    expect(elapsedLabel('Landing…', since, since + 12_000)).toBe('Landing… 12s');
    expect(elapsedLabel('Approving…', since, since + 75_000)).toBe('Approving… 1m 15s');
    expect(elapsedLabel('Landing…', 0, since)).toBe('Landing…');
  });
});
