import { describe, expect, it, vi } from 'vitest';
import { DESIGN_REVIEWER_ID, type Mission, type ModelConnection, type Repository, type VisualRound } from '../src/shared/types';
import type { ArtifactRepo, ArtifactsBinding } from '../src/worker/artifacts';
import { missionInput } from '../src/worker/domain';
import { executeMission, qualityRoundCount, type ExecutionEnv, type SandboxRunner } from '../src/worker/execution';
import { autoDraftInput, draftInput, draftRequest, QUALITY_BAR_RULE } from '../src/worker/mission-draft';
import { designReviewWanted, reviewableEvidence, reviewText } from '../src/worker/visual/design-review';
import { modelStrength } from '../src/shared/mission-draft';
import { designBrief, DESIGN_GUIDE_PATH, DESIGN_TOKENS_PATH, loadDesignContext, normalizeQualityBar, qualityBarBrief, qualityBarProblem } from '../src/worker/visual/design-context';
import { critique, criticInput, designReviewBody, parseCritique, roundInstruction, strongestModel } from '../src/worker/visual/critic';

vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} }, WorkerEntrypoint: class {}, WorkflowEntrypoint: class {} }));

const blob = (text: string) => ({ size: text.length, arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer }) as unknown as Blob;

describe('design context', () => {
  it('loads the design guide and tokens at the base commit and caps their size', async () => {
    const guide = `# Design\n${'x'.repeat(30_000)}`;
    const source = { readFile: vi.fn(async ({ path }: { ref: string; path: string }) => path === DESIGN_GUIDE_PATH ? blob(guide) : path === DESIGN_TOKENS_PATH ? blob('{"color":{"ink":"#23262d"}}') : null) };
    const context = await loadDesignContext(source, 'a'.repeat(40));
    expect(context.guide!.length).toBe(24_576);
    expect(context.tokens).toBe('{"color":{"ink":"#23262d"}}');
    expect(context.truncated).toEqual([DESIGN_GUIDE_PATH]);
    expect(source.readFile).toHaveBeenCalledWith({ ref: 'a'.repeat(40), path: DESIGN_GUIDE_PATH });
    const brief = designBrief(context)!;
    expect(brief.note).toContain('Untrusted repository data');
    expect(brief.note).toContain('Truncated: .gitflare/DESIGN.md');
    expect(designBrief(await loadDesignContext({ readFile: vi.fn(async () => null) }, 'a'.repeat(40)))).toBeNull();
    expect(designBrief(await loadDesignContext({ readFile: vi.fn(async () => { throw new Error('missing'); }) }, 'a'.repeat(40)))).toBeNull();
  });

  it('validates and normalizes the quality bar', () => {
    expect(qualityBarProblem({ target: ' AAA fighting game, Tekken-like lighting ', references: [{ kind: 'url', value: 'https://example.com/ref.png', note: 'stance' }, { kind: 'text', value: 'fluid 60fps animation' }] })).toBeNull();
    expect(normalizeQualityBar({ target: ' AAA ', references: [{ kind: 'text', value: ' smooth ', note: ' ' }] })).toEqual({ target: 'AAA', references: [{ kind: 'text', value: 'smooth' }] });
    expect(qualityBarProblem({ target: '' })).toContain('target must be plain text');
    expect(qualityBarProblem({ target: 'x', references: [{ kind: 'url', value: 'ftp://x' }] })).toContain('http://');
    expect(qualityBarProblem({ target: 'x', references: [{ kind: 'image', value: 'x' }] })).toContain('url or text');
    expect(qualityBarProblem({ target: 'x', extra: 1 })).toContain('not extra');
    expect(qualityBarProblem({ target: 'x', references: Array.from({ length: 9 }, () => ({ kind: 'text', value: 'y' })) })).toContain('at most 8');
    expect(qualityBarBrief({ target: 'AAA', references: [{ kind: 'url', value: 'https://e.com', note: 'ref' }] })).toMatchObject({ target: 'AAA', references: ['https://e.com (ref)'] });
    expect(qualityBarBrief(undefined)).toBeNull();
  });
});

describe('critic', () => {
  const model: ModelConnection = { id: 'anthropic/claude-opus-5-5', label: 'Opus', source: 'gateway', protocol: 'anthropic' };
  const image = { id: 'a', mimeType: 'image/png' as const, data: 'AAAA', label: 'Home · desktop' };
  const context = { title: 'Fighting game', prompt: 'Build a 2D fighter', qualityBar: { target: 'AAA fighting game', references: [] }, design: { guide: '# Guide', tokens: null, truncated: [] }, round: 1, rounds: 2, passScore: 8 };

  it('parses scores, clamps them and averages the overall', () => {
    const parsed = parseCritique('Here you go:\n{"fidelity": 4, "motion": 12, "polish": "6", "ux": 5.55, "critique": "Flat  lighting.", "fixes": ["Add rim light", "", 7]}')!;
    expect(parsed.score).toEqual({ fidelity: 4, motion: 10, polish: 6, ux: 5.6, overall: 6.4 });
    expect(parsed.critique).toBe('Flat lighting.');
    expect(parsed.fixes).toEqual(['Add rim light']);
    expect(parseCritique('no json')).toBeNull();
  });

  it('sends images to vision models and text only to the others', () => {
    const vision = criticInput(context, 'captures', [image], true);
    expect(vision[0]).toMatchObject({ role: 'system' });
    expect(vision[1]!.content).toMatchObject([{ type: 'input_text' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }]);
    expect((vision[1]!.content as { text: string }[])[0]!.text).toContain('"designGuide":"# Guide"');
    const text = criticInput(context, 'captures', [image], false);
    expect(typeof text[1]!.content).toBe('string');
    expect(text[1]!.content).toContain('No images could be sent');
  });

  it('runs through the model adapter and reports usage', async () => {
    const run = vi.fn(async () => ({ type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"fidelity":7,"motion":6,"polish":8,"ux":7,"critique":"Good.","fixes":["Tighten spacing"]}' }], usage: { input_tokens: 10, output_tokens: 5 } }));
    const usage = vi.fn();
    const result = await critique({ AI: { run, gateway: () => ({ run }) }, AI_GATEWAY_ID: 'g' } as never, model, context, 'captures', [image], usage);
    expect(result.score.overall).toBe(7);
    expect(result.fixes).toEqual(['Tighten spacing']);
    expect(usage).toHaveBeenCalledWith({ inputTokens: 10, outputTokens: 5 });
    const request = (run.mock.calls[0] as unknown[])[1] as { messages: { content: { type: string }[] }[] };
    expect(request.messages[0]!.content.map((part) => part.type)).toEqual(['text', 'image']);
  });

  it('prefers the strongest model that accepts images', () => {
    const models: ModelConnection[] = [{ id: 'openai/gpt-6.1-sol', label: 'Sol', source: 'gateway', protocol: 'responses' }, { id: 'anthropic/claude-opus-5-5', label: 'Opus', source: 'gateway', protocol: 'anthropic' }, { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama', source: 'workers-ai', protocol: 'workers-ai' }];
    expect(strongestModel(models, modelStrength)!.id).toBe('anthropic/claude-opus-5-5');
    expect(strongestModel([models[2]!], modelStrength)!.id).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  });

  it('turns rounds into the builder instruction and the design review comment', () => {
    const round: VisualRound = { round: 1, score: { fidelity: 4, motion: 5, polish: 6, ux: 5, overall: 5 }, critique: 'Flat lighting.', fixes: ['Add rim light', 'Animate the idle stance'], captureIds: ['q1'], model: 'anthropic/claude-opus-5-5', at: new Date().toISOString() };
    const instruction = roundInstruction(round, 8, 2);
    expect(instruction).toContain('Quality round 1 of 2');
    expect(instruction).toContain('scored your current result 5/10');
    expect(instruction).toContain('1. Add rim light 2. Animate the idle stance');
    const body = designReviewBody([round, { ...round, round: 2, score: { ...round.score, overall: 7.5 }, fixes: [] }], 8, { target: 'AAA fighting game', references: [] });
    expect(body).toContain('**Design review, not an approval.** Score 7.5/10 (5 → 7.5 over 2 rounds); the bar is 8 for "AAA fighting game".');
    expect(body).not.toContain('Still to fix');
    expect(designReviewBody([], 8, undefined)).toContain('No screenshots were available');
  });
});

describe('quality bar on missions and in planning', () => {
  it('validates the quality bar on creation and drafts', () => {
    const input = missionInput({ title: 'Fighter', prompt: 'Build a 2D fighting game with a bot opponent.', repositoryId: 'repo', qualityBar: { target: ' AAA fighting game ', references: [{ kind: 'url', value: 'https://example.com/ref.png' }] } });
    expect(input.qualityBar).toEqual({ target: 'AAA fighting game', references: [{ kind: 'url', value: 'https://example.com/ref.png' }] });
    expect(() => missionInput({ title: 'x', prompt: 'Build a 2D fighting game.', repositoryId: 'repo', qualityBar: { target: '' } })).toThrow('INVALID_QUALITY_BAR');
    expect(draftRequest({ goal: 'Build a 2D fighting game with a bot opponent.', qualityBar: { target: 'AAA' } }).qualityBar).toEqual({ target: 'AAA', references: [] });
    const snapshot = { commitSha: 'a'.repeat(40), files: ['src/App.tsx', DESIGN_GUIDE_PATH], readme: null, packageJson: null, designGuide: '# Guide\nUse orange.' };
    const draft = draftInput({ goal: 'Build a 2D fighting game with a bot opponent.', mode: 'combine', agents: 1, qualityBar: { target: 'AAA', references: [] } }, snapshot);
    expect(draft[0]!.content).toContain(QUALITY_BAR_RULE);
    expect(draft[0]!.content).toContain('design guide');
    expect(JSON.parse(draft[1]!.content as string)).toMatchObject({ qualityBar: { target: 'AAA' }, designGuide: '# Guide\nUse orange.' });
    const auto = autoDraftInput({ goal: 'Build a 2D fighting game with a bot opponent.', maxAgents: 3, allowedModels: [{ id: 'anthropic/claude-opus-5-5', label: 'Opus', source: 'gateway', protocol: 'anthropic' }], qualityBar: { target: 'AAA', references: [] } }, snapshot);
    expect(auto[0]!.content).toContain('use the strongest allowed model');
    expect(autoDraftInput({ goal: 'Build a 2D fighting game with a bot opponent.', maxAgents: 3, allowedModels: [] }, { ...snapshot, designGuide: null })[0]!.content).not.toContain(QUALITY_BAR_RULE);
  });

  it('decides how many rounds to run', () => {
    expect(qualityRoundCount({ quality: { rounds: 0, passScore: 8 } }, undefined)).toBe(0);
    expect(qualityRoundCount({ quality: { rounds: 0, passScore: 8 } }, { target: 'AAA', references: [] })).toBe(2);
    expect(qualityRoundCount({ quality: { rounds: 3, passScore: 8 } }, undefined)).toBe(3);
    expect(qualityRoundCount({ quality: { rounds: 9, passScore: 8 } }, undefined)).toBe(4);
  });

  it('picks the candidate evidence to review and wants a review only when a guide or bar exists', () => {
    const sha = 'b'.repeat(40);
    const evidence = (id: string, runId?: string, rounds?: VisualRound[]) => ({ id, runId, candidateSha: sha, baseSha: 'a'.repeat(40), epoch: 1, mode: 'browser' as const, browser: 'c', captures: [], warnings: [], capturedAt: '', ...(rounds ? { rounds } : {}) });
    const mission = { status: 'needs_review', candidateSha: sha, baseSha: 'a'.repeat(40), epoch: 1, selectedRunId: 'two', reviews: [], visual: [evidence('q1-one', 'one', []), evidence('v1-one', 'one'), evidence('v1-two', 'two')] } as unknown as Mission;
    expect(reviewableEvidence(mission)!.id).toBe('v1-two');
    expect(reviewableEvidence({ ...mission, visual: [...mission.visual!, evidence('v1-integration')] })!.id).toBe('v1-integration');
    expect(designReviewWanted(mission, null)).toBe(false);
    expect(designReviewWanted({ ...mission, qualityBar: { target: 'AAA', references: [] } }, null)).toBe(true);
    expect(designReviewWanted(mission, { guide: '# Guide', tokens: null, truncated: [] })).toBe(true);
    expect(designReviewWanted({ ...mission, reviews: [{ authorId: DESIGN_REVIEWER_ID, candidateSha: sha, epoch: 1 }] } as unknown as Mission, { guide: '# Guide', tokens: null, truncated: [] })).toBe(false);
    expect(reviewText(evidence('v1-two', 'two'), [{ id: 'c', side: 'candidate', route: '/', label: 'Home', viewport: 'desktop', theme: 'light', width: 1280, height: 800, format: 'png', bytes: 1, outline: 'Title: x', consoleErrors: ['boom'], overflow: 0, diff: { against: 'b', changedRatio: 0.5, regions: [] } }])).toContain('50.0% changed from the base');
  });
});

describe('iterate-until-good inside an agent run', () => {
  const sha = 'a'.repeat(40);
  const candidate = '5'.repeat(40);
  const done = (text: string) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
  const capture = JSON.stringify({ mode: 'browser', browser: 'Chromium/140', warnings: [], captures: [{ id: 'root_desktop_light', route: '/', label: 'Home', viewport: 'desktop', theme: 'light', width: 1280, height: 800, format: 'png', bytes: 3, image: 'AAAA', outline: 'Title: Fighter', consoleErrors: [], overflow: 0 }] });

  it('captures, scores, sends the critique back to the builder and records the rounds', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(done('Built the arena.'))
      .mockResolvedValueOnce(done('{"fidelity":4,"motion":4,"polish":5,"ux":5,"critique":"Flat lighting and no idle animation.","fixes":["Add rim light","Animate the idle stance"]}'))
      .mockResolvedValueOnce(done('Added rim light and idle animation.'))
      .mockResolvedValueOnce(done('{"fidelity":8,"motion":8,"polish":8,"ux":8,"critique":"Reaches the bar.","fixes":[]}'));
    const command = vi.fn(async (argv: string[]) => {
      if (argv[1] === 'rev-parse') return { exitCode: 0, stdout: candidate, stderr: '' };
      if (argv[1] === 'ls-files') return { exitCode: 0, stdout: 'src/App.tsx\n', stderr: '' };
      if (argv[1] === 'diff' && argv.includes('--name-only')) return { exitCode: 0, stdout: 'src/App.tsx', stderr: '' };
      if (argv[1] === 'diff') return { exitCode: 0, stdout: 'M\tsrc/App.tsx', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const runner = { prepare: vi.fn(), destroy: vi.fn(), command, startPreview: vi.fn(async () => 8080), stopPreview: vi.fn(async () => {}), collect: vi.fn(async () => ({ exitCode: 0, stdout: capture, stderr: '' })) };
    const artifacts = { get: async (name: string) => ({
      log: async () => [{ hash: sha, treeHash: 'root', message: '' }],
      readTree: async () => [],
      readFile: async ({ path }: { path: string }) => path === DESIGN_GUIDE_PATH ? blob('# Guide\nOrange is the brand.') : null,
      info: async () => ({ name, remote: `https://artifacts.example/${name}.git`, defaultBranch: 'main', token: 't' }),
      fork: async (fork: string) => ({ name: fork, remote: `https://artifacts.example/${fork}.git`, defaultBranch: 'main', token: 'f' }),
      revokeToken: async () => true,
      [Symbol.dispose]: () => {},
    } as unknown as ArtifactRepo) } as unknown as ArtifactsBinding;
    const stored: string[] = [];
    const env: ExecutionEnv = { MODEL: 'openai/gpt-6-luna', AI_GATEWAY_ID: 'test', AI: { run }, ARTIFACTS: artifacts, SANDBOX: { getByName: () => runner as unknown as SandboxRunner }, evidence: { putImage: async (_id, image) => { stored.push(image.id); } } };
    const mission: Mission = { repositoryId: 'repository', status: 'running', candidateSha: null, checks: [], events: [], changes: [], createdAt: '', updatedAt: '', mode: 'race', id: 'fighter', epoch: 1, title: 'Fighter', prompt: 'Build a 2D fighting game with a bot opponent.', baseSha: sha, qualityBar: { target: 'AAA fighting game', references: [{ kind: 'text', value: 'Tekken-like lighting' }] }, runs: [{ id: 'builder', name: 'Builder', role: 'Engineer', task: 'Build it.', status: 'queued', changedFiles: [] }] };
    const result = await executeMission({ repository: { name: 'canonical', headSha: sha } as Repository, mission, testCommand: 'node --test' }, env);
    const requests = run.mock.calls.map(([, request]) => request as { input: Record<string, unknown>[] });
    const brief = JSON.parse(requests[0]!.input[1]!.content as string);
    expect(brief.designGuide.guide).toBe('# Guide\nOrange is the brand.');
    expect(brief.qualityBar.target).toBe('AAA fighting game');
    expect((requests[1]!.input[1]!.content as { type: string }[]).map((part) => part.type)).toEqual(['input_text', 'input_image']);
    const second = JSON.parse(requests[2]!.input[1]!.content as string);
    expect(second.qualityRound.instruction).toContain('scored your current result 4.5/10');
    expect(second.qualityRound.fixes).toEqual(['Add rim light', 'Animate the idle stance']);
    expect(runner.startPreview).toHaveBeenCalledTimes(2);
    expect(stored).toEqual(['q1-builder-r1.candidate.root_desktop_light', 'q1-builder-r2.candidate.root_desktop_light']);
    const quality = result.visual!.find((item) => item.id === 'q1-builder')!;
    expect(quality.candidateSha).toBe(candidate);
    expect(quality.rounds!.map((round) => round.score.overall)).toEqual([4.5, 8]);
    expect(result.events!.map((event) => event.message)).toEqual(expect.arrayContaining([expect.stringContaining('quality round 1 scored 4.5/10 (bar 8); 2 fixes requested'), expect.stringContaining('quality round 2 scored 8/10')]));
  });
});
