import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CloudflareCall, CloudflareCallInit } from '../src/worker/cloudflare-deploy';
import { ApiError } from '../src/worker/domain';
import { ASSETS_IGNORE_SOURCE, assetContentType, assetManifestScript, assetReadScript, assetUploadConfig, collectAndUploadAssets, parseAssetManifest, singleAssetUploadMode, uploadAssets, validAssetPath, type AssetManifest } from '../src/worker/worker-assets';
import { WorkerBuildFailure } from '../src/worker/worker-bundle';

const worktree = join(__dirname, '..');
const requireFromWrangler = createRequire(createRequire(join(worktree, 'noop.js')).resolve('wrangler/package.json'));
const blake3 = requireFromWrangler('blake3-wasm') as { hash(data: string): Buffer };
const expectedHash = (content: Buffer | string, extension: string) => blake3.hash(Buffer.from(content).toString('base64') + extension).toString('hex').slice(0, 32);

const createIgnore = new Function(`${ASSETS_IGNORE_SOURCE}; return createIgnore;`)() as (lines: string[]) => (path: string, isDir?: boolean) => boolean;

const roots: string[] = [];
function project(files: Record<string, string | Buffer>, base = join(worktree, '.wrangler')): string {
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'test-assets-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const run = (root: string, script: string) => {
  const result = spawnSync('bash', ['-c', script], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
};
const sandboxFor = (root: string) => ({ collect: async (script: string) => run(root, script) });

describe('assets ignore matcher', () => {
  it('follows gitignore semantics', () => {
    const ignored = createIgnore(['# comment', '', '*.map', '/secret.txt', 'build/', '!keep.map', 'docs/**/draft.md', 'a?c.txt', 'logs/**', '\\#hash', 'trail  ', '[abc].bin', '[!x]y.dat']);
    expect(ignored('app.js.map')).toBe(true);
    expect(ignored('deep/dir/app.js.map')).toBe(true);
    expect(ignored('keep.map')).toBe(false);
    expect(ignored('secret.txt')).toBe(true);
    expect(ignored('nested/secret.txt')).toBe(false);
    expect(ignored('build/index.html')).toBe(true);
    expect(ignored('x/build/index.html')).toBe(true);
    expect(ignored('build')).toBe(false);
    expect(ignored('build', true)).toBe(true);
    expect(ignored('docs/draft.md')).toBe(true);
    expect(ignored('docs/a/b/draft.md')).toBe(true);
    expect(ignored('other/docs/draft.md')).toBe(false);
    expect(ignored('abc.txt')).toBe(true);
    expect(ignored('ac.txt')).toBe(false);
    expect(ignored('a/c.txt')).toBe(false);
    expect(ignored('logs/x/y.txt')).toBe(true);
    expect(ignored('logs')).toBe(false);
    expect(ignored('#hash')).toBe(true);
    expect(ignored('trail')).toBe(true);
    expect(ignored('a.bin')).toBe(true);
    expect(ignored('d.bin')).toBe(false);
    expect(ignored('zy.dat')).toBe(true);
    expect(ignored('xy.dat')).toBe(false);
    expect(ignored('index.html')).toBe(false);
  });

  it('cannot re-include a file whose parent directory is excluded', () => {
    const ignored = createIgnore(['private/', '!private/public.txt', '*.log', '!important.log']);
    expect(ignored('private/public.txt')).toBe(true);
    expect(ignored('important.log')).toBe(false);
    expect(ignored('sub/important.log')).toBe(false);
    expect(ignored('debug.log')).toBe(true);
  });

  it('handles ** and wrangler default patterns', () => {
    const ignored = createIgnore(['/.assetsignore', '/_redirects', '/_headers', '**/node_modules', 'a/**/b']);
    expect(ignored('_headers')).toBe(true);
    expect(ignored('sub/_headers')).toBe(false);
    expect(ignored('x/node_modules/y.js')).toBe(true);
    expect(ignored('node_modules/y.js')).toBe(true);
    expect(ignored('a/b')).toBe(true);
    expect(ignored('a/x/y/b')).toBe(true);
    expect(createIgnore(['**'])('anything/at/all')).toBe(true);
    expect(createIgnore([])('index.html')).toBe(false);
  });
});

describe('asset manifest program', () => {
  it('hashes like wrangler with blake3 and honours .assetsignore', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const root = project({
      'public/index.html': '<h1>hi</h1>',
      'public/assets/app.js': 'console.log(1)',
      'public/assets/app.js.map': '{}',
      'public/img/logo.png': png,
      'public/README': 'no extension',
      'public/_headers': '/*\n  X-Test: 1\n',
      'public/_redirects': '/old /new 301\n',
      'public/.assetsignore': '*.map\n',
      'public/nested/_headers': 'kept',
      'src/index.ts': 'export default {}',
    });
    symlinkSync('/etc/hosts', join(root, 'public/hosts'));
    const result = run(root, assetManifestScript('public'));
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    const manifest = parseAssetManifest(result.stdout);
    expect(manifest.hashAlgorithm).toBe('blake3');
    expect(Object.keys(manifest.files)).toEqual(['/README', '/assets/app.js', '/img/logo.png', '/index.html', '/nested/_headers']);
    expect(manifest.files['/index.html']).toEqual({ hash: expectedHash('<h1>hi</h1>', 'html'), size: 11 });
    expect(manifest.files['/img/logo.png']).toEqual({ hash: expectedHash(png, 'png'), size: png.length });
    expect(manifest.files['/README'].hash).toBe(expectedHash('no extension', ''));
    expect(manifest.redirects).toBe('/old /new 301\n');
    expect(manifest.headers).toBe('/*\n  X-Test: 1\n');
    expect(manifest.totalBytes).toBe(11 + 14 + png.length + 12 + 4);
  });

  it('falls back to sha256 when wrangler cannot be resolved', () => {
    const root = project({ 'dist/a.txt': 'a' }, mkdtempSync(join(tmpdir(), 'gitflare-assets-')));
    roots.push(dirname(root));
    const manifest = parseAssetManifest(run(root, assetManifestScript('dist')).stdout);
    expect(manifest.hashAlgorithm).toBe('sha256');
    expect(manifest.files['/a.txt'].hash).toMatch(/^[a-f0-9]{32}$/);
    expect(manifest.redirects).toBeUndefined();
  });

  it('rejects a Pages _worker.js unless .assetsignore exists', () => {
    const root = project({ 'dist/_worker.js': 'secret', 'dist/index.html': 'x' });
    const result = run(root, assetManifestScript('dist'));
    expect(result.exitCode).toBe(71);
    writeFileSync(join(root, 'dist/.assetsignore'), '_worker.js\n');
    const manifest = parseAssetManifest(run(root, assetManifestScript('dist')).stdout);
    expect(Object.keys(manifest.files)).toEqual(['/index.html']);
  });

  it('rejects missing and escaping directories', () => {
    const root = project({ 'dist/a.txt': 'a' });
    expect(run(root, assetManifestScript('missing')).exitCode).toBe(69);
    expect(run(root, assetManifestScript('..')).exitCode).toBe(70);
    symlinkSync(tmpdir(), join(root, 'outside'));
    expect(run(root, assetManifestScript('outside')).exitCode).toBe(70);
  });

  it('enforces the per-asset size limit', async () => {
    const root = project({ 'dist/big.bin': Buffer.alloc(25 * 1024 * 1024 + 1) });
    const error = await collectAndUploadAssets(sandboxFor(root), { call: (async () => { throw new Error('unreachable'); }) as CloudflareCall, accountId: 'acct', workerName: 'w', options: { directory: 'dist' } }).catch((caught) => caught);
    expect(error).toBeInstanceOf(WorkerBuildFailure);
    expect(error.code).toBe('WORKER_ASSET_TOO_LARGE');
    expect(error.message).toContain('/big.bin');
  });

  it('calls collect on a Durable Object stub without touching Function.prototype.bind', async () => {
    const root = project({ 'dist/big.bin': Buffer.alloc(25 * 1024 * 1024 + 1) });
    const local = sandboxFor(root);
    const rpcMethod = new Proxy(local.collect!, { get: (target, property) => { if (property === 'bind') throw new Error('The RPC receiver does not implement the method "bind".'); return Reflect.get(target, property); } });
    const stub = { collect: rpcMethod } as typeof local;
    const error = await collectAndUploadAssets(stub, { call: (async () => { throw new Error('unreachable'); }) as CloudflareCall, accountId: 'acct', workerName: 'w', options: { directory: 'dist' } }).catch((caught) => caught);
    expect(error.code).toBe('WORKER_ASSET_TOO_LARGE');
  });

  it('enforces the total size limit', () => {
    const chunk = Buffer.alloc(21 * 1024 * 1024);
    const root = project(Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`dist/part${index}.bin`, chunk])));
    const result = run(root, assetManifestScript('dist'));
    expect(result.exitCode).toBe(68);
    expect(result.stderr).toContain('100 MiB');
  });

  it('enforces the file count limit', () => {
    const root = project({});
    mkdirSync(join(root, 'dist'));
    for (let index = 0; index <= 20_000; index++) writeFileSync(join(root, 'dist', `${index}.txt`), '');
    const result = run(root, assetManifestScript('dist'));
    expect(result.exitCode).toBe(67);
  });

  it('reads requested files and ranges as base64 only from the assets directory', () => {
    const root = project({ 'dist/a.txt': 'hello world', 'dist/sub/b.css': 'body{}', 'secret.txt': 'nope' });
    const payload = (stdout: string) => JSON.parse(stdout.slice(stdout.indexOf('{')));
    const all = run(root, assetReadScript('dist', ['/a.txt', '/sub/b.css']));
    expect(payload(all.stdout).files).toEqual({ '/a.txt': Buffer.from('hello world').toString('base64'), '/sub/b.css': Buffer.from('body{}').toString('base64') });
    const ranged = run(root, assetReadScript('dist', ['/a.txt'], { offset: 6, length: 5 }));
    expect(payload(ranged.stdout).files['/a.txt']).toBe(Buffer.from('world').toString('base64'));
    expect(run(root, assetReadScript('dist', ['/../secret.txt'])).exitCode).toBe(74);
    expect(run(root, assetReadScript('dist', ['/missing.txt'])).exitCode).toBe(74);
  });
});

describe('parseAssetManifest', () => {
  const line = (value: unknown) => `noise\nGITFLARE_WORKER_ASSETS ${JSON.stringify(value)}\n`;
  const hash = 'a'.repeat(32);
  it('validates paths, hashes and sizes', () => {
    expect(parseAssetManifest(line({ files: { '/a.txt': { hash, size: 1 } }, hashAlgorithm: 'blake3', totalBytes: 1 })).totalBytes).toBe(1);
    for (const path of ['a.txt', '/../a', '/a//b', '/./a', '/a\\b', `/${'x'.repeat(1100)}`]) {
      expect(() => parseAssetManifest(line({ files: { [path]: { hash, size: 1 } }, hashAlgorithm: 'blake3' }))).toThrow(WorkerBuildFailure);
    }
    expect(() => parseAssetManifest(line({ files: { '/a': { hash: 'A'.repeat(32), size: 1 } }, hashAlgorithm: 'blake3' }))).toThrow('bad hash');
    expect(() => parseAssetManifest(line({ files: { '/a': { hash, size: -1 } }, hashAlgorithm: 'blake3' }))).toThrow('bad size');
    expect(() => parseAssetManifest(line({ files: { '/a': { hash, size: 26 * 1024 * 1024 } }, hashAlgorithm: 'blake3' }))).toThrow('bad size');
    expect(() => parseAssetManifest(line({ files: {}, hashAlgorithm: 'md5' }))).toThrow('hash algorithm');
    expect(() => parseAssetManifest('nothing')).toThrow('did not report');
    expect(validAssetPath('/index.html')).toBe(true);
  });
});

describe('asset content types', () => {
  it('matches wrangler mime handling', () => {
    expect(assetContentType('/index.html')).toBe('text/html; charset=utf-8');
    expect(assetContentType('/app.JS')).toBe('text/javascript; charset=utf-8');
    expect(assetContentType('/logo.png')).toBe('image/png');
    expect(assetContentType('/data.json')).toBe('application/json');
    expect(assetContentType('/favicon.ico')).toBe('image/vnd.microsoft.icon');
    expect(assetContentType('/README')).toBe('application/null');
    expect(assetContentType('/.htaccess')).toBe('application/null');
    expect(assetContentType('/file.unknownext')).toBe('application/null');
  });
});

describe('assetUploadConfig', () => {
  it('builds the metadata.assets.config wrangler sends and omits unset keys', () => {
    const manifest: AssetManifest = { files: {}, redirects: '/a /b', headers: '/*\n  X: y', hashAlgorithm: 'blake3', totalBytes: 0 };
    expect(assetUploadConfig({ directory: 'dist', binding: 'ASSETS', html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application', run_worker_first: ['/api/*'], base_path: '/app' }, manifest, { date: '2026-01-01', flags: [] }))
      .toEqual({ html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application', base_path: '/app', run_worker_first: ['/api/*'], _redirects: '/a /b', _headers: '/*\n  X: y' });
    expect(assetUploadConfig({ directory: 'dist', run_worker_first: false }, { files: {}, hashAlgorithm: 'blake3', totalBytes: 0 }, { date: '2026-01-01', flags: [] })).toEqual({ run_worker_first: false });
  });
});

const jwt = (payload: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

function mockCall(handler: (path: string, init: CloudflareCallInit) => unknown) {
  const calls: { path: string; init: CloudflareCallInit }[] = [];
  const call = (async (path: string, init: CloudflareCallInit = {}) => {
    calls.push({ path, init });
    return handler(path, init);
  }) as CloudflareCall;
  return { call, calls };
}

const manifest: AssetManifest = {
  files: {
    '/index.html': { hash: '1'.repeat(32), size: 5 },
    '/copy.html': { hash: '1'.repeat(32), size: 5 },
    '/app.js': { hash: '2'.repeat(32), size: 3 },
    '/img.png': { hash: '3'.repeat(32), size: 4 },
  },
  hashAlgorithm: 'blake3',
  totalBytes: 17,
};
const contents: Record<string, string> = {
  '/index.html': Buffer.from('<p/>!').toString('base64'),
  '/copy.html': Buffer.from('<p/>!').toString('base64'),
  '/app.js': Buffer.from('x=1').toString('base64'),
  '/img.png': Buffer.from([1, 2, 3, 4]).toString('base64'),
};
const read = async (paths: string[]) => Object.fromEntries(paths.map((path) => [path, contents[path]]));

describe('uploadAssets', () => {
  it('returns the session jwt when nothing needs uploading', async () => {
    const { call, calls } = mockCall(() => ({ jwt: 'session', buckets: [] }));
    expect(await uploadAssets({ call, accountId: 'acct', workerName: 'site', manifest, read })).toEqual({ jwt: 'session', uploaded: 0, total: 4 });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/accounts/acct/workers/scripts/site/assets-upload-session');
    expect(calls[0].init).toEqual({ method: 'POST', json: { manifest: manifest.files } });
  });

  it('uploads buckets as base64 multipart parts named by hash and returns the completion jwt', async () => {
    const sessionJwt = jwt({ exp: 9 });
    let uploads = 0;
    const { call, calls } = mockCall((path) => path.endsWith('assets-upload-session') ? { jwt: sessionJwt, buckets: [['1'.repeat(32), '2'.repeat(32)], ['3'.repeat(32)]] } : (++uploads === 2 ? { jwt: 'completion' } : {}));
    const result = await uploadAssets({ call, accountId: 'acct', workerName: 'site', manifest, read });
    expect(result).toEqual({ jwt: 'completion', uploaded: 3, total: 4 });
    const [first, second] = calls.slice(1);
    expect(first.path).toBe('/accounts/acct/workers/assets/upload');
    expect(first.init.query).toEqual({ base64: 'true' });
    expect(first.init.bearer).toBe(sessionJwt);
    expect(first.init.method).toBe('POST');
    const html = first.init.form!.get('1'.repeat(32)) as File;
    expect(html.name).toBe('1'.repeat(32));
    expect(html.type).toBe('text/html; charset=utf-8');
    expect(await html.text()).toBe(contents['/index.html']);
    const js = first.init.form!.get('2'.repeat(32)) as File;
    expect(js.type).toBe('text/javascript; charset=utf-8');
    expect(await js.text()).toBe(contents['/app.js']);
    const png = second.init.form!.get('3'.repeat(32)) as File;
    expect(png.type).toBe('image/png');
    expect(await png.text()).toBe(contents['/img.png']);
  });

  it('retries a failed bucket with exponential backoff', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const { call } = mockCall((path) => {
      if (path.endsWith('assets-upload-session')) return { jwt: 'session', buckets: [['2'.repeat(32)]] };
      if (++attempts < 3) throw new ApiError(502, 'CLOUDFLARE_DEPLOY_REJECTED', 'busy');
      return { jwt: 'done' };
    });
    expect(await uploadAssets({ call, accountId: 'acct', workerName: 'site', manifest, read, sleep: async (ms) => { delays.push(ms); } })).toEqual({ jwt: 'done', uploaded: 1, total: 4 });
    expect(delays).toEqual([1000, 2000]);
  });

  it('gives up after five attempts', async () => {
    const delays: number[] = [];
    const { call, calls } = mockCall((path) => {
      if (path.endsWith('assets-upload-session')) return { jwt: 'session', buckets: [['2'.repeat(32)]] };
      throw new ApiError(502, 'CLOUDFLARE_DEPLOY_REJECTED', 'still busy');
    });
    const error = await uploadAssets({ call, accountId: 'acct', workerName: 'site', manifest, read, sleep: async (ms) => { delays.push(ms); } }).catch((caught) => caught);
    expect(error).toBeInstanceOf(WorkerBuildFailure);
    expect(error.code).toBe('WORKER_ASSETS_UPLOAD_FAILED');
    expect(error.message).toContain('5 attempts: still busy');
    expect(calls).toHaveLength(6);
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });

  it('fails when Cloudflare requests an unknown hash', async () => {
    const { call } = mockCall(() => ({ jwt: 'session', buckets: [['f'.repeat(32)]] }));
    await expect(uploadAssets({ call, accountId: 'acct', workerName: 'site', manifest, read })).rejects.toMatchObject({ code: 'WORKER_ASSETS_UNKNOWN_HASH' });
  });

  it('fails when content does not match the manifest size or no completion jwt arrives', async () => {
    const { call } = mockCall((path) => path.endsWith('assets-upload-session') ? { jwt: 'session', buckets: [['2'.repeat(32)]] } : {});
    await expect(uploadAssets({ call, accountId: 'acct', workerName: 'site', manifest, read: async () => ({ '/app.js': 'AAAA' + 'AAAA' }) })).rejects.toMatchObject({ code: 'WORKER_ASSETS_READ_FAILED' });
    await expect(uploadAssets({ call, accountId: 'acct', workerName: 'site', manifest, read })).rejects.toMatchObject({ code: 'WORKER_ASSETS_UPLOAD_FAILED' });
  });

  it('uploads one raw file per request in single-asset mode', async () => {
    const sessionJwt = jwt({ wrangler_single_asset_uploads: true });
    expect(singleAssetUploadMode(sessionJwt)).toBe(true);
    expect(singleAssetUploadMode('not-a-jwt')).toBe(false);
    let uploads = 0;
    const { call, calls } = mockCall((path) => path.endsWith('assets-upload-session') ? { jwt: sessionJwt, buckets: [['2'.repeat(32), '3'.repeat(32)]] } : (++uploads === 2 ? { jwt: 'completion' } : {}));
    expect(await uploadAssets({ call, accountId: 'acct', workerName: 'site', manifest, read })).toEqual({ jwt: 'completion', uploaded: 2, total: 4 });
    const [js, png] = calls.slice(1);
    expect(js.path).toBe(`/accounts/acct/workers/assets/upload/${'2'.repeat(32)}`);
    expect(js.init.bearer).toBe(sessionJwt);
    expect(js.init.headers).toEqual({ 'Content-Type': 'text/javascript; charset=utf-8' });
    expect(Buffer.from((js.init as { body: Uint8Array }).body).toString()).toBe('x=1');
    expect(png.path).toBe(`/accounts/acct/workers/assets/upload/${'3'.repeat(32)}`);
    expect([...(png.init as { body: Uint8Array }).body]).toEqual([1, 2, 3, 4]);
  });
});

describe('collectAndUploadAssets', () => {
  it('builds the manifest in the sandbox, reads requested files and returns jwt and config', async () => {
    const big = Buffer.alloc(13 * 1024 * 1024, 7);
    big[big.length - 1] = 9;
    const root = project({ 'public/index.html': '<h1>x</h1>', 'public/big.bin': big, 'public/_redirects': '/a /b 302', 'wrangler.jsonc': '{}' });
    const scripts: string[] = [];
    const sandbox = { collect: async (script: string, _timeout: number, cap: number) => { scripts.push(script); expect(cap).toBeLessThanOrEqual(16 * 1024 * 1024); return run(root, script); } };
    let uploadedForm: FormData | undefined;
    const { call } = mockCall((path, init) => {
      if (path.endsWith('assets-upload-session')) {
        const files = (init.json as { manifest: AssetManifest['files'] }).manifest;
        expect(files['/big.bin'].hash).toBe(expectedHash(big, 'bin'));
        return { jwt: 'session', buckets: [[files['/index.html'].hash, files['/big.bin'].hash]] };
      }
      uploadedForm = init.form;
      return { jwt: 'complete' };
    });
    const result = await collectAndUploadAssets(sandbox, { call, accountId: 'acct', workerName: 'site', options: { directory: 'public', not_found_handling: '404-page' } });
    expect(result).toMatchObject({ jwt: 'complete', uploaded: 2, total: 2, hashAlgorithm: 'blake3', config: { not_found_handling: '404-page', _redirects: '/a /b 302' } });
    expect(scripts.length).toBeGreaterThan(3);
    const parts = [...uploadedForm!.values()] as File[];
    const bigPart = parts.find((part) => part.type === 'application/octet-stream')!;
    expect(await bigPart.text()).toBe(big.toString('base64'));
  });
});

