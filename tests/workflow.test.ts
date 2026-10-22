import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mission } from '../src/shared/types';
import { platformInterruption } from '../src/worker/workflow';
import { AGENT_BUDGET_MS, AGENT_CONCURRENCY, AGENT_RUN_MS, CANDIDATE_FETCH_MS, COMBINE_MS, INSTALL_BUDGET_MS, LOCKFILE_UPDATE_MS, RUNNER_PREPARE_MS, TEST_BUDGET_MS, agentWaves, missionStepTimeoutMs } from '../src/worker/budgets';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  WorkflowEntrypoint: class { constructor(public ctx: unknown, public env: unknown) {} },
}));
const background = vi.hoisted(() => ({ landCandidate: vi.fn(async () => {}), preparePreview: vi.fn(async () => {}) }));
vi.mock('../src/worker/background-work', () => background);

afterEach(() => { vi.restoreAllMocks(); });

const runs = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `run-${index}` })) as Mission['runs'];

describe('mission step timeout', () => {
  it('covers every agent wave, its verification and the combined check instead of a fixed 25 minutes', () => {
    const eight = { runs: runs(8) };
    expect(agentWaves(eight)).toBe(Math.ceil(8 / AGENT_CONCURRENCY));
    expect(AGENT_RUN_MS).toBeGreaterThanOrEqual(AGENT_BUDGET_MS + 2 * RUNNER_PREPARE_MS + 3 * INSTALL_BUDGET_MS + 2 * TEST_BUDGET_MS);
    expect(missionStepTimeoutMs(eight)).toBeGreaterThan(3 * AGENT_RUN_MS + COMBINE_MS);
    expect(missionStepTimeoutMs(eight)).toBeGreaterThan(missionStepTimeoutMs({ runs: runs(3) }));
    expect(missionStepTimeoutMs({ runs: runs(3) })).toBeGreaterThan(25 * 60_000);
  });

  it('reserves a lockfile-only install for each agent and for the combined candidate', () => {
    expect(LOCKFILE_UPDATE_MS).toBe(INSTALL_BUDGET_MS);
    expect(AGENT_RUN_MS).toBeGreaterThanOrEqual(AGENT_BUDGET_MS + 2 * RUNNER_PREPARE_MS + 4 * INSTALL_BUDGET_MS + 2 * TEST_BUDGET_MS + LOCKFILE_UPDATE_MS);
    expect(COMBINE_MS).toBeGreaterThanOrEqual(RUNNER_PREPARE_MS + LOCKFILE_UPDATE_MS + INSTALL_BUDGET_MS + TEST_BUDGET_MS + 2 * (RUNNER_PREPARE_MS + 2 * INSTALL_BUDGET_MS + 2 * TEST_BUDGET_MS));
  });

  it('gives ten agents a fourth wave', () => {
    const ten = { runs: runs(10) };
    expect(agentWaves(ten)).toBe(4);
    expect(missionStepTimeoutMs(ten) - missionStepTimeoutMs({ runs: runs(8) })).toBe(AGENT_RUN_MS + 2 * CANDIDATE_FETCH_MS);
  });

  it('runs a trusted or race mission without the combined-check allowance', () => {
    expect(missionStepTimeoutMs({ runs: runs(1), branchChange: {} as Mission['branchChange'] })).toBe(missionStepTimeoutMs({ runs: runs(1) }));
    expect(missionStepTimeoutMs({ runs: runs(2), mode: 'race' })).toBe(missionStepTimeoutMs({ runs: runs(2) }) - COMBINE_MS - 2 * CANDIDATE_FETCH_MS);
  });
});

describe('MissionWorkflow', () => {
  async function workflow(mission: Partial<Mission> | undefined) {
    const { MissionWorkflow } = await import('../src/worker/workflow');
    const coordinator = { getMission: vi.fn(async () => mission), isMissionActive: vi.fn(async () => false), recordExecution: vi.fn(), getRepository: vi.fn(async () => ({ id: 'repo' })) };
    const catalog = { releaseMissionSlot: vi.fn(async () => {}) };
    const names: string[] = [];
    const env = { GITFLARE_COORDINATOR: { getByName: (name: string) => { names.push(name); return name.startsWith('catalog:') ? catalog : coordinator; } } };
    const instance = new MissionWorkflow({} as ExecutionContext, env as never);
    const step = { do: vi.fn(async (_name: string, _config: { timeout: number }, callback: () => Promise<unknown>) => callback()) };
    return { instance, step, catalog, names, env };
  }

  it('sizes the execution step from the pinned mission and releases its workspace slot', async () => {
    const mission = { id: 'mission', runs: runs(8), authorization: { workspaceId: 'w1' } as Mission['authorization'] };
    const { instance, step, catalog, names } = await workflow(mission);
    await instance.run({ payload: { repositoryId: 'repo', missionId: 'mission', epoch: 2 } } as never, step as never);
    expect(step.do.mock.calls[0][1]).toMatchObject({ timeout: missionStepTimeoutMs(mission) });
    expect(names).toContain('catalog:w1');
    expect(catalog.releaseMissionSlot).toHaveBeenCalledWith('mission', 2);
  });

  it('records the Workflows failure reason on interrupted runs', async () => {
    const mission = { id: 'mission', runs: [{ id: 'run-0', status: 'running' }], checks: [], changes: [], authorization: { workspaceId: 'w1' } } as unknown as Mission;
    const { instance, env } = await workflow(mission);
    const coordinator = env.GITFLARE_COORDINATOR.getByName('repository:repo') as unknown as { isMissionActive: ReturnType<typeof vi.fn>; recordExecution: ReturnType<typeof vi.fn> };
    coordinator.isMissionActive.mockResolvedValue(true);
    const step = { do: vi.fn(async () => { throw new Error('Sandbox lost its container'); }) };
    await expect(instance.run({ payload: { repositoryId: 'repo', missionId: 'mission', epoch: 5 } } as never, step as never)).rejects.toThrow('Sandbox lost');
    expect(coordinator.recordExecution.mock.calls[0][2].runs[0]).toMatchObject({ status: 'failed', error: 'Execution interrupted: Sandbox lost its container' });
  });

  it('explains an internal Workflows error with the run time and last progress', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-18T17:35:32Z'));
    const mission = { id: 'mission', runs: [{ id: 'run-0', status: 'running', startedAt: '2026-10-18T17:30:29Z', summary: 'Waiting for Claude Fable 5.1' }, { id: 'run-1', status: 'queued' }, { id: 'run-2', status: 'succeeded' }], checks: [], changes: [], authorization: { workspaceId: 'w1' } } as unknown as Mission;
    const { instance, env } = await workflow(mission);
    const coordinator = env.GITFLARE_COORDINATOR.getByName('repository:repo') as unknown as { isMissionActive: ReturnType<typeof vi.fn>; recordExecution: ReturnType<typeof vi.fn> };
    coordinator.isMissionActive.mockResolvedValue(true);
    const step = { do: vi.fn(async () => { throw Object.assign(new Error('Attempt failed due to internal workflows error'), { name: 'WorkflowInternalError' }); }) };
    await expect(instance.run({ payload: { repositoryId: 'repo', missionId: 'mission', epoch: 2 } } as never, step as never)).rejects.toThrow('internal workflows error');
    const recorded = coordinator.recordExecution.mock.calls[0][2];
    expect(recorded.runs[0].error).toBe('Cloudflare Workflows stopped this attempt after 5 min 3 s ("internal workflows error"); Gitflare\'s code reported no error. Last progress: Waiting for Claude Fable 5.1. Retry the agent to run it again.');
    expect(recorded.runs[1].error).toBe('Cloudflare Workflows stopped this attempt ("internal workflows error"); Gitflare\'s code reported no error. Retry the agent to run it again.');
    expect(recorded.runs[2]).toEqual({ id: 'run-2', status: 'succeeded' });
    expect(recorded.error).toBe('Cloudflare Workflows stopped this attempt ("internal workflows error"); Gitflare\'s code reported no error.');
    expect(platformInterruption(new Error('WorkflowInternalError: Attempt failed due to internal workflows error'))).toBe(true);
    expect(platformInterruption(new Error('Mission cancelled'))).toBe(false);
  });

  it('routes landing and preview work to their background steps without touching mission slots', async () => {
    const { instance, step, catalog, env } = await workflow(undefined);
    const land = { kind: 'land', repositoryId: 'repo', missionId: 'mission', epoch: 1, candidateSha: 'b'.repeat(40), baseSha: 'a'.repeat(40), claimId: 'claim', principal: {} };
    await instance.run({ payload: land } as never, step as never);
    expect(background.landCandidate).toHaveBeenCalledWith(env, land, step);
    const preview = { ...land, kind: 'preview' };
    await instance.run({ payload: preview } as never, step as never);
    expect(background.preparePreview).toHaveBeenCalledWith(env, preview, step);
    expect(catalog.releaseMissionSlot).not.toHaveBeenCalled();
  });
});
