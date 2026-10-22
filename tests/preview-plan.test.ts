import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectListeningPort, LEGACY_PREVIEW, previewPlan, STATIC_SERVER, wranglerDevCommand } from '../src/worker/preview-plan';
import { candidateWorkerTarget, containerFallbackNote } from '../src/worker/preview-host';
import type { InstallPlan } from '../src/worker/package-manager';

const npmCi: InstallPlan = { installer: 'npm', lockfile: 'package-lock.json', pinned: null, fallbackRange: null };

describe('preview plan', () => {
  it('keeps the fixture and configured commands', () => {
    expect(previewPlan(['src/preview.mjs', 'README.md'], null)).toMatchObject({ argv: ['node', 'src/preview.mjs'], install: null });
    expect(previewPlan(['README.md'], null, { command: 'node server.js', install: npmCi })).toMatchObject({ argv: ['/bin/bash', '-lc', 'exec node server.js'], install: npmCi });
    expect(previewPlan(['README.md'], null, { command: LEGACY_PREVIEW }).description).toBe('the repository files as a static site');
  });

  it('uses package scripts when the repository defines them', () => {
    const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });
    expect(previewPlan(['package.json', 'package-lock.json'], pkg({ start: 'node server.js', dev: 'vite' }))).toMatchObject({ argv: ['/bin/bash', '-lc', 'exec npm start'], install: npmCi });
    expect(previewPlan(['package.json'], JSON.stringify({ scripts: { build: 'astro build', preview: 'astro preview' }, dependencies: { astro: '^5.0.0' } }))).toMatchObject({ install: { installer: 'npm', lockfile: null }, description: 'npm run build, then npm run preview' });
    expect(previewPlan(['package.json'], pkg({ start: 'node server.js' })).install).toBeNull();
    expect(previewPlan(['package.json'], pkg({ dev: 'astro dev' })).argv.at(-1)).toBe('exec npm run dev -- --host 0.0.0.0 --port 8080');
    expect(previewPlan(['package.json', 'index.html'], '{broken').description).toBe('the repository files as a static site');
  });

  it('runs scripts with the detected package manager', () => {
    const workspace = JSON.stringify({ packageManager: 'pnpm@9.15.0', scripts: { build: 'vite build', preview: 'vite preview', dev: 'vite' } });
    const pnpm = previewPlan(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'], workspace, {}, "lockfileVersion: '9.0'\n");
    expect(pnpm).toMatchObject({ argv: ['/bin/bash', '-lc', 'pnpm run build && exec pnpm run preview --host 0.0.0.0 --port 8080'], description: 'pnpm run build, then pnpm run preview', install: { installer: 'pnpm', lockfile: 'pnpm-lock.yaml', pinned: 'pnpm@9.15.0' } });
    expect(previewPlan(['package.json', 'pnpm-lock.yaml'], JSON.stringify({ scripts: { dev: 'vite' } })).argv.at(-1)).toBe('exec pnpm run dev --host 0.0.0.0 --port 8080');
    expect(previewPlan(['package.json', 'yarn.lock'], JSON.stringify({ scripts: { start: 'node server.js' } })).argv.at(-1)).toBe('exec yarn start');
  });

  it('runs wrangler dev on 0.0.0.0 and the preview port for Wrangler projects', () => {
    const game = JSON.stringify({ scripts: { dev: 'wrangler dev', deploy: 'wrangler deploy' }, devDependencies: { wrangler: '^4.40.0' } });
    const plan = previewPlan(['wrangler.jsonc', 'package.json', 'package-lock.json', 'src/index.ts'], game);
    expect(plan).toMatchObject({ argv: ['/bin/bash', '-lc', 'exec npx --no-install wrangler dev --ip 0.0.0.0 --port 8080 --local --persist-to /tmp/gitflare-wrangler-state'], description: 'wrangler dev', readinessMs: 180_000, install: npmCi });
    const built = previewPlan(['wrangler.toml', 'package.json', 'pnpm-lock.yaml'], JSON.stringify({ scripts: { build: 'webpack' }, devDependencies: { wrangler: '4' } }), { wranglerEnvironment: 'staging' });
    expect(built.argv.at(-1)).toBe('pnpm run build && exec pnpm exec wrangler dev --ip 0.0.0.0 --port 8080 --local --persist-to /tmp/gitflare-wrangler-state --env staging');
    expect(previewPlan(['wrangler.jsonc', 'package.json'], JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { wrangler: '4', '@cloudflare/vite-plugin': '1' } })).argv.at(-1)).toBe('exec npm run dev -- --host 0.0.0.0 --port 8080');
    expect(previewPlan(['wrangler.jsonc', 'package.json'], JSON.stringify({ scripts: { dev: 'node server.js' } })).description).toBe('npm run dev');
    expect(wranglerDevCommand('yarn', { configPath: 'apps/web/wrangler.jsonc' })).toBe('yarn wrangler dev --ip 0.0.0.0 --port 8080 --local --persist-to /tmp/gitflare-wrangler-state --config apps/web/wrangler.jsonc');
  });

  it('detects the port a dev server prints', () => {
    expect(detectListeningPort('⎔ Starting local server...\n[wrangler:info] Ready on http://localhost:8787')).toBe(8787);
    expect(detectListeningPort('  VITE v6.0.0  ready in 300 ms\n\n  ➜  Local:   http://localhost:\u001b[1m5173\u001b[22m/\n  ➜  Network: use --host to expose')).toBe(5173);
    expect(detectListeningPort('Server listening on :3000')).toBe(3000);
    expect(detectListeningPort('listening on port 4000')).toBe(4000);
    expect(detectListeningPort('Listening at 0.0.0.0:5000')).toBe(5000);
    expect(detectListeningPort('Ready on http://0.0.0.0:8080\nDebugger listening on ws://127.0.0.1:9229/abc')).toBe(8080);
    expect(detectListeningPort('compiling...')).toBeNull();
  });

  it('names the Worker from the candidate Wrangler config and explains container fallbacks', async () => {
    const files: Record<string, string> = { 'wrangler.jsonc': '{\n  // game\n  "name": "shadow-fight-web-version",\n  "main": "src/index.ts"\n}' };
    expect(await candidateWorkerTarget(async (path) => files[path] ?? null)).toEqual({ workerName: 'shadow-fight-web-version', configPath: 'wrangler.jsonc' });
    expect(await candidateWorkerTarget(async (path) => path === 'wrangler.toml' ? 'name = "api"\nmain = "src/index.ts"' : null)).toEqual({ workerName: 'api', configPath: 'wrangler.toml' });
    expect(await candidateWorkerTarget(async () => null)).toBeNull();
    expect(await candidateWorkerTarget(async (path) => path === 'wrangler.json' ? '{"name":"Bad Name"}' : null)).toBeNull();
    expect(containerFallbackNote('The workspace Cloudflare connection was not granted workers-scripts.edit.')).toBe('Using a preview container because The workspace Cloudflare connection was not granted workers-scripts.edit; grant the Previews permission in Settings → Cloudflare to use Worker Previews.');
    expect(containerFallbackNote('the repository policy sets its own preview command', false)).toBe('Using a preview container because the repository policy sets its own preview command.');
  });

  it('serves a static site from the most likely folder', () => {
    expect(previewPlan(['public/index.html', 'README.md'], null)).toMatchObject({ argv: ['node', '-e', STATIC_SERVER, 'public'], install: null });
    expect(previewPlan(['dist/index.html', 'public/index.html'], null).argv.at(-1)).toBe('dist');
    expect(previewPlan(['index.html'], null).argv.at(-1)).toBe('.');
  });

  it('serves files, lists folders and refuses .git and paths outside the root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitflare-preview-'));
    writeFileSync(join(root, 'README.md'), '# Hello');
    mkdirSync(join(root, 'site'));
    writeFileSync(join(root, 'site', 'index.html'), '<h1>Hello page</h1>');
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), 'secret');
    const port = 20000 + Math.floor(Math.random() * 20000);
    const server = spawn(process.execPath, ['-e', STATIC_SERVER, root], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
    try {
      const get = async (path: string) => {
        for (let attempt = 0; ; attempt++) {
          try { const response = await fetch(`http://127.0.0.1:${port}${path}`); return { status: response.status, type: response.headers.get('content-type'), body: await response.text() }; }
          catch (error) { if (attempt > 40) throw error; await new Promise((resolve) => setTimeout(resolve, 50)); }
        }
      };
      const listing = await get('/');
      expect(listing.status).toBe(200);
      expect(listing.body).toContain('site/');
      expect(listing.body).not.toContain('.git');
      expect(await get('/site/')).toMatchObject({ status: 200, body: '<h1>Hello page</h1>' });
      expect((await get('/README.md')).body).toBe('# Hello');
      expect((await get('/.git/config')).status).toBe(404);
      expect((await get('/%2e%2e/%2e%2e/etc/passwd')).status).toBe(404);
    } finally { server.kill(); }
  });
});
