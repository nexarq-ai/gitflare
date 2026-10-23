import { describe, expect, it, vi } from 'vitest';
import { AgentViewer, requestedConfig, viewOutput, viewRequest } from '../src/worker/visual/agent-view';
import { effectiveVisualConfig } from '../src/worker/visual/config';
import type { CaptureOutput } from '../src/worker/visual/capture';
import type { SandboxRunner } from '../src/worker/execution/environment';
import { runAgentLoop, agentLoopPrompt, type ExecutionEnv } from '../src/worker/execution';
import { imageItem, modelAcceptsImages, pruneImages } from '../src/worker/execution/agent-loop';
import { anthropicInput } from '../src/worker/anthropic-adapter';
import { chatMessages, workersAIMessages } from '../src/worker/model-adapter';

const output: CaptureOutput = { mode: 'browser', browser: 'Chromium/140', warnings: [], captures: [
  { id: 'root_desktop_light', route: '/', label: 'Home', viewport: 'desktop', theme: 'light', width: 1280, height: 800, format: 'png', bytes: 3, image: 'AAAA', outline: 'Title: Demo', consoleErrors: ['console.error boom'], overflow: 0 },
  { id: 'root_mobile_light', route: '/', label: 'Home', viewport: 'mobile', theme: 'light', width: 390, height: 844, format: 'jpeg', bytes: 3, image: 'BBBB', outline: 'Title: Demo', consoleErrors: [], overflow: 120 },
] };

describe('view_ui requests', () => {
  it('validates the tool input', () => {
    expect(viewRequest('{"routes":["/","/play"],"viewports":["mobile"],"themes":null,"restart":true}')).toEqual({ routes: ['/', '/play'], viewports: ['mobile'], restart: true });
    expect(viewRequest('{}')).toEqual({});
    expect(viewRequest('nope')).toContain('provide a JSON object');
    expect(viewRequest('{"routes":["play"]}')).toContain('absolute paths');
    expect(viewRequest('{"viewports":["tablet"]}')).toContain('viewports must list');
    expect(viewRequest('{"wait":1}')).toContain('"wait" is not a parameter');
  });

  it('reuses configured interaction steps for a requested route and caps the images', () => {
    const config = effectiveVisualConfig({ routes: [{ path: '/play', label: 'Fight', steps: [{ click: '#start' }, { capture: 'started' }] }, { path: '/' }] }, null);
    const requested = requestedConfig(config, { routes: ['/play', '/about'], themes: ['dark'] });
    expect(requested.routes).toEqual([{ path: '/play', label: 'Fight', steps: [{ click: '#start' }, { capture: 'started' }] }, { path: '/about' }]);
    expect(requested.themes).toEqual(['dark']);
    expect(requested.viewports).toEqual(['desktop', 'mobile']);
    const many = requestedConfig(config, { routes: ['/a', '/b', '/c', '/d', '/e', '/f'] });
    expect(many.routes.length * many.viewports.length * many.themes.length).toBeLessThanOrEqual(8);
  });

  it('describes every capture and attaches the images in order', () => {
    const result = viewOutput(output, { description: 'npm run dev', port: 8080 }, 1);
    expect(result.text).toContain('Preview: npm run dev on port 8080.');
    expect(result.text).toContain('## 1. Home (/) · desktop 1280×800 · light [image 1]');
    expect(result.text).toContain('Console errors (1): console.error boom');
    expect(result.text).toContain('## 2. Home (/) · mobile 390×844 · light [image omitted: limit reached]');
    expect(result.text).toContain('Layout overflow: the page is 120px wider than the 390px viewport.');
    expect(result.images).toEqual([{ id: 'root_desktop_light', mimeType: 'image/png', data: 'AAAA', label: 'Home (/) · desktop 1280×800 · light' }]);
    const outline = viewOutput({ ...output, mode: 'outline', browser: null, captures: output.captures.map((capture) => ({ ...capture, image: null })) }, null);
    expect(outline.text).toContain('No browser is available');
    expect(outline.images).toEqual([]);
  });
});

describe('AgentViewer', () => {
  function sandbox(stdout: string) {
    const startPreview = vi.fn(async () => 8080);
    const stopPreview = vi.fn(async () => {});
    const command = vi.fn(async (argv: string[]) => {
      if (argv[1] === 'ls-files') return { exitCode: 0, stdout: 'package.json\nsrc/index.html\n', stderr: '' };
      if (argv[0] === 'cat') return { exitCode: 0, stdout: '{"scripts":{"dev":"vite"}}', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const collect = vi.fn(async () => ({ exitCode: 0, stdout, stderr: '' }));
    return { runner: { prepare: vi.fn(), destroy: vi.fn(), command, collect, startPreview, stopPreview } as SandboxRunner & { startPreview: typeof startPreview; stopPreview: typeof stopPreview; collect: typeof collect }, startPreview, stopPreview, collect };
  }

  it('starts the preview once, restarts on request and stops on close', async () => {
    const { runner, startPreview, stopPreview, collect } = sandbox(JSON.stringify(output));
    const viewer = new AgentViewer(runner, { previewCommand: 'node src/preview.mjs', install: null }, effectiveVisualConfig(null, null));
    const first = await viewer.view('{}', 500_000);
    expect(first.images).toHaveLength(2);
    expect(first.text).toContain('Preview: npm run dev on port 8080.');
    expect(startPreview).toHaveBeenCalledTimes(1);
    await viewer.view('{"routes":["/"]}', 500_000);
    expect(startPreview).toHaveBeenCalledTimes(1);
    await viewer.view('{"restart":true}', 500_000);
    expect(stopPreview).toHaveBeenCalledTimes(1);
    expect(startPreview).toHaveBeenCalledTimes(2);
    expect(collect).toHaveBeenCalledTimes(3);
    expect((collect.mock.calls[0] as unknown[])[0]).toContain('/tmp/gitflare-visual/view-1');
    await viewer.close();
    expect(stopPreview).toHaveBeenCalledTimes(2);
  });

  it('explains a preview that does not start and refuses with too little time', async () => {
    const { runner } = sandbox('');
    runner.startPreview = vi.fn(async () => { throw new Error('Preview did not answer HTTP on port 8080 within 15 seconds'); });
    const viewer = new AgentViewer(runner, { previewCommand: 'node src/preview.mjs', install: null }, effectiveVisualConfig(null, null));
    const failed = await viewer.view('{}', 500_000);
    expect(failed.text).toContain('The preview could not start');
    expect(failed.text).toContain('did not answer HTTP on port 8080');
    expect(failed.images).toEqual([]);
    expect((await viewer.view('{}', 10_000)).text).toContain('Not enough agent time left');
  });
});

describe('images in the model conversation', () => {
  const image = { id: 'a', mimeType: 'image/png' as const, data: 'AAAA', label: 'Home · desktop' };

  it('builds a user message with text and image parts and prunes older ones', () => {
    const item = imageItem('call_1', [image]);
    expect(item).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'Screenshots from view_ui call call_1 (1 image). Image 1: Home · desktop' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' }] });
    const older = imageItem('call_0', [image]);
    const messages = [{ role: 'system', content: 'rules' }, older, { type: 'function_call_output', call_id: 'x', output: 'ok' }, item];
    pruneImages(messages);
    expect(messages[1]).toEqual({ role: 'user', content: 'Screenshots from view_ui call call_0 were removed to save context; call view_ui again to see the current state.' });
    expect(messages[3]).toBe(item);
  });

  it('is offered only to models that accept images', () => {
    expect(modelAcceptsImages({ id: 'anthropic/claude-sonnet-5-5', protocol: 'anthropic' })).toBe(true);
    expect(modelAcceptsImages({ id: 'openai/gpt-6-luna', protocol: 'responses' })).toBe(true);
    expect(modelAcceptsImages({ id: 'groq/llama', protocol: 'chat' })).toBe(false);
    expect(modelAcceptsImages({ id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', protocol: 'workers-ai' })).toBe(false);
  });

  it('converts image parts for Anthropic, chat and Workers AI transports', () => {
    const item = imageItem('call_1', [image]);
    const anthropic = anthropicInput([{ type: 'function_call_output', call_id: 'call_1', output: 'text' }, item], [], 64);
    expect(anthropic.messages).toEqual([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'text' }, { type: 'text', text: 'Screenshots from view_ui call call_1 (1 image). Image 1: Home · desktop' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }]);
    expect(chatMessages([item])).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Screenshots from view_ui call call_1 (1 image). Image 1: Home · desktop' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }]);
    expect(workersAIMessages([item])).toEqual([{ role: 'user', content: 'Screenshots from view_ui call call_1 (1 image). Image 1: Home · desktop' }]);
  });
});

describe('view_ui in the agent loop', () => {
  const done = (text: string) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
  const call = (name: string, args: Record<string, unknown> = {}) => ({ status: 'completed', output: [{ type: 'function_call', call_id: `${name}-1`, name, arguments: JSON.stringify(args) }] });

  it('offers view_ui with the workspace tools and sends the screenshots to a vision model', async () => {
    const run = vi.fn().mockResolvedValueOnce(call('view_ui', { routes: ['/'], viewports: null, themes: null, restart: null })).mockResolvedValueOnce(done('Looked at the page; the header overlaps the hero.'));
    const env: ExecutionEnv = { MODEL: 'openai/gpt-6-luna', AI_GATEWAY_ID: 'test', AI: { run } };
    const view = vi.fn(async () => ({ text: 'Captured with Chromium.', images: [{ id: 'a', mimeType: 'image/png' as const, data: 'AAAA', label: 'Home' }] }));
    const summary = await runAgentLoop(env, { prepare: vi.fn(), destroy: vi.fn(), command: vi.fn() } as unknown as SandboxRunner, 'task', async () => true, async () => {}, undefined, { workspace: { install: vi.fn(), test: vi.fn(), view } });
    expect(summary).toBe('Looked at the page; the header overlaps the hero.');
    expect(view).toHaveBeenCalledWith('{"routes":["/"],"viewports":null,"themes":null,"restart":null}', expect.any(Number));
    const requests = run.mock.calls.map(([, request]) => request as { tools: { name: string }[]; input: Record<string, unknown>[] });
    expect(requests[0]!.tools.map((tool) => tool.name)).toEqual(['shell', 'install_dependencies', 'run_tests', 'view_ui']);
    const outputs = requests[1]!.input.filter((item) => item.type === 'function_call_output');
    expect(outputs[0]!.output).toBe('Captured with Chromium.');
    const images = requests[1]!.input.find((item) => Array.isArray(item.content));
    expect(images).toMatchObject({ role: 'user', content: [{ type: 'input_text' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] });
    expect(agentLoopPrompt({ workspace: { install: vi.fn(), test: vi.fn(), view } })).toContain('view_ui');
    expect(agentLoopPrompt({ workspace: { install: vi.fn(), test: vi.fn() } })).not.toContain('view_ui');
  });
});
