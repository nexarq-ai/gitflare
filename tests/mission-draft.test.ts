import { describe, expect, it, vi } from 'vitest';
import { draftInput, draftMission, draftRequest, parseDraft, plannerFacts, validateDraft } from '../src/worker/mission-draft';

const request = { goal: 'Make this project deployable on Cloudflare Workers.', mode: 'combine' as const, agents: 1 };
const snapshot = { commitSha: 'a'.repeat(40), files: ['README.md', 'package.json', 'index.html'], readme: '# Site', packageJson: '{"scripts":{"build":"vite build"}}' };

describe('mission drafting', () => {
  it('validates the request', () => {
    expect(draftRequest({ goal: request.goal })).toEqual({ goal: request.goal, mode: 'combine', agents: 1 });
    expect(draftRequest({ goal: request.goal, mode: 'race', agents: 3, title: '  Ship it  ' })).toEqual({ goal: request.goal, mode: 'race', agents: 3, title: 'Ship it' });
    expect(() => draftRequest({ goal: 'short' })).toThrow();
    expect(draftRequest({ goal: request.goal, agents: 10 }).agents).toBe(10);
    expect(() => draftRequest({ goal: request.goal, agents: 11 })).toThrow('between one and 10');
  });

  it('parses a fenced JSON plan and fills exactly the requested agents', () => {
    const plan = '```json\n' + JSON.stringify({ title: 'Deploy on Workers', acceptanceCriteria: ['wrangler.jsonc exists', '', 'README explains deploy'], tasks: [{ name: 'Builder', role: 'Workers setup', task: 'Add wrangler.jsonc with assets.directory set to dist and document deployment.' }, { name: 'Extra', role: 'x', task: 'ignored' }] }) + '\n```';
    expect(parseDraft(plan, request)).toEqual({ title: 'Deploy on Workers', acceptanceCriteria: ['wrangler.jsonc exists', 'README explains deploy'], tasks: [{ name: 'Builder', role: 'Workers setup', task: 'Add wrangler.jsonc with assets.directory set to dist and document deployment.' }] });
  });

  it('fills gaps with safe defaults and keeps names distinct', () => {
    const draft = parseDraft(JSON.stringify({ tasks: [{ name: 'Same', task: 'Do the first part of the work.' }, { name: 'same', task: 'x' }] }), { ...request, agents: 3 });
    expect(draft.title).toBe(request.goal.slice(0, 80));
    expect(new Set(draft.tasks.map((task) => task.name.toLowerCase())).size).toBe(3);
    expect(draft.tasks[1].task).toContain('part 2 of the goal');
    expect(draft.tasks[2].name).toBe('Agent 3');
  });

  it('rejects output that is not a plan', () => {
    expect(() => parseDraft('I cannot help with that.', request)).toThrow('did not return a usable plan');
  });

  it('marks repository content as untrusted and asks for one whole-mission assignment', () => {
    const [system, user] = draftInput(request, snapshot);
    expect(system.content).toContain('untrusted data');
    expect(system.content).toContain('exactly 1 assignment that covers the WHOLE goal');
    expect(JSON.parse(user.content as string).repository.files).toEqual(snapshot.files);
  });

  it('feeds the planner the runtime policy of this repository', () => {
    const [starter] = draftInput({ ...request, agents: 2 }, { commitSha: 'a'.repeat(40), files: ['README.md', '.gitignore'], readme: '# Chat', packageJson: null });
    expect(starter.content).toContain('This is a starter repository');
    expect(starter.content).toContain('they may create a new package.json');
    expect(starter.content).toContain('Never tell an agent to create gitflare.json');
    expect(starter.content).toContain('recommend race mode or a single scaffold agent first followed by a separate combine mission');
    expect(starter.content).toContain('never assign the same file to two agents');
    expect(starter.content).toContain('"wrangler": "4.149.0"');
    const [tested] = draftInput(request, { commitSha: 'a'.repeat(40), files: ['package.json', 'src/a.mjs', 'tests/a.test.mjs'], readme: null, packageJson: '{"scripts":{"test":"node --test"}}' });
    expect(tested.content).toContain('Agents may modify existing files only under src/, docs/, public/, static/, assets/, README.md');
    expect(tested.content).toContain('They may change only the dependency sections of the existing package.json');
    expect(tested.content).not.toContain('This is a starter repository');
    const [configured] = draftInput(request, { commitSha: 'a'.repeat(40), files: ['gitflare.json', 'lib/a.mjs', 'tests/a.test.mjs'], readme: null, packageJson: null, policyFile: '{"editable":["lib/"]}' });
    expect(configured.content).toContain('only under lib/');
    expect(configured.content).toContain('agents may not create one');
  });

  it('warns about drafts that write protected files, contradict the starter rules or share a file', () => {
    const starter = plannerFacts({ commitSha: 'a'.repeat(40), files: ['README.md'], readme: null, packageJson: null });
    const tasks = [
      { name: 'Scaffold', role: 'Setup', task: 'Add gitflare.json with minimal metadata. Add .github/workflows/ci.yml. Do not create package.json.' },
      { name: 'Limiter', role: 'Limits', task: 'Edit src/chat-room.ts to add a limiter. Add tests in tests/limiter.test.mjs.' },
      { name: 'Stats', role: 'Stats', task: 'Edit src/chat-room.ts to count messages. Never touch gitflare.json.' },
    ];
    const warnings = validateDraft({ title: 'Chat', acceptanceCriteria: [], tasks }, { goal: 'Build a chat Worker with stats and limits.', mode: 'combine', agents: 3 }, starter);
    expect(warnings).toContain('Scaffold is asked to write .github/, which agents cannot change here; edit that assignment before starting.');
    expect(warnings).toContain('Scaffold is asked to create gitflare.json. Gitflare does not need it, and an Owner must review it before it lands; remove it unless you need custom checks.');
    expect(warnings).toContain('Scaffold is told not to create package.json, but this starter repository allows one new package.json.');
    expect(warnings).toContain('Limiter and Stats are both assigned src/chat-room.ts. Their edits will collide when the candidates are combined; give src/chat-room.ts to one agent.');
    expect(warnings.some((warning) => warning.includes('Stats is asked'))).toBe(false);
    expect(warnings.some((warning) => warning.includes('scaffold agent first'))).toBe(true);
  });

  it('returns the warnings with the drafted plan', async () => {
    const plan = { title: 'Chat', acceptanceCriteria: ['Works'], tasks: [{ name: 'Builder', role: 'All', task: 'Add gitflare.json and src/index.ts with tests.' }] };
    const run = vi.fn(async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(plan) }] }] }));
    const draft = await draftMission({ AI: { run }, AI_GATEWAY_ID: 'gitflare' }, { id: 'openai/gpt-6-luna', protocol: 'responses', source: 'gateway' } as never, { goal: 'Create gitflare.json and a Worker.', mode: 'race', agents: 1 }, { commitSha: 'a'.repeat(40), files: ['package.json', 'tests/a.test.mjs'], readme: null, packageJson: '{}' });
    expect(draft.warnings).toEqual([
      'gitflare.json is protected: agents cannot create it. Edit it yourself and push, or configure checks in repository settings.',
      'Builder is asked to write gitflare.json, which agents cannot change here; edit that assignment before starting.',
    ]);
  });

  it('makes one bounded model call without tools', async () => {
    const run = vi.fn(async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ title: 'T', acceptanceCriteria: ['A'], tasks: [{ name: 'N', role: 'R', task: 'Do the whole thing carefully.' }] }) }] }] }));
    const draft = await draftMission({ AI: { run }, AI_GATEWAY_ID: 'gitflare' }, { id: 'openai/gpt-6-luna', protocol: 'responses', source: 'gateway' } as never, request, snapshot);
    expect(draft.tasks[0].name).toBe('N');
    expect(run).toHaveBeenCalledTimes(1);
    const [model, parameters, options] = run.mock.calls[0] as unknown as [string, Record<string, unknown>, { gateway: { id: string } }];
    expect(model).toBe('openai/gpt-6-luna');
    expect(parameters.tools).toBeUndefined();
    expect(options.gateway.id).toBe('gitflare');
  });
});

describe('gateway rejection message', () => {
  it('explains a provider rejection without echoing credentials', async () => {
    const { gatewayRejection } = await import('../src/worker/model-adapter');
    const json = new Response(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'Your API key sk-ant-abcdef123456 does not have access to this model' } }), { status: 403 });
    const message = await gatewayRejection(json, 'anthropic/claude-sonnet-5-5');
    expect(message).toContain('AI Gateway rejected anthropic/claude-sonnet-5-5 with status 403: Your API key sk-[redacted] does not have access');
    expect(message).toContain('choose another model');
    expect(message).not.toContain('abcdef123456');
    expect(await gatewayRejection(new Response('upstream unavailable', { status: 502 }), 'm')).toBe('AI Gateway rejected m with status 502: upstream unavailable.');
  });
});
