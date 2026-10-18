import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { ArrowCounterClockwiseIcon, PauseIcon, PlayIcon, RobotIcon, XIcon } from "@phosphor-icons/react";
import type { Mission, MissionAttempt } from "../shared/types";
import { DEFAULT_REPLAY_SPEED, REPLAY_SPEEDS, replayFrame, type MissionReplay, type ReplaySummary } from "../shared/demo-replay";
import { request } from "./api";
import "./demo-replay.css";

const TICK_MS = 250;
let summaries: Promise<ReplaySummary[]> | null = null;
let pending: string | null = null;

export function demoReplays(): Promise<ReplaySummary[]> {
  summaries ??= request<{ replays: ReplaySummary[] }>("/api/demo/replay").then((result) => result.replays, () => { summaries = null; return []; });
  return summaries;
}

export function requestReplay(missionId: string): void { pending = missionId; }

function takeRequest(missionId: string): boolean {
  const asked = pending === missionId || new URLSearchParams(window.location.search).has("replay");
  if (pending === missionId) pending = null;
  return asked;
}

const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

export interface MissionReplayState {
  available: boolean;
  active: boolean;
  mission?: Mission;
  attempts?: MissionAttempt[];
  start(): void;
  bar: ReactNode;
}

export function useMissionReplay(missionId: string, demo: boolean): MissionReplayState {
  const [available, setAvailable] = useState(false);
  const [replay, setReplay] = useState<MissionReplay | null>(null);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(DEFAULT_REPLAY_SPEED);
  const [elapsed, setElapsed] = useState(0);
  const [origin, setOrigin] = useState(0);
  const loading = useRef(false);

  useEffect(() => {
    if (!demo) return;
    let active = true;
    void demoReplays().then((items) => {
      if (!active || !items.some((item) => item.missionId === missionId)) return;
      setAvailable(true);
      if (takeRequest(missionId)) start();
    });
    return () => { active = false; };
  }, [demo, missionId]);

  useEffect(() => {
    if (!playing || !replay) return;
    const timer = window.setInterval(() => {
      setElapsed((value) => {
        const next = Math.min(replay.durationMs, value + TICK_MS * speed);
        if (next >= replay.durationMs) setPlaying(false);
        return next;
      });
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [playing, replay, speed]);

  function start() {
    setElapsed(0);
    setOrigin(Date.now());
    setPlaying(true);
    setError("");
    if (replay || loading.current) return;
    loading.current = true;
    request<MissionReplay>(`/api/demo/replay/${encodeURIComponent(missionId)}`).then(setReplay, (failure: unknown) => {
      setPlaying(false);
      setError(failure instanceof Error ? failure.message : "The recorded mission could not be loaded.");
    }).finally(() => { loading.current = false; });
  }

  function exit() { setReplay(null); setPlaying(false); setElapsed(0); }

  const frame = useMemo(() => replay ? replayFrame(replay, elapsed, (step) => new Date(origin + step.t).toISOString()) : null, [replay, elapsed, origin]);
  const finished = !!replay && elapsed >= replay.durationMs;
  const latest = frame?.mission.events.at(-1);

  const bar = error ? (
    <div className="alert" role="alert"><RobotIcon size={17} /><div className="alert-text">{error}</div></div>
  ) : replay && frame ? (
    <section className="demo-replay-bar" aria-label="Mission replay">
      <div className="demo-replay-heading">
        <span className={`demo-replay-signal${playing ? " live" : ""}`} aria-hidden="true" />
        <div>
          <strong>{finished ? "Replay finished: the mission is awaiting approval" : playing ? "Replaying a recorded mission" : "Replay paused"}</strong>
          <p>Recorded from a real Gitflare build of neon-drift. Nothing runs here: no models, no sandboxes, and nothing you see is written to the demo.</p>
        </div>
      </div>
      <div className="demo-replay-progress" role="progressbar" aria-label="Replay progress" aria-valuemin={0} aria-valuemax={Math.round(replay.durationMs / 1000)} aria-valuenow={Math.round(elapsed / 1000)} aria-valuetext={`${clock(elapsed)} of ${clock(replay.durationMs)} recorded time`}>
        <span style={{ width: `${(elapsed / replay.durationMs) * 100}%` }} />
      </div>
      <div className="demo-replay-controls">
        <span className="demo-replay-time">{clock(elapsed)} / {clock(replay.durationMs)}</span>
        {finished ? (
          <Button variant="secondary" size="sm" icon={ArrowCounterClockwiseIcon} onClick={start}>Replay again</Button>
        ) : (
          <Button variant="secondary" size="sm" icon={playing ? PauseIcon : PlayIcon} onClick={() => setPlaying(!playing)}>{playing ? "Pause" : "Resume"}</Button>
        )}
        <div className="demo-replay-speeds" role="group" aria-label="Replay speed">
          {REPLAY_SPEEDS.map((value) => <button key={value} type="button" aria-pressed={speed === value} onClick={() => setSpeed(value)}>{value}×</button>)}
        </div>
        {!finished && <Button variant="ghost" size="sm" icon={ArrowCounterClockwiseIcon} onClick={start}>Restart</Button>}
        <Button variant="ghost" size="sm" icon={XIcon} onClick={exit}>Exit replay</Button>
      </div>
      <p className="demo-replay-latest" aria-live="polite">{finished ? "In your own workspace an Owner or Maintainer would now review the diff and approve this exact candidate. The demo stops before approval." : latest?.message.split("\n")[0]}</p>
    </section>
  ) : null;

  return { available, active: !!frame, mission: frame?.mission, attempts: frame?.attempts, start, bar };
}

export function DemoReplayCard({ onWatch }: { onWatch: (missionId: string) => void }) {
  const [replays, setReplays] = useState<ReplaySummary[]>([]);
  useEffect(() => { let active = true; void demoReplays().then((items) => { if (active) setReplays(items); }); return () => { active = false; }; }, []);
  const replay = replays[0];
  if (!replay) return null;
  return (
    <section className="demo-replay-card" aria-label="Watch a mission run">
      <RobotIcon size={22} />
      <div>
        <h2>Watch a mission run</h2>
        <p>Replay {replay.agents} agents polishing the neon-drift game: they write files, run tests, fail on a runner, retry and pass checks until the mission waits for approval. Recorded from a real build and played back in your browser at {replay.defaultSpeed}×.</p>
      </div>
      <Button variant="primary" size="base" icon={PlayIcon} onClick={() => { requestReplay(replay.missionId); onWatch(replay.missionId); }}>Watch a mission run</Button>
    </section>
  );
}
