import { ApiError } from './domain';
import type { AppEnv } from './env';
import { DEMO_CONTROL, demoMode } from './demo';
import { demoRunsPlan } from './demo-seed';
import { demoReplaySummaries, type DemoRunsPlan } from './demo-runs';

export const DEMO_REPLAY_PATH = '/api/demo/replay';

let cached: { key: string; plan: DemoRunsPlan } | null = null;

function plan(generation: number, anchor: string): DemoRunsPlan {
  const key = `${generation}:${anchor}`;
  if (cached?.key !== key) cached = { key, plan: demoRunsPlan(generation, Date.parse(anchor)) };
  return cached.plan;
}

export async function handleDemoReplay(request: Request, env: AppEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== DEMO_REPLAY_PATH && !path.startsWith(`${DEMO_REPLAY_PATH}/`)) return null;
  if (!demoMode(env)) throw new ApiError(404, 'NOT_FOUND', 'This API route could not be found.');
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
  const { current } = await env.GITFLARE_COORDINATOR.getByName(DEMO_CONTROL).demoControl();
  if (!current) throw new ApiError(404, 'DEMO_NOT_SEEDED', 'The demo has not been seeded yet.');
  const runs = plan(current.generation, current.anchor);
  const id = path.slice(DEMO_REPLAY_PATH.length + 1);
  if (!id) return Response.json({ replays: demoReplaySummaries(runs) });
  if (id !== runs.replay.id && id !== runs.replay.missionId) throw new ApiError(404, 'REPLAY_NOT_FOUND', 'This recorded mission could not be found.');
  return Response.json(runs.replay);
}
