import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: DurableObjectState, protected env: unknown) {} }, WorkerEntrypoint: class {}, WorkflowEntrypoint: class {} }));
import type { Mission, Repository } from '../src/shared/types';
import type { AppEnv } from '../src/worker/env';
import { classifyPreview, workerPreviewBuildCommand } from '../src/worker/preview-plan';
import { hostedPreviewBindings, mainModuleName, moduleContentType, parseWorkerBundle, parseWorkerConfig, previewMigrations, workerBuildScript, WORKER_BUNDLE_MAX_BYTES, type ResolvedWorkerConfig, type WorkerBundle } from '../src/worker/worker-bundle';
import { deleteWorkerPreview, previewAlias, upsertWorkerPreview, validPreviewAlias, workerPreviewsConfig } from '../src/worker/worker-previews';
import { prepareCandidatePreview, buildLandedWorker } from '../src/worker/execution';
import { GitflareCoordinator, WORKER_PREVIEW_TTL_MS } from '../src/worker/coordinator';
import { preparePreview, retirePreview, retireMissionPreview, type PreviewRetireParams } from '../src/worker/background-work';
import { WORKSPACE_PREVIEW_LIMIT } from '../src/worker/capacity';

const SENTINEL = 'GITFLARE_WORKER_BUNDLE ';
const accountId = 'f'.repeat(32);
const token = 'operator-previews-token-SECRET-value';
const config = { accountId, workerName: 'gitflare-previews', token };
const candidateSha = 'b'.repeat(40);
const baseSha = 'a'.repeat(40);
const databases: DatabaseSync[] = [];
afterEach(() => { vi.useRealTimers(); for (const db of databases.splice(0)) db.close(); });

function resolved(overrides: Partial<ResolvedWorkerConfig> = {}): ResolvedWorkerConfig {
  return {
    configPath: 'wrangler.jsonc', name: 'app', main: '/workspace/repo/src/index.ts', compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'], assets: false, containers: [], migrations: [], exports: {},
    production: { vars: { GREETING: 'hello', LIMITS: { max: 3 } }, durableObjects: [], bindings: [] },
    previews: null,
    ...overrides,
  };
}

const configOutput = (value: Record<string, unknown>) => `wrangler warning noise\n${SENTINEL}${JSON.stringify(value)}\n`;
const bundleOutput = (files: { name: string; content: string | Uint8Array }[]) => `${SENTINEL}${JSON.stringify({ configPath: 'wrangler.jsonc', files: files.map((file) => ({ name: file.name, data: Buffer.from(file.content).toString('base64') })) })}\n`;

function bundle(overrides: Partial<ResolvedWorkerConfig> = {}): WorkerBundle {
  return parseWorkerBundle(bundleOutput([{ name: 'index.js', content: 'export default { fetch() { return new Response("ok"); } }' }, { name: 'chunk.wasm', content: new Uint8Array([0, 97, 115, 109]) }]), resolved(overrides));
}

describe('Worker project classification', () => {
  it('uses Worker Previews for a wrangler config with main, with or without assets, and no configured preview command', () => {
    const files = ['wrangler.jsonc', 'src/index.ts'];
    expect(classifyPreview(files, { main: 'src/index.ts' }, { workerPreviews: true })).toBe('worker');
    expect(classifyPreview(['wrangler.toml'], { main: 'src/index.ts' }, { workerPreviews: true })).toBe('worker');
    expect(classifyPreview(files, resolved({ assets: true }), { workerPreviews: true })).toBe('worker');
    expect(classifyPreview(files, { main: 'src/index.ts' }, { workerPreviews: false })).toBe('container');
    expect(classifyPreview(files, { main: undefined }, { workerPreviews: true })).toBe('container');
    expect(classifyPreview(files, null, { workerPreviews: true })).toBe('container');
    expect(classifyPreview(['package.json'], { main: 'src/index.ts' }, { workerPreviews: true })).toBe('container');
    expect(classifyPreview(files, { main: 'src/index.ts' }, { workerPreviews: true, configuredCommand: 'npm run serve' })).toBe('container');
  });

  it('builds first for the Cloudflare Vite plugin or an assets directory that is not committed', () => {
    const vite = JSON.stringify({ scripts: { build: 'vite build' }, devDependencies: { '@cloudflare/vite-plugin': '1.0.0', wrangler: '4.149.0' } });
    const plain = JSON.stringify({ scripts: { build: 'node build.mjs' }, devDependencies: { wrangler: '4.149.0' } });
    const pnpm = { installer: 'pnpm' as const, lockfile: 'pnpm-lock.yaml', pinned: null, fallbackRange: null };
    expect(workerPreviewBuildCommand(['wrangler.jsonc'], vite, null, null)).toBe('npm run build');
    expect(workerPreviewBuildCommand(['wrangler.jsonc'], plain, 'dist', pnpm)).toBe('pnpm run build');
    expect(workerPreviewBuildCommand(['wrangler.jsonc', 'public/index.html'], plain, 'public', null)).toBeNull();
    expect(workerPreviewBuildCommand(['wrangler.jsonc'], plain, null, null)).toBeNull();
    expect(workerPreviewBuildCommand(['wrangler.jsonc'], JSON.stringify({ devDependencies: { '@cloudflare/vite-plugin': '1.0.0' } }), 'dist', null)).toBeNull();
  });
});

describe('Worker build output', () => {
  it('reads the resolved config past log noise and treats a config without main as not a Worker project', () => {
    const parsed = parseWorkerConfig(configOutput({ configPath: 'wrangler.jsonc', main: '/workspace/repo/src/index.ts', compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'], assets: false, migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }], exports: {}, production: { vars: { A: '1' }, durableObjects: [{ name: 'ROOMS', class_name: 'Room' }], bindings: [{ name: 'KV', type: 'kv_namespace' }] }, previews: null }));
    expect(parsed).toMatchObject({ main: '/workspace/repo/src/index.ts', compatibilityDate: '2026-10-01', migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }] });
    expect(parseWorkerConfig(configOutput({ configPath: 'wrangler.jsonc', assets: true }))).toBeNull();
    expect(() => parseWorkerConfig(configOutput({ configPath: 'wrangler.jsonc', main: 'src/index.ts' }))).toThrow('compatibility_date');
    expect(() => parseWorkerConfig('no sentinel here')).toThrow('did not report');
  });

  it('collects the bundled entry first, maps module types and rejects unsafe or oversized output', () => {
    const result = bundle();
    expect(result.mainModule).toBe('index.js');
    expect(result.modules.map((module) => [module.name, module.contentType])).toEqual([['index.js', 'application/javascript+module'], ['chunk.wasm', 'application/wasm']]);
    expect(mainModuleName('src/worker.ts')).toBe('worker.js');
    expect(moduleContentType('notes.txt')).toBe('text/plain');
    expect(moduleContentType('model.py')).toBeNull();
    expect(() => parseWorkerBundle(bundleOutput([{ name: 'other.js', content: 'x' }]), resolved())).toThrow('did not produce index.js');
    expect(() => parseWorkerBundle(bundleOutput([{ name: '../escape.js', content: 'x' }]), resolved())).toThrow('unsafe');
    expect(() => parseWorkerBundle(bundleOutput([{ name: '/abs.js', content: 'x' }]), resolved())).toThrow('unsafe');
    expect(() => parseWorkerBundle(bundleOutput([{ name: 'index.js', content: 'x' }, { name: 'tool.py', content: 'x' }]), resolved())).toThrow('unsupported module type');
    const huge = new Uint8Array(WORKER_BUNDLE_MAX_BYTES + 1);
    expect(() => parseWorkerBundle(bundleOutput([{ name: 'index.js', content: huge }]), resolved())).toThrow('exceeds 10 MiB');
  });

  it('builds without any Cloudflare credential in the sandbox environment', () => {
    const script = workerBuildScript('wrangler.jsonc');
    expect(script).toContain('unset CLOUDFLARE_API_TOKEN');
    expect(script).toContain('"$WRANGLER" deploy --dry-run');
    expect(script).toContain('--outdir');
    expect(script).not.toMatch(/CLOUDFLARE_API_TOKEN=|Authorization/);
  });
});

describe('hosted preview binding policy', () => {
  it('keeps vars and self-owned Durable Objects and drops everything that reaches operator resources', () => {
    const plan = hostedPreviewBindings(resolved({
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Room', 'Old'] }, { tag: 'v2', deleted_classes: ['Old'] }],
      containers: ['Sandbox'],
      production: {
        vars: { GREETING: 'hello', LIMITS: { max: 3 } },
        durableObjects: [{ name: 'ROOMS', class_name: 'Room' }, { name: 'REMOTE', class_name: 'Room', script_name: 'billing' }, { name: 'GONE', class_name: 'Old' }],
        bindings: [{ name: 'CACHE', type: 'kv_namespace' }, { name: 'DB', type: 'd1' }, { name: 'FILES', type: 'r2_bucket' }, { name: 'AUTH', type: 'service' }, { name: 'KEY', type: 'secrets_store_secret' }, { name: 'AI', type: 'ai' }],
      },
    }));
    expect(plan.env).toEqual({ GREETING: { type: 'plain_text', text: 'hello' }, LIMITS: { type: 'json', json: { max: 3 } }, ROOMS: { type: 'durable_object_namespace', class_name: 'Room' } });
    expect(plan.notes).toContain('D1 binding DB has no preview database. Add previews.d1_databases to wrangler.jsonc to give previews a staging database.');
    for (const name of ['REMOTE', 'GONE', 'CACHE', 'FILES', 'AUTH', 'KEY', 'AI']) expect(plan.notes.some((note) => note.startsWith(`Binding ${name} `) && note.includes('not available in hosted previews'))).toBe(true);
    expect(plan.notes).toContain('Containers are not available in hosted previews.');
    expect(JSON.stringify(plan.env)).not.toMatch(/namespace_id|database_id|bucket_name|"service"|secret/);
  });

  it('binds the Worker’s own static assets', () => {
    const plan = hostedPreviewBindings(resolved({ assets: true, deploy: { assets: { directory: 'dist', binding: 'ASSETS' } } }));
    expect(plan.env.ASSETS).toEqual({ type: 'assets' });
    expect(hostedPreviewBindings(resolved({ assets: true, deploy: { assets: { directory: 'dist' } } })).env).not.toHaveProperty('ASSETS');
  });

  it('prefers the previews block over production bindings', () => {
    const plan = hostedPreviewBindings(resolved({ previews: { vars: { MODE: 'preview' }, durableObjects: [], bindings: [] } }));
    expect(plan.env).toEqual({ MODE: { type: 'plain_text', text: 'preview' } });
  });

  it('applies only migrations after the preview’s current tag', () => {
    const value = resolved({ migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }, { tag: 'v2', new_sqlite_classes: ['Lobby'] }] });
    expect(previewMigrations(value, undefined)).toEqual({ new_tag: 'v2', steps: [{ new_sqlite_classes: ['Room'] }, { new_sqlite_classes: ['Lobby'] }] });
    expect(previewMigrations(value, 'v1')).toEqual({ old_tag: 'v1', new_tag: 'v2', steps: [{ new_sqlite_classes: ['Lobby'] }] });
    expect(previewMigrations(value, 'v2')).toBeUndefined();
  });
});

describe('Worker Previews configuration', () => {
  it('reads only the installation’s own account variables and validates preview names', () => {
    expect(workerPreviewsConfig({})).toBeNull();
    expect(workerPreviewsConfig({ PREVIEWS_ACCOUNT_ID: accountId, PREVIEWS_WORKER_NAME: 'gitflare-previews' })).toBeNull();
    const selfHosted = workerPreviewsConfig({ PREVIEWS_ACCOUNT_ID: 'e'.repeat(32), PREVIEWS_WORKER_NAME: 'gitflare-previews', PREVIEWS_API_TOKEN: 'installer-token' });
    expect(selfHosted).toEqual({ accountId: 'e'.repeat(32), workerName: 'gitflare-previews', token: 'installer-token' });
    expect(() => workerPreviewsConfig({ PREVIEWS_ACCOUNT_ID: 'not-an-account', PREVIEWS_WORKER_NAME: 'gitflare-previews', PREVIEWS_API_TOKEN: 'x' })).toThrow();
    const alias = previewAlias('3F2504E0-4F89-11D3-9A0C-0305E82C3301', 'gitflare-previews');
    expect(alias).toBe('pr-3f2504e04f89');
    expect(validPreviewAlias(alias, 'gitflare-previews')).toBe(true);
    expect(validPreviewAlias('9starts-with-digit', 'w')).toBe(false);
    expect(validPreviewAlias('pr-x', 'w'.repeat(60))).toBe(false);
    expect(`${previewAlias('a'.repeat(36), 'w'.repeat(48))}-${'w'.repeat(48)}`.length).toBeLessThanOrEqual(63);
  });
});

type Recorded = { method: string; url: string; authorization: string | null; json?: unknown; form?: FormData };
function previewsApi(options: { existing?: boolean; latestTag?: string; deleteStatus?: number } = {}) {
  const calls: Recorded[] = [];
  const fetcher = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    const entry: Recorded = { method: request.method, url: url.pathname + url.search, authorization: request.headers.get('authorization') };
    if (request.headers.get('content-type')?.includes('application/json')) entry.json = await request.json();
    else if (request.method === 'POST') entry.form = await request.formData();
    calls.push(entry);
    const base = `/client/v4/accounts/${accountId}/workers/workers/gitflare-previews/previews`;
    if (request.method === 'GET' && url.pathname === `${base}/pr-abc`) return options.existing ? Response.json({ success: true, result: { id: 'preview-id', name: 'pr-abc', urls: ['https://pr-abc-gitflare-previews.example.workers.dev'] } }) : Response.json({ success: false, errors: [{ code: 10025, message: 'Preview not found' }] }, { status: 404 });
    if (request.method === 'POST' && url.pathname === base) return Response.json({ success: true, result: { id: 'preview-id', name: 'pr-abc', urls: ['https://pr-abc-gitflare-previews.example.workers.dev'] } });
    if (request.method === 'GET' && url.pathname === `${base}/preview-id/deployments/latest`) return Response.json({ success: true, result: { id: 'old', migration_tag: options.latestTag } });
    if (request.method === 'POST' && url.pathname === `${base}/preview-id/deployments`) return Response.json({ success: true, result: { id: 'deployment-id', urls: ['https://deployment-id-gitflare-previews.example.workers.dev'] } });
    if (request.method === 'DELETE' && url.pathname === `${base}/pr-abc`) return options.deleteStatus === 404 ? Response.json({ success: false, errors: [{ code: 10025 }] }, { status: 404 }) : Response.json({ success: true, result: null });
    return Response.json({ success: false, errors: [{ code: 1, message: 'unexpected' }] }, { status: 400 });
  });
  return { calls, fetcher };
}

describe('Worker Previews upload', () => {
  it('creates a preview without base config, then uploads one multipart deployment with only allowed bindings', async () => {
    const api = previewsApi();
    const value = bundle({ production: { vars: { GREETING: 'hello' }, durableObjects: [], bindings: [{ name: 'CACHE', type: 'kv_namespace' }] } });
    const result = await upsertWorkerPreview(config, { alias: 'pr-abc', bundle: value, annotations: { 'workers/commit_sha': candidateSha } }, api.fetcher);
    expect(api.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET /client/v4/accounts/${accountId}/workers/workers/gitflare-previews/previews/pr-abc`,
      `POST /client/v4/accounts/${accountId}/workers/workers/gitflare-previews/previews?ignore_base_config=true`,
      `POST /client/v4/accounts/${accountId}/workers/workers/gitflare-previews/previews/preview-id/deployments`,
    ]);
    expect(api.calls.every((call) => call.authorization === `Bearer ${token}`)).toBe(true);
    expect(api.calls[1].json).toEqual({ name: 'pr-abc' });
    const form = api.calls[2].form!;
    const metadata = JSON.parse(String(form.get('metadata')));
    expect(metadata).toEqual({ main_module: 'index.js', compatibility_date: '2026-10-01', compatibility_flags: ['nodejs_compat'], env: { GREETING: { type: 'plain_text', text: 'hello' } }, annotations: { 'workers/commit_sha': candidateSha } });
    const files = form.getAll('files') as File[];
    expect(files.map((file) => [file.name, file.type])).toEqual([['index.js', 'application/javascript+module'], ['chunk.wasm', 'application/wasm']]);
    expect(result).toEqual({ previewName: 'pr-abc', previewId: 'preview-id', previewUrl: 'https://pr-abc-gitflare-previews.example.workers.dev', deploymentUrl: 'https://deployment-id-gitflare-previews.example.workers.dev', deploymentId: 'deployment-id', notes: ['Binding CACHE (kv_namespace) is not available in hosted previews.'] });
  });

  it('updates the same alias on a new candidate and continues its Durable Object migrations', async () => {
    const api = previewsApi({ existing: true, latestTag: 'v1' });
    await upsertWorkerPreview(config, { alias: 'pr-abc', bundle: bundle({ migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }, { tag: 'v2', new_sqlite_classes: ['Lobby'] }] }) }, api.fetcher);
    expect(api.calls.some((call) => call.url.endsWith('/previews?ignore_base_config=true'))).toBe(false);
    const metadata = JSON.parse(String(api.calls.at(-1)!.form!.get('metadata')));
    expect(metadata.migrations).toEqual({ old_tag: 'v1', new_tag: 'v2', steps: [{ new_sqlite_classes: ['Lobby'] }] });
  });

  it('uploads assets after resolving the preview and sends them like wrangler preview', async () => {
    const api = previewsApi();
    const order: string[] = [];
    const uploadAssets = vi.fn(async () => { order.push(`assets after ${api.calls.length} calls`); return { jwt: 'completion-jwt', config: { html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application', run_worker_first: ['/api/*'], _headers: '/*\n  X-Test: 1', _redirects: '/old /new 301' } }; });
    const value = bundle({ assets: true, deploy: { assets: { directory: 'dist', binding: 'ASSETS' } } });
    await upsertWorkerPreview(config, { alias: 'pr-abc', bundle: value, uploadAssets }, api.fetcher);
    expect(order).toEqual(['assets after 2 calls']);
    const form = api.calls.at(-1)!.form!;
    const metadata = JSON.parse(String(form.get('metadata')));
    expect(metadata.assets).toEqual({ jwt: 'completion-jwt', config: { html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application', run_worker_first: ['/api/*'] } });
    expect(metadata.env.ASSETS).toEqual({ type: 'assets' });
    const files = form.getAll('files') as File[];
    expect(files.map((file) => [file.name, file.type])).toEqual([['index.js', 'application/javascript+module'], ['chunk.wasm', 'application/wasm'], ['_headers', 'text/plain'], ['_redirects', 'text/plain']]);
    expect(await files[3].text()).toBe('/old /new 301');
  });

  it('deletes idempotently and reports a missing parent Worker clearly', async () => {
    expect(await deleteWorkerPreview(config, 'pr-abc', previewsApi().fetcher)).toBe('deleted');
    expect(await deleteWorkerPreview(config, 'pr-abc', previewsApi({ deleteStatus: 404 }).fetcher)).toBe('missing');
    const missingParent = vi.fn(async () => Response.json({ success: false, errors: [{ code: 10007, message: 'workers.api.error.script_not_found' }] }, { status: 404 }));
    await expect(upsertWorkerPreview(config, { alias: 'pr-abc', bundle: bundle() }, missingParent)).rejects.toMatchObject({ code: 'PREVIEWS_WORKER_MISSING' });
  });
});

function workerSandbox() {
  const recorded: string[] = [];
  const runner = {
    prepare: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    startPreview: vi.fn(async () => {}),
    expireAt: vi.fn(async () => {}),
    install: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    command: vi.fn(async (argv: string[]) => {
      recorded.push(argv.join(' '));
      if (argv[0] === 'git' && argv[1] === 'ls-files') return { exitCode: 0, stdout: 'wrangler.jsonc\nsrc/index.ts\npackage.json\npackage-lock.json\n', stderr: '' };
      if (argv[0] === 'git' && argv[1] === 'show') return { exitCode: 128, stdout: '', stderr: 'missing' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
    check: vi.fn(async (script: string) => { recorded.push(script); return { exitCode: 0, stdout: '', stderr: '' }; }),
    collect: vi.fn(async (script: string) => {
      recorded.push(script);
      if (script.includes('unstable_readConfig')) return { exitCode: 0, stdout: configOutput({ configPath: 'wrangler.jsonc', main: '/workspace/repo/src/index.ts', compatibilityDate: '2026-10-01', compatibilityFlags: [], assets: false, migrations: [], exports: {}, production: { vars: { GREETING: 'hi' }, durableObjects: [], bindings: [{ name: 'KV', type: 'kv_namespace' }] }, previews: null }), stderr: '' };
      return { exitCode: 0, stdout: bundleOutput([{ name: 'index.js', content: 'export default {}' }]), stderr: '' };
    }),
  };
  return { runner, recorded };
}

const artifacts = { get: async (name: string) => ({ [Symbol.dispose]() {}, info: async () => ({ name, remote: `https://git.example/${name}.git`, defaultBranch: 'main' }), log: async () => [{ hash: candidateSha }] }) };

describe('credential isolation during builds', () => {
  it('never passes the previews token or a deploy token into sandbox commands', async () => {
    const { runner, recorded } = workerSandbox();
    const env = { ARTIFACTS: artifacts, SANDBOX: { getByName: () => runner }, PREVIEWS_API_TOKEN: token } as unknown as AppEnv;
    const mission = { id: 'mission', epoch: 1, status: 'needs_review', baseSha, candidateSha, integrationForkName: 'combined', checks: [] } as unknown as Mission;
    const prepared = await prepareCandidatePreview(env, { repository: { name: 'repo' } as Repository, mission, previewAttemptId: '11111111-1111-4111-8111-111111111111', workerPreviews: true });
    expect(prepared.kind).toBe('worker');
    expect(runner.startPreview).not.toHaveBeenCalled();
    expect(runner.destroy).toHaveBeenCalled();
    expect(runner.install).toHaveBeenCalledWith({ installer: 'npm', lockfile: 'package-lock.json', pinned: null, fallbackRange: null });
    await buildLandedWorker(env, { repository: { id: 'repo', name: 'repo', defaultBranch: 'main' } as Repository, commitSha: candidateSha, attemptId: '22222222-2222-4222-8222-222222222222', assertAuthority: async () => {} });
    expect(recorded.length).toBeGreaterThan(5);
    for (const entry of recorded) {
      expect(entry).not.toContain(token);
      expect(entry).not.toMatch(/Bearer|upstream-access-token/);
    }
    expect(JSON.stringify(runner.prepare.mock.calls)).not.toContain(token);
  });

  it('keeps the container path when Worker Previews are not configured', async () => {
    const { runner } = workerSandbox();
    const env = { ARTIFACTS: artifacts, SANDBOX: { getByName: () => runner } } as unknown as AppEnv;
    const mission = { id: 'mission', epoch: 1, status: 'needs_review', baseSha, candidateSha, integrationForkName: 'combined', checks: [] } as unknown as Mission;
    const prepared = await prepareCandidatePreview(env, { repository: { name: 'repo' } as Repository, mission, previewAttemptId: '11111111-1111-4111-8111-111111111111' });
    expect(prepared.kind).toBe('container');
    expect(runner.collect).not.toHaveBeenCalled();
    expect(runner.startPreview).toHaveBeenCalled();
  });
});

const assetRoots: string[] = [];
afterAll(() => { for (const root of assetRoots) rmSync(root, { recursive: true, force: true }); });

function viteAssetsSandbox(options: { buildExit?: number } = {}) {
  const base = join(__dirname, '..', '.wrangler');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'preview-assets-'));
  assetRoots.push(root);
  for (const [path, content] of Object.entries({ 'dist/client/index.html': '<h1>preview</h1>', 'dist/client/_redirects': '/old /new 301', 'dist/client/.assetsignore': 'secret.txt', 'dist/client/secret.txt': 'no' })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const packageJson = JSON.stringify({ scripts: { build: 'vite build' }, devDependencies: { '@cloudflare/vite-plugin': '1.13.0', wrangler: '4.149.0', vite: '7.1.0' } });
  const recorded: string[] = [];
  const runner = {
    prepare: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    startPreview: vi.fn(async () => {}),
    expireAt: vi.fn(async () => {}),
    install: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    command: vi.fn(async (argv: string[]) => {
      recorded.push(argv.join(' '));
      if (argv[0] === 'git' && argv[1] === 'ls-files') return { exitCode: 0, stdout: 'wrangler.jsonc\nsrc/index.ts\nsrc/client.tsx\nindex.html\npackage.json\npackage-lock.json\n', stderr: '' };
      if (argv[0] === 'cat' && argv[1] === 'package.json') return { exitCode: 0, stdout: packageJson, stderr: '' };
      if (argv[0] === 'git' && argv[1] === 'show') return { exitCode: 128, stdout: '', stderr: 'missing' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
    check: vi.fn(async (script: string) => {
      recorded.push(script);
      if (script.includes('npm run build')) return { exitCode: options.buildExit ?? 0, stdout: '', stderr: options.buildExit ? 'error during build: Cannot find module ./missing' : '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
    collect: vi.fn(async (script: string) => {
      recorded.push(script);
      if (script.includes('unstable_readConfig')) {
        return script.endsWith(' redirect')
          ? { exitCode: 0, stdout: configOutput({ configPath: 'dist/app/wrangler.json', userConfigPath: 'wrangler.jsonc', main: '/workspace/repo/dist/app/index.js', compatibilityDate: '2026-10-01', compatibilityFlags: [], assets: true, deploy: { assets: { directory: 'dist/client', binding: 'ASSETS', not_found_handling: 'single-page-application' } }, migrations: [], exports: {}, production: { vars: { GREETING: 'hi' }, durableObjects: [], bindings: [{ name: 'CACHE', type: 'kv_namespace' }] }, previews: null }), stderr: '' }
          : { exitCode: 0, stdout: configOutput({ configPath: 'wrangler.jsonc', main: '/workspace/repo/src/index.ts', compatibilityDate: '2026-10-01', compatibilityFlags: [], assets: false, migrations: [], exports: {}, production: { vars: {}, durableObjects: [], bindings: [] }, previews: null }), stderr: '' };
      }
      if (script.includes('GITFLARE_WORKER_ASSETS')) {
        const result = spawnSync('bash', ['-c', script], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      }
      return { exitCode: 0, stdout: bundleOutput([{ name: 'index.js', content: 'export default {}' }]), stderr: '' };
    }),
  };
  return { runner, recorded };
}

function coordinatorHarness() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  const ctx = {
    storage: {
      getAlarm: vi.fn(async () => null), setAlarm: vi.fn(async () => {}),
      sql: { exec(query: string, ...args: SQLInputValue[]) { const statement = db.prepare(query); const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []); return { toArray: () => rows }; } },
      transactionSync<T>(fn: () => T): T { db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    },
  } as unknown as DurableObjectState;
  return new GitflareCoordinator(ctx, {} as AppEnv);
}

async function verifiedMission() {
  const coordinator = coordinatorHarness();
  const catalog = coordinatorHarness();
  const now = new Date().toISOString();
  const repository: Repository = { id: 'repo', name: 'worker-app', description: '', defaultBranch: 'main', headSha: baseSha, provider: 'artifacts', createdAt: now, updatedAt: now };
  coordinator.saveRepository(repository);
  catalog.saveRepository(repository);
  const draft = coordinator.createMission('create', { repositoryId: repository.id, title: 'Add greeting', prompt: 'Add a greeting route.', tasks: [{ name: 'Agent', role: 'Implementation', task: 'Add the route.' }] });
  const started = await coordinator.startMission('start', draft.id);
  const mission = coordinator.recordExecution(draft.id, started.epoch, { candidateSha, integrationForkName: 'combined', runs: started.runs.map((run) => ({ ...run, status: 'completed', commitSha: candidateSha, forkName: 'fork' })), checks: [{ id: 'combined', name: 'Combined tests', status: 'passed', candidateSha, output: 'ok' }], changes: [] }, true);
  return { coordinator, catalog, repository, mission };
}

describe('Worker previews with static assets', () => {
  async function run(sandbox: ReturnType<typeof viteAssetsSandbox>) {
    const { coordinator, catalog, repository, mission } = await verifiedMission();
    const failed = coordinator.previewFailed.bind(coordinator);
    const release = catalog.releasePreviewSlot.bind(catalog);
    Object.assign(coordinator, { previewFailed: async (...args: Parameters<typeof failed>) => failed(...args) });
    Object.assign(catalog, { releasePreviewSlot: async (...args: Parameters<typeof release>) => release(...args) });
    const calls: { method: string; path: string; authorization: string | null; form?: FormData }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const json = request.headers.get('content-type')?.includes('json');
      const body = json ? await request.json() as { manifest?: Record<string, { hash: string }> } : undefined;
      calls.push({ method: request.method, path: url.pathname + url.search, authorization: request.headers.get('authorization'), ...(request.method === 'POST' && !json ? { form: await request.formData() } : {}) });
      if (url.pathname.endsWith('/assets-upload-session')) return Response.json({ success: true, result: { jwt: 'session-jwt', buckets: [Object.values(body?.manifest ?? {}).map((entry) => entry.hash)] } });
      if (url.pathname.endsWith('/workers/assets/upload')) return Response.json({ success: true, result: { jwt: 'completion-jwt' } });
      if (request.method === 'GET') return Response.json({ success: false, errors: [{ code: 10025 }] }, { status: 404 });
      if (url.pathname.endsWith('/deployments')) return Response.json({ success: true, result: { id: 'deployment-id', urls: ['https://deployment-id-gitflare-previews.example.workers.dev'] } });
      return Response.json({ success: true, result: { id: 'preview-id', urls: ['https://pr-x-gitflare-previews.example.workers.dev'] } });
    }) as typeof fetch;
    try {
      const principal = { userId: 'owner', workspaceId: 'legacy', role: 'Owner' as const };
      const env = {
        GITFLARE_SECURITY: { getByName: () => ({ check: async () => {}, identityCall: async () => null }) },
        GITFLARE_COORDINATOR: { getByName: (name: string) => name.startsWith('catalog') ? catalog : coordinator },
        ARTIFACTS: artifacts, SANDBOX: { getByName: () => sandbox.runner },
        PREVIEWS_ACCOUNT_ID: accountId, PREVIEWS_WORKER_NAME: 'gitflare-previews', PREVIEWS_API_TOKEN: token,
      } as unknown as AppEnv;
      expect(catalog.reservePreviewSlot(mission.id, Date.now() + 60_000)).toBe(true);
      const claim = coordinator.claimPreview('preview-key-assets01', mission.id, mission.epoch, candidateSha);
      const steps: string[] = [];
      const step = { do: async <T,>(name: string, _config: unknown, callback: () => Promise<T>) => { steps.push(name); return callback(); } };
      await preparePreview(env, { kind: 'preview', repositoryId: repository.id, missionId: mission.id, epoch: mission.epoch, candidateSha, claimId: claim.claimId, principal }, step);
      return { calls, steps, alias: previewAlias(mission.id, 'gitflare-previews'), status: coordinator.previewStatus(mission.id) };
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  it('builds a Vite plugin project, follows the redirected config and uploads assets in the preview step', async () => {
    const sandbox = viteAssetsSandbox();
    const { calls, steps, alias, status } = await run(sandbox);
    expect(steps).toEqual(['prepare candidate preview']);
    expect(status).toMatchObject({ status: 'ready', kind: 'worker', worker: { notes: ['Binding CACHE (kv_namespace) is not available in hosted previews.'] } });
    expect(sandbox.runner.startPreview).not.toHaveBeenCalled();
    expect(sandbox.recorded.some((entry) => entry.includes('( npm run build )'))).toBe(true);
    expect(sandbox.recorded.some((entry) => entry.includes('unstable_readConfig') && entry.endsWith(' redirect'))).toBe(true);
    expect(sandbox.recorded.some((entry) => entry.includes("--config 'dist/app/wrangler.json'"))).toBe(true);
    const base = `/client/v4/accounts/${accountId}`;
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET ${base}/workers/workers/gitflare-previews/previews/${alias}`,
      `POST ${base}/workers/workers/gitflare-previews/previews?ignore_base_config=true`,
      `POST ${base}/workers/scripts/gitflare-previews/assets-upload-session`,
      `POST ${base}/workers/assets/upload?base64=true`,
      `POST ${base}/workers/workers/gitflare-previews/previews/preview-id/deployments`,
    ]);
    const upload = calls[3];
    expect(upload.authorization).toBe('Bearer session-jwt');
    expect([...upload.form!.keys()]).toHaveLength(1);
    expect(calls.filter((call) => call !== upload).every((call) => call.authorization === `Bearer ${token}`)).toBe(true);
    const deployment = calls[4].form!;
    const metadata = JSON.parse(String(deployment.get('metadata')));
    expect(metadata.assets).toEqual({ jwt: 'completion-jwt', config: { not_found_handling: 'single-page-application' } });
    expect(metadata.env).toEqual({ GREETING: { type: 'plain_text', text: 'hi' }, ASSETS: { type: 'assets' } });
    expect((deployment.getAll('files') as File[]).map((file) => file.name)).toEqual(['index.js', '_redirects']);
    for (const entry of sandbox.recorded) {
      expect(entry).not.toContain(token);
      expect(entry).not.toMatch(/Bearer|session-jwt|completion-jwt/);
    }
    expect(JSON.stringify(sandbox.runner.prepare.mock.calls)).not.toContain(token);
  });

  it('fails with the build output instead of publishing when the preview build fails', async () => {
    const sandbox = viteAssetsSandbox({ buildExit: 1 });
    const { calls, status } = await run(sandbox);
    expect(calls).toEqual([]);
    expect(JSON.stringify(status)).toContain('Worker preview could not be built. npm run build failed (exit 1). error during build: Cannot find module ./missing');
    expect(sandbox.runner.startPreview).not.toHaveBeenCalled();
  });
});

describe('Worker preview lifecycle', () => {
  it('records a ready Worker preview, reuses capacity, and retires it on expiry, close or land', async () => {
    const { coordinator, catalog, repository, mission } = await verifiedMission();
    const { runner } = workerSandbox();
    const api = previewsApi();
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => api.fetcher(input instanceof Request ? input : new Request(input, init))) as typeof fetch;
    const created: { id: string; params: unknown }[] = [];
    try {
      const principal = { userId: 'owner', workspaceId: 'legacy', role: 'Owner' as const };
      const env = {
        GITFLARE_SECURITY: { getByName: () => ({ check: async () => {}, identityCall: async () => null }) },
        GITFLARE_COORDINATOR: { getByName: (name: string) => name.startsWith('catalog') ? catalog : coordinator },
        ARTIFACTS: artifacts, SANDBOX: { getByName: () => runner },
        PREVIEWS_ACCOUNT_ID: accountId, PREVIEWS_WORKER_NAME: 'gitflare-previews', PREVIEWS_API_TOKEN: token,
        MISSION_WORKFLOW: { create: vi.fn(async (input: { id: string; params: unknown }) => { created.push(input); return {}; }), get: vi.fn() },
      } as unknown as AppEnv;
      expect(catalog.reservePreviewSlot(mission.id, Date.now() + 60_000)).toBe(true);
      const claim = coordinator.claimPreview('preview-key-000001', mission.id, mission.epoch, candidateSha);
      const sleeps: number[] = [];
      const step = { do: async <T,>(_name: string, _config: unknown, callback: () => Promise<T>) => callback(), sleep: async (_name: string, duration: number) => { sleeps.push(duration); } };
      const alias = previewAlias(mission.id, 'gitflare-previews');
      const deletes = () => api.calls.filter((call) => call.method === 'DELETE').length;
      const originalRetire = coordinator.retireWorkerPreview.bind(coordinator);
      let statusDuringHold: unknown;
      coordinator.retireWorkerPreview = ((id: string, claimId?: string) => { statusDuringHold ??= coordinator.previewStatus(id); return originalRetire(id, claimId); }) as typeof coordinator.retireWorkerPreview;
      api.fetcher.mockImplementation(async (request: Request) => {
        const url = new URL(request.url);
        api.calls.push({ method: request.method, url: url.pathname + url.search, authorization: request.headers.get('authorization') });
        if (request.method === 'GET') return Response.json({ success: false, errors: [{ code: 10025 }] }, { status: 404 });
        if (request.method === 'DELETE') return Response.json({ success: true, result: null });
        if (url.pathname.endsWith('/deployments')) return Response.json({ success: true, result: { id: 'deployment-id', urls: ['https://deployment-id-gitflare-previews.example.workers.dev'] } });
        return Response.json({ success: true, result: { id: 'preview-id', name: alias, urls: [`https://${alias}-gitflare-previews.example.workers.dev`] } });
      });
      await preparePreview(env, { kind: 'preview', repositoryId: repository.id, missionId: mission.id, epoch: mission.epoch, candidateSha, claimId: claim.claimId, principal }, step);
      expect(sleeps).toEqual([WORKER_PREVIEW_TTL_MS]);
      expect(statusDuringHold).toMatchObject({ status: 'ready', kind: 'worker', worker: { previewName: alias, previewUrl: `https://${alias}-gitflare-previews.example.workers.dev`, notes: ['Binding KV (kv_namespace) is not available in hosted previews.'] } });
      expect(deletes()).toBe(1);
      expect(coordinator.workerPreview(mission.id)).toBeUndefined();

      const again = coordinator.claimPreview('preview-key-000002', mission.id, mission.epoch, candidateSha);
      expect(again.claimed).toBe(true);
      coordinator.workerPreviewReady(mission.id, mission.epoch, candidateSha, again.claimId, { previewName: alias, previewUrl: 'https://x', deploymentUrl: null, notes: [] });
      expect(coordinator.claimPreview('preview-key-000003', mission.id, mission.epoch, candidateSha)).toMatchObject({ claimed: false, worker: { previewName: alias } });
      expect(coordinator.retireWorkerPreview(mission.id, 'some-other-claim')).toBeNull();
      expect(await retireMissionPreview(env, repository.id, mission.id, 'legacy')).toBe('worker');
      expect(created).toEqual([{ id: `preview-retire-${again.claimId}`, params: { kind: 'preview-retire', repositoryId: repository.id, missionId: mission.id, previewName: alias, workspaceId: 'legacy' } }]);
      expect(coordinator.previewStatus(mission.id).status).toBe('none');
      catalog.holdPreviewSlot(mission.id, Date.now() + WORKER_PREVIEW_TTL_MS);
      await retirePreview(env, created[0].params as PreviewRetireParams, step);
      expect(deletes()).toBe(2);
      for (let index = 0; index < WORKSPACE_PREVIEW_LIMIT; index++) expect(catalog.reservePreviewSlot(`other-${index}`, Date.now() + 60_000)).toBe(true);
      expect(() => catalog.reservePreviewSlot('one-too-many', Date.now() + 60_000)).toThrow('WORKSPACE_PREVIEW_LIMIT');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
