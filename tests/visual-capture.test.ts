import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { captureId, decodePng, diffImages, encodePng, htmlOutline, keyDescriptor, outlineOnly, outlineText } from '../runner/visual/visual-capture.mjs';
import { captureCommand, captureRequestFor, parseCaptureOutput, runCapture, startVisualPreview, toEvidence, VISUAL_SCRIPT, VisualCaptureError, type CaptureOutput } from '../src/worker/visual/capture';
import { effectiveVisualConfig } from '../src/worker/visual/config';
import type { SandboxRunner } from '../src/worker/execution/environment';

function image(width: number, height: number, paint: (x: number, y: number) => [number, number, number]) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const at = (y * width + x) * 4; const [r, g, b] = paint(x, y); pixels[at] = r; pixels[at + 1] = g; pixels[at + 2] = b; pixels[at + 3] = 255; }
  return { width, height, pixels };
}

describe('capture script primitives', () => {
  it('round-trips PNG encoding and decoding', () => {
    const source = image(40, 24, (x, y) => [x * 6, y * 10, (x + y) % 256]);
    const decoded = decodePng(encodePng(source));
    expect(decoded.width).toBe(40);
    expect(decoded.height).toBe(24);
    expect(Buffer.from(decoded.pixels).equals(Buffer.from(source.pixels))).toBe(true);
  });

  it('measures changed pixels and boxes the changed regions', () => {
    const base = image(128, 64, () => [250, 250, 250]);
    const candidate = image(128, 64, (x, y) => x >= 20 && x < 40 && y >= 10 && y < 30 ? [20, 20, 20] : x >= 100 && y >= 50 ? [244, 129, 32] : [250, 250, 250]);
    const diff = diffImages(base, candidate);
    expect(diff.changedRatio).toBeCloseTo((20 * 20 + 28 * 14) / (128 * 64), 4);
    expect(diff.regions).toEqual([{ x: 16, y: 0, width: 32, height: 32 }, { x: 96, y: 48, width: 32, height: 16 }]);
    const painted = decodePng(diff.image!);
    expect(Array.from(painted.pixels.subarray((15 * 128 + 25) * 4, (15 * 128 + 25) * 4 + 3))).toEqual([255, 45, 138]);
    expect(diffImages(base, image(64, 64, () => [0, 0, 0]))).toMatchObject({ changedRatio: 1, regions: [{ x: 0, y: 0, width: 64, height: 64 }], image: null });
  });

  it('maps key names to DevTools key events', () => {
    expect(keyDescriptor('ArrowLeft')).toEqual({ key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    expect(keyDescriptor('KeyX')).toEqual({ key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88 });
    expect(keyDescriptor('Space')).toEqual({ key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    expect(keyDescriptor('a')).toEqual({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    expect(keyDescriptor('ShiftLeft')).toEqual({ key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
  });

  it('names captures by route, viewport, theme and frame', () => {
    expect(captureId('/', 'desktop', 'light')).toBe('root_desktop_light');
    expect(captureId('/play?level=2', 'mobile', 'dark', 'after punch')).toBe('play-level-2_mobile_dark_after-punch');
  });

  it('outlines served HTML without a browser', () => {
    const outline = htmlOutline('<html><head><title>Arena</title><script>x()</script></head><body><header><nav><a href="/x">Play</a></nav></header><main><h1>Fight</h1><h2>Round 1</h2><button>Start</button><img src="a.png"><canvas></canvas></main></body></html>');
    expect(outline).toMatchObject({ title: 'Arena', landmarks: { header: 1, nav: 1, main: 1 }, headings: ['h1 Fight', 'h2 Round 1'], controls: { buttons: 1, links: 1 }, images: { total: 1, missingAlt: 1 }, canvas: 1, scripts: 1 });
    const text = outlineText({ ...outline, overflow: 12, viewportMeta: false }, { width: 390, height: 844 });
    expect(text).toContain('Title: Arena');
    expect(text).toContain('Horizontal overflow: 12px beyond the 390px viewport');
    expect(text).toContain('No <meta name="viewport">');
  });
});

describe('outline mode against a live server', () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/missing') { response.writeHead(404).end('nope'); return; }
      response.writeHead(200, { 'content-type': 'text/html' }).end('<title>Demo</title><main><h1>Hello</h1><button>Go</button></main>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());

  it('reports the outline of every route and viewport with no images', async () => {
    const result = await outlineOnly({ baseUrl: `http://127.0.0.1:${port}`, routes: [{ path: '/', label: 'Home' }, { path: '/missing' }], viewports: ['desktop', 'mobile'], themes: ['light'], navigationTimeoutMs: 5000 }, 'No Chromium');
    expect(result.mode).toBe('outline');
    expect(result.warnings).toEqual(['No Chromium']);
    expect(result.captures).toHaveLength(4);
    expect(result.captures[0]).toMatchObject({ id: 'root_desktop_light', label: 'Home', image: null, overflow: -1, width: 1280 });
    expect(result.captures[0].outline).toContain('HTTP 200');
    expect(result.captures[0].outline).toContain('Headings: h1 Hello');
    expect(result.captures[2].outline).toContain('HTTP 404');
  });
});

describe('capture invocation from the Worker', () => {
  const output: CaptureOutput = { mode: 'browser', browser: 'Chromium/140', captures: [{ id: 'root_desktop_light', route: '/', label: 'Home', viewport: 'desktop', theme: 'light', width: 1280, height: 800, format: 'png', bytes: 3, image: 'AAAA', outline: 'Title: x', consoleErrors: ['console.error boom'], overflow: 0, diff: { against: 'root_desktop_light', changedRatio: 0.0127, regions: [{ x: 0, y: 0, width: 16, height: 16 }], image: 'BBBB' } }], warnings: [] };

  it('installs the script, writes the config and parses the JSON result', async () => {
    const command = vi.fn(async () => ({ exitCode: 0, stdout: `Installing\n${JSON.stringify(output)}`, stderr: '' }));
    const sandbox: SandboxRunner = { prepare: vi.fn(), destroy: vi.fn(), command, collect: command };
    const request = captureRequestFor(effectiveVisualConfig(null, { checks: { axe: true } }), '/tmp/gitflare-visual/candidate', { compareDir: '/tmp/gitflare-visual/base', port: 8787 });
    const result = await runCapture(sandbox, request, 60_000);
    expect(result.captures[0]!.id).toBe('root_desktop_light');
    const script = (command.mock.calls[0] as unknown[])[0] as string;
    expect(script).toContain(`cat > ${VISUAL_SCRIPT} <<'GITFLARE_VISUAL_EOF'`);
    expect(script).toContain('export async function capture(');
    expect(script).toContain('"baseUrl":"http://localhost:8787"');
    expect(script).toContain('"compareDir":"/tmp/gitflare-visual/base"');
    expect(script).toContain('"axe":"/workspace/repo/node_modules/axe-core/axe.min.js"');
    expect(script.trimEnd().endsWith(`exec node ${VISUAL_SCRIPT} /tmp/gitflare-visual/candidate.json`)).toBe(true);
    expect(captureCommand(request)).not.toMatch(/\nGITFLARE_VISUAL_EOF\n[^\n]*GITFLARE_VISUAL_EOF\n[^m]/);
  });

  it('fails closed on a non-zero exit or an unreadable result', async () => {
    const failing: SandboxRunner = { prepare: vi.fn(), destroy: vi.fn(), command: vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'node: not found' })) };
    await expect(runCapture(failing, captureRequestFor(effectiveVisualConfig(null, null), '/tmp/x'), 1000)).rejects.toThrow('Capture failed (exit 1): node: not found');
    expect(() => parseCaptureOutput('no json here')).toThrow(VisualCaptureError);
    expect(() => parseCaptureOutput('{"mode":"weird"}')).toThrow('unexpected result');
  });

  it('turns the script output into mission evidence and separate images', () => {
    const { evidence, images } = toEvidence(output, { id: 'ev1', side: 'candidate', candidateSha: 'b'.repeat(40), baseSha: 'a'.repeat(40), epoch: 1, runId: 'run-1' });
    expect(evidence).toMatchObject({ id: 'ev1', runId: 'run-1', mode: 'browser', browser: 'Chromium/140', captures: [{ id: 'ev1.candidate.root_desktop_light', side: 'candidate', route: '/', viewport: 'desktop', theme: 'light', consoleErrors: ['console.error boom'], diff: { against: 'ev1.base.root_desktop_light', changedRatio: 0.0127, imageId: 'ev1.candidate.root_desktop_light.diff' } }] });
    expect(images).toEqual([{ id: 'ev1.candidate.root_desktop_light', format: 'png', data: 'AAAA' }, { id: 'ev1.candidate.root_desktop_light.diff', format: 'png', data: 'BBBB' }]);
    expect(JSON.stringify(evidence)).not.toContain('AAAA');
  });

  it('starts the preview from the plan and uses the port the runner reports', async () => {
    const startPreview = vi.fn(async () => 8787);
    const sandbox: SandboxRunner = { prepare: vi.fn(), destroy: vi.fn(), command: vi.fn(), startPreview };
    const preview = await startVisualPreview(sandbox, { previewCommand: 'node src/preview.mjs', install: null }, ['package.json', 'src/index.html'], JSON.stringify({ scripts: { dev: 'vite' } }), null, 60_000);
    expect(preview.port).toBe(8787);
    expect(preview.plan.description).toBe('npm run dev');
    expect(startPreview).toHaveBeenCalledWith(preview.plan.argv, 60_000);
    const legacy: SandboxRunner = { prepare: vi.fn(), destroy: vi.fn(), command: vi.fn(), startPreview: vi.fn(async () => {}) };
    expect((await startVisualPreview(legacy, undefined, ['index.html'], null, null, 60_000)).port).toBe(8080);
    await expect(startVisualPreview({ prepare: vi.fn(), destroy: vi.fn(), command: vi.fn() }, undefined, [], null, null, 1000)).rejects.toThrow('cannot start a preview');
  });
});

describe('capture script on disk', () => {
  it('keeps the heredoc terminator out of the script body', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gitflare-visual-'));
    try {
      const command = captureCommand({ routes: [{ path: '/' }], viewports: ['desktop'], themes: ['light'], outDir: path.join(dir, 'out') });
      const body = command.split("<<'GITFLARE_VISUAL_EOF'\n")[1]!.split('\nGITFLARE_VISUAL_EOF\n')[0]!;
      expect(body.includes('GITFLARE_VISUAL_EOF')).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
