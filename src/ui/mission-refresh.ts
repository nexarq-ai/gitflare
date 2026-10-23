import type { Mission, MissionStatus } from "../shared/types";
import { formatElapsed } from "./deploy-progress";

export const FAST_POLL_MS = 1500;
export const SETTLE_POLL_MS = 5000;
export const IDLE_POLL_MS = 30_000;
export const FAST_WINDOW_MS = 30_000;
export const STALL_MS = 15_000;
export const ELAPSED_AFTER_MS = 5000;
const WAKE_DEBOUNCE_MS = 1000;

const RUNNING: MissionStatus[] = ["queued", "running", "checking", "integrating"];

export function missionPollDelay(state: { status?: MissionStatus; pending: boolean; since: number; now: number }): number {
  if (state.pending || state.status === "integrating") return state.now - state.since < FAST_WINDOW_MS ? FAST_POLL_MS : SETTLE_POLL_MS;
  return state.status && RUNNING.includes(state.status) ? SETTLE_POLL_MS : IDLE_POLL_MS;
}

export function supersedes(next: Pick<Mission, "epoch" | "updatedAt">, current: Pick<Mission, "epoch" | "updatedAt"> | undefined): boolean {
  if (!current || !next.updatedAt || !current.updatedAt) return true;
  if (next.epoch !== current.epoch) return next.epoch > current.epoch;
  return next.updatedAt >= current.updatedAt;
}

export type LandingOutcome = { kind: "landed"; sha: string } | { kind: "failed"; reason: string };

export function landingOutcome(previous: Mission | undefined, next: Mission): LandingOutcome | null {
  if (!previous || previous.id !== next.id || !["approved", "integrating"].includes(previous.status)) return null;
  if (next.status === "integrated" && previous.status !== "integrated") {
    const sha = next.landedSha ?? next.candidateSha;
    return sha ? { kind: "landed", sha } : null;
  }
  if (previous.status === "integrating" && !previous.error && next.error && ["approved", "integrating"].includes(next.status)) return { kind: "failed", reason: next.error };
  return null;
}

export function elapsedLabel(label: string, since: number, now: number): string {
  const elapsed = now - since;
  return since && elapsed >= ELAPSED_AFTER_MS ? `${label} ${formatElapsed(elapsed)}` : label;
}

export type MissionPoller = { start(): void; wake(): void; reschedule(): void; stop(): void };

export function createMissionPoller<T>(options: {
  fetch: () => Promise<T>;
  accept: (value: T) => void;
  fail: (error: unknown) => void;
  delay: () => number;
  visible: () => boolean;
  now?: () => number;
}): MissionPoller {
  const now = options.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  let inFlight = false;
  let startedAt = 0;
  let stopped = false;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (delay = options.delay()) => {
    clear();
    if (!stopped && options.visible()) timer = setTimeout(() => void run(), delay);
  };
  const run = async () => {
    if (stopped) return;
    const mine = ++sequence;
    inFlight = true;
    startedAt = now();
    schedule(Math.max(options.delay(), STALL_MS));
    try {
      const value = await options.fetch();
      if (!stopped && mine === sequence) options.accept(value);
    } catch (error) {
      if (!stopped && mine === sequence) options.fail(error);
    } finally {
      if (!stopped && mine === sequence) {
        inFlight = false;
        schedule();
      }
    }
  };
  return {
    start: () => void run(),
    wake: () => {
      if (stopped) return;
      if (!options.visible()) return clear();
      if (inFlight && now() - startedAt < WAKE_DEBOUNCE_MS) return;
      void run();
    },
    reschedule: () => {
      if (!stopped && !inFlight) schedule();
    },
    stop: () => {
      stopped = true;
      clear();
    },
  };
}
