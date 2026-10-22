import { describe, expect, it, vi } from 'vitest';
import { autoDraftInput, autoDraftRequest, COORDINATOR_DUTY, parseAutoPlan, planMission, type AutoDraftRequest } from '../src/worker/mission-draft';
import { byStrength, defaultAllowedModels, planToManual } from '../src/shared/mission-draft';
import { missionInput } from '../src/worker/domain';
import { agentWaves } from '../src/worker/budgets';
import type { Mission, ModelConnection } from '../src/shared/types';

const verified = { status: 'verified' as const, checkedAt: '2026-10-18T00:00:00Z', detail: 'ok' };
const sonnet: ModelConnection = { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5', source: 'gateway', protocol: 'anthropic', verification: verified };
const opus: ModelConnection = { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5', source: 'gateway', protocol: 'anthropic', verification: verified };
const luna: ModelConnection = { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna', source: 'gateway', protocol: 'responses', verification: verified };
const sol: ModelConnection = { id: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol', source: 'gateway', protocol: 'responses' };
const workspace = [sonnet, opus, luna, sol];
const goal = 'Build a todo app with a JSON API, a web UI and tests.';
const snapshot = { commitSha: 'a'.repeat(40), files: ['README.md', 'package.json', 'src/index.mjs', 'tests/index.test.mjs'], readme: '# Todo', packageJson: '{"scripts":{"test":"node --test"}}' };

const request = (maxAgents = 4, allowed = [sonnet, opus]): AutoDraftRequest => ({ goal, maxAgents, allowedModels: byStrength(allowed) });
const task = (name: string, model = 'anthropic/claude-sonnet-5-5', extra: Record<string, unknown> = {}): Record<string, unknown> => ({ name, role: name, task: `Build the ${name} part in src/${name.toLowerCase()}.mjs with tests.`, model, reason: `${name} needs care.`, ...extra });
const plan = (body: Record<string, unknown>) => JSON.stringify({ title: 'Todo app', strategyReason: 'Parts are independent.', acceptanceCriteria: ['API returns todos', 'UI lists todos'], ...body });

describe('auto plan request', () => {
  it('defaults to four agents and every verified Claude model', () => {
    const parsed = autoDraftRequest({ goal }, workspace);
    expect(parsed.maxAgents).toBe(4);
    expect(parsed.allowedModels.map((model) => model.id)).toEqual(['anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5']);
    expect(defaultAllowedModels(workspace)).toEqual(['anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5']);
  });

  it('accepts one to ten agents', () => {
    expect(autoDraftRequest({ goal, maxAgents: 1 }, workspace).maxAgents).toBe(1);
    expect(autoDraftRequest({ goal, maxAgents: 10 }, workspace).maxAgents).toBe(10);
    for (const maxAgents of [0, 11, 2.5, '3x']) expect(() => autoDraftRequest({ goal, maxAgents }, workspace)).toThrow('between one and 10');
  });

  it('refuses unverified, unknown or malformed allowed models', () => {
    expect(() => autoDraftRequest({ goal, allowedModels: ['openai/gpt-6.1-sol'] }, workspace)).toThrow('GPT-6.1 Sol is not verified');
    expect(() => autoDraftRequest({ goal, allowedModels: ['anthropic/claude-haiku-5'] }, workspace)).toThrow('not enabled in this workspace');
    expect(() => autoDraftRequest({ goal, allowedModels: [] }, workspace)).toThrow('between one and 20');
    expect(() => autoDraftRequest({ goal, allowedModels: [42] }, workspace)).toThrow('between one and 20');
    expect(autoDraftRequest({ goal, allowedModels: ['openai/gpt-6-luna', 'openai/gpt-6-luna'] }, workspace).allowedModels).toEqual([luna]);
  });

  it('needs a verified Claude model when no models are given', () => {
    expect(() => autoDraftRequest({ goal }, [{ ...sonnet, verification: undefined }, luna])).toThrow('No verified Claude model');
  });

  it('tells the planner the limit, the allowed models strongest first and the coordinator role', () => {
    const [system, user] = autoDraftInput(request(3, [sonnet, opus]), snapshot);
    expect(system.content).toContain('at most 3 agent(s)');
    expect(system.content).toContain('"id":"anthropic/claude-opus-5-5","label":"Claude Opus 5.5","rank":1');
    expect(system.content).toContain('exactly one agent is the coordinator');
    expect(system.content).toContain('untrusted data');
    expect(JSON.parse(user.content as string)).toMatchObject({ goal, maxAgents: 3 });
  });
});

describe('auto plan validation', () => {
  it('keeps a valid combine plan with its coordinator last', () => {
    const result = parseAutoPlan(plan({ strategy: 'combine', tasks: [task('Coordinator', 'anthropic/claude-opus-5-5', { coordinator: true, task: 'Run the whole suite.' }), task('API', 'anthropic/claude-opus-5-5'), task('UI')] }), request());
    expect(result).toMatchObject({ auto: true, strategy: 'combine', mode: 'combine', title: 'Todo app', strategyReason: 'Parts are independent.', acceptanceCriteria: ['API returns todos', 'UI lists todos'] });
    expect(result.tasks.map((item) => [item.name, item.model, !!item.coordinator])).toEqual([['API', 'anthropic/claude-opus-5-5', false], ['UI', 'anthropic/claude-sonnet-5-5', false], ['Coordinator', 'anthropic/claude-opus-5-5', true]]);
    expect(result.tasks[2]!.task).toBe(`${COORDINATOR_DUTY} Run the whole suite.`);
    expect(result.tasks[0]!.reason).toBe('API needs care.');
    expect(result.warnings).toBeUndefined();
  });

  it('adds a missing coordinator and keeps only the first of several', () => {
    const added = parseAutoPlan(plan({ strategy: 'combine', tasks: [task('API'), task('UI')] }), request());
    expect(added.tasks.filter((item) => item.coordinator)).toHaveLength(1);
    expect(added.tasks.at(-1)).toMatchObject({ name: 'Coordinator', coordinator: true, model: 'anthropic/claude-opus-5-5' });
    expect(added.warnings).toContain('The plan had no coordinator, so Gitflare added one.');
    const many = parseAutoPlan(plan({ strategy: 'combine', tasks: [task('API', undefined, { coordinator: true }), task('UI', undefined, { coordinator: true }), task('Docs')] }), request());
    expect(many.tasks.filter((item) => item.coordinator).map((item) => item.name)).toEqual(['API']);
    expect(many.tasks).toHaveLength(3);
  });

  it('never exceeds max agents and folds extra parts instead of dropping them', () => {
    const result = parseAutoPlan(plan({ strategy: 'combine', tasks: [task('API'), task('UI'), task('Docs'), task('Styles'), task('Coordinator', undefined, { coordinator: true })] }), request(3));
    expect(result.tasks.map((item) => item.name)).toEqual(['API', 'UI', 'Coordinator']);
    expect(result.tasks[1]!.task).toContain('src/docs.mjs');
    expect(result.tasks[1]!.task).toContain('src/styles.mjs');
    expect(result.warnings?.[0]).toContain('more than 3 agents');
    const single = parseAutoPlan(plan({ strategy: 'combine', tasks: [task('API'), task('UI'), task('Coordinator', undefined, { coordinator: true })] }), request(1));
    expect(single.tasks).toHaveLength(1);
    expect(single.tasks[0]!.coordinator).toBeUndefined();
  });

  it('replaces a model that is not allowed with the strongest allowed one and says so', () => {
    const result = parseAutoPlan(plan({ strategy: 'combine', tasks: [task('API', 'openai/gpt-6.1-sol'), task('UI', 'anthropic/claude-opus-5-5'), task('Coordinator', 'openai/gpt-6-luna', { coordinator: true })] }), request(4, [sonnet]));
    expect(result.tasks.every((item) => item.model === 'anthropic/claude-sonnet-5-5')).toBe(true);
    expect(result.tasks[0]!.reason).toBe('Strongest allowed model.');
    expect(result.warnings?.join(' ')).toContain('API (openai/gpt-6.1-sol), UI (anthropic/claude-opus-5-5), Coordinator (openai/gpt-6-luna)');
  });

  it('plans a race without a coordinator, and falls back to combine when a race is impossible', () => {
    const race = parseAutoPlan(plan({ strategy: 'race', tasks: [task('Minimal'), task('Thorough'), task('Coordinator', undefined, { coordinator: true })] }), request());
    expect(race).toMatchObject({ strategy: 'race', mode: 'race' });
    expect(race.tasks.map((item) => item.name)).toEqual(['Minimal', 'Thorough']);
    const lone = parseAutoPlan(plan({ strategy: 'race', tasks: [task('Minimal'), task('Thorough')] }), request(1));
    expect(lone).toMatchObject({ strategy: 'combine', mode: 'combine' });
    expect(lone.tasks).toHaveLength(1);
  });

  it('plans scaffold first as a single agent with a follow-up', () => {
    const result = parseAutoPlan(plan({ strategy: 'scaffold', followUp: 'Then split the UI and API.', tasks: [task('Scaffold'), task('UI'), task('Coordinator', undefined, { coordinator: true })] }), request());
    expect(result).toMatchObject({ strategy: 'scaffold', mode: 'combine', followUp: 'Then split the UI and API.' });
    expect(result.tasks.map((item) => item.name)).toEqual(['Scaffold']);
  });

  it('rejects output without assignments', () => {
    expect(() => parseAutoPlan('no plan here', request())).toThrow('did not return a usable plan');
    expect(() => parseAutoPlan(plan({ tasks: [] }), request())).toThrow('did not return any agent assignments');
    expect(() => parseAutoPlan(plan({ tasks: [task('Coordinator', undefined, { coordinator: true })] }), request())).toThrow('only a coordinator');
  });

  it('holds its invariants for any planner output', () => {
    const models = ['anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'openai/gpt-6.1-sol', 'bogus/model', ''];
    let seed = 7;
    const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let trial = 0; trial < 400; trial++) {
      const maxAgents = 1 + random(10);
      const allowed = [[sonnet], [opus], [sonnet, opus], [luna, sonnet]][random(4)]!;
      const strategy = ['combine', 'race', 'scaffold', 'nonsense'][random(4)];
      const tasks = Array.from({ length: 1 + random(12) }, (_, index) => task(`Agent ${index}`, models[random(models.length)], { coordinator: random(4) === 0 }));
      if (tasks.every((item) => item.coordinator)) tasks[0]!.coordinator = false;
      const result = parseAutoPlan(plan({ strategy, tasks }), request(maxAgents, allowed));
      const ids = allowed.map((model) => model.id);
      expect(result.tasks.length).toBeGreaterThanOrEqual(1);
      expect(result.tasks.length).toBeLessThanOrEqual(maxAgents);
      expect(result.tasks.every((item) => ids.includes(item.model))).toBe(true);
      const coordinators = result.tasks.filter((item) => item.coordinator).length;
      expect(coordinators).toBe(result.mode === 'combine' && result.tasks.length > 1 ? 1 : 0);
      if (coordinators) expect(result.tasks.at(-1)!.coordinator).toBe(true);
      if (result.mode === 'race') expect(result.tasks.length).toBeGreaterThanOrEqual(2);
      expect(new Set(result.tasks.map((item) => item.name.toLowerCase())).size).toBe(result.tasks.length);
      const manual = planToManual(result);
      expect(() => missionInput({ title: result.title, prompt: goal, repositoryId: 'repo', mode: manual.mode, tasks: manual.tasks })).not.toThrow();
    }
  });

  it('plans through the model and adds repository warnings', async () => {
    const output = plan({ strategy: 'combine', tasks: [task('API', 'anthropic/claude-opus-5-5', { task: 'Edit src/app.mjs for the API with tests.' }), task('UI', 'anthropic/claude-sonnet-5-5', { task: 'Edit src/app.mjs for the UI with tests.' }), task('Coordinator', 'anthropic/claude-opus-5-5', { coordinator: true, task: 'Check src/app.mjs after merging.' })] });
    const run = vi.fn(async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: output }] }] }));
    const result = await planMission({ AI: { run }, AI_GATEWAY_ID: 'gitflare' }, { id: 'openai/gpt-6-luna', protocol: 'responses', source: 'gateway' } as never, request(), snapshot);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.tasks).toHaveLength(3);
    expect(result.warnings).toEqual(['API and UI are both assigned src/app.mjs. Their edits will collide when the candidates are combined; give src/app.mjs to one agent.']);
  });
});

describe('coordinator in a mission', () => {
  const base = { title: 'Todo', prompt: goal, repositoryId: 'repo' };
  const tasks = [{ name: 'API', role: 'API', task: 'Build the API part.' }, { name: 'Coordinator', role: 'Integration', task: COORDINATOR_DUTY, coordinator: true }];

  it('accepts exactly one coordinator in combine mode with another agent', () => {
    expect(missionInput({ ...base, tasks }).tasks?.[1]).toMatchObject({ coordinator: true });
    expect(missionInput({ ...base, tasks: [{ ...tasks[0], coordinator: false }] }).tasks?.[0]?.coordinator).toBeUndefined();
    expect(() => missionInput({ ...base, tasks: [tasks[0], tasks[1], { ...tasks[1], name: 'Second' }] })).toThrow('at most one coordinator');
    expect(() => missionInput({ ...base, mode: 'race', tasks })).toThrow('needs combine mode');
    expect(() => missionInput({ ...base, tasks: [tasks[1]] })).toThrow('needs combine mode and at least one other agent');
    expect(() => missionInput({ ...base, tasks: [{ ...tasks[0], coordinator: 'yes' }, tasks[1]] })).toThrow('true or false');
  });

  it('budgets the coordinator as its own wave after the parts', () => {
    const runs = (count: number, coordinated: boolean) => Array.from({ length: count }, (_, index) => ({ coordinator: coordinated && index === count - 1 })) as Mission['runs'];
    expect(agentWaves({ runs: runs(2, true) })).toBe(2);
    expect(agentWaves({ runs: runs(4, true) })).toBe(2);
    expect(agentWaves({ runs: runs(5, true) })).toBe(3);
    expect(agentWaves({ runs: runs(4, false) })).toBe(2);
    expect(agentWaves({ runs: runs(3, false) })).toBe(1);
  });
});
