import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildWorkerBundle, deployBuildScript, readWorkerConfig, validBuildCommand, workerBuildScript } from '../src/worker/worker-bundle';
import { cloudflareDeployClient, workerDeployer } from '../src/worker/cloudflare-deploy';

const worktree = join(__dirname, '..');
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function monorepo(files: Record<string, string>): string {
  const base = join(worktree, '.wrangler');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'test-deploy-'));
  roots.push(root);
  symlinkSync(join(worktree, 'node_modules'), join(root, 'node_modules'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
const sandboxFor = (root: string) => {
  const run = async (script: string) => { const result = spawnSync('bash', ['-c', script], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }; };
  return { check: run, collect: run };
};

const viteOutput = {
  'apps/web/wrangler.jsonc': JSON.stringify({ name: 'prahari-web', main: '@tanstack/react-start/server-entry', compatibility_date: '2026-07-01', routes: [{ pattern: 'support.nexarq.dev', custom_domain: true }] }),
  'apps/web/.wrangler/deploy/config.json': JSON.stringify({ configPath: '../../dist/server/wrangler.json', auxiliaryWorkers: [] }),
  'apps/web/dist/server/wrangler.json': JSON.stringify({ name: 'prahari-web', main: 'index.js', compatibility_date: '2026-07-01', compatibility_flags: ['nodejs_compat'], no_bundle: true, rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }], assets: { directory: '../client' }, workers_dev: true, routes: [{ pattern: 'support.nexarq.dev', custom_domain: true }], services: [{ binding: 'API', service: 'prahari-api' }], d1_databases: [{ binding: 'DB', database_name: 'prahari-db', database_id: 'e5aec431-6c88-4454-afac-7cf26941d158' }] }),
  'apps/web/dist/server/index.js': "import { handler } from './assets/chunk.js';\nexport default { fetch: handler };\n",
  'apps/web/dist/server/assets/chunk.js': "export const handler = () => new Response('ok');\n",
  'apps/web/dist/client/index.html': '<!doctype html>',
  'apps/web/dist/client/_headers': '/*\n  X-Frame-Options: DENY\n',
};

describe('deploy builds honour wrangler’s redirected config', () => {
  it('follows .wrangler/deploy/config.json to the Vite output and builds its no_bundle modules', async () => {
    const root = monorepo(viteOutput);
    const sandbox = sandboxFor(root);
    const config = await readWorkerConfig(sandbox, 'apps/web/wrangler.jsonc', true);
    expect(config).toMatchObject({ configPath: 'apps/web/dist/server/wrangler.json', userConfigPath: 'apps/web/wrangler.jsonc', assets: true, deploy: { name: 'prahari-web', assets: { directory: 'apps/web/dist/client' }, workers_dev: true, services: [{ binding: 'API', service: 'prahari-api' }] } });
    const bundle = await buildWorkerBundle(sandbox, config!);
    expect(bundle.mainModule).toBe('index.js');
    expect(bundle.modules.map((module) => module.name).sort()).toEqual(['assets/chunk.js', 'index.js']);
    const direct = await readWorkerConfig(sandbox, 'apps/web/wrangler.jsonc');
    expect(direct?.configPath).toBe('apps/web/wrangler.jsonc');
  }, 120_000);

  it('rejects a redirect that leaves the repository', async () => {
    const root = monorepo({ ...viteOutput, 'apps/web/.wrangler/deploy/config.json': JSON.stringify({ configPath: '../../../../../../../../etc/hosts' }) });
    await expect(readWorkerConfig(sandboxFor(root), 'apps/web/wrangler.jsonc', true)).rejects.toMatchObject({ code: 'WRANGLER_REDIRECT_INVALID' });
  });

  it('finds wrangler in the package that owns the config before the repository root', () => {
    const script = workerBuildScript('apps/api/wrangler.jsonc');
    const root = monorepo({ 'apps/api/node_modules/.bin/wrangler': '#!/bin/sh\necho "nested $*" > /dev/null\n' });
    spawnSync('chmod', ['+x', join(root, 'apps/api/node_modules/.bin/wrangler')]);
    const lookup = script.split('\n').find((line) => line.startsWith('wrangler_bin()'))!;
    const found = spawnSync('bash', ['-c', `${lookup}\nwrangler_bin apps/api/wrangler.jsonc`], { cwd: root, encoding: 'utf8' });
    expect(found.stdout).toBe('apps/api/node_modules/.bin/wrangler');
    const fallback = spawnSync('bash', ['-c', `${lookup}\nwrangler_bin apps/other/wrangler.jsonc`], { cwd: root, encoding: 'utf8' });
    expect(fallback.stdout).toBe('./node_modules/.bin/wrangler');
  });

  it('runs a single-line build command without Cloudflare credentials and reports its tail on failure', () => {
    expect(validBuildCommand('pnpm --filter @prahari/web build')).toBe(true);
    expect(validBuildCommand('a\nb')).toBe(false);
    expect(validBuildCommand('x'.repeat(501))).toBe(false);
    expect(() => deployBuildScript('a\nb')).toThrow('single line');
    const root = monorepo({});
    const ok = spawnSync('bash', ['-c', deployBuildScript('mkdir -p out && echo "${CLOUDFLARE_API_TOKEN:-}" > out/token')], { cwd: root, encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_TOKEN: 'leak' } });
    expect(ok.status).toBe(0);
    expect(spawnSync('cat', [join(root, 'out/token')], { encoding: 'utf8' }).stdout.trim()).toBe('');
    const failed = spawnSync('bash', ['-c', deployBuildScript('echo building; echo broke >&2; exit 3')], { cwd: root, encoding: 'utf8' });
    expect(failed.status).toBe(3);
    expect(failed.stderr).toContain('broke');
  });
});

const apiConfig = {
  name: 'prahari-api', main: 'src/index.js', compatibility_date: '2026-07-01', workers_dev: false,
  vars: { STAGE: 'production' },
  routes: [{ pattern: 'api.nexarq.dev', custom_domain: true }],
  d1_databases: [{ binding: 'DB', database_name: 'prahari-db', database_id: '11111111-1111-4111-8111-111111111111', migrations_dir: 'migrations' }],
  r2_buckets: [{ binding: 'FILES', bucket_name: 'prahari-files' }],
  env: {
    staging: {
      main: 'src/staging.js',
      vars: { STAGE: 'staging' },
      routes: [{ pattern: 'api-staging.nexarq.dev', custom_domain: true }],
      d1_databases: [{ binding: 'DB', database_name: 'prahari-db-staging', database_id: '22222222-2222-4222-8222-222222222222', migrations_dir: 'migrations' }],
    },
    named: { name: 'prahari-api-qa' },
  },
};
const apiFiles = {
  'apps/api/wrangler.jsonc': JSON.stringify(apiConfig),
  'apps/api/src/index.js': "export default { fetch: () => new Response('production') };\n",
  'apps/api/src/staging.js': "export default { fetch: () => new Response('staging') };\n",
};

describe('deploy builds use Wrangler environments', () => {
  it('resolves env.staging exactly as wrangler does and bundles with --env', async () => {
    const root = monorepo(apiFiles);
    const sandbox = sandboxFor(root);
    const wrangler = await import('wrangler');
    const expected = wrangler.unstable_readConfig({ config: join(root, 'apps/api/wrangler.jsonc'), env: 'staging' }, { hideWarnings: true });
    const config = await readWorkerConfig(sandbox, 'apps/api/wrangler.jsonc', true, 'staging');
    expect(config).toMatchObject({ environment: 'staging', name: 'prahari-api-staging', main: expect.stringContaining('staging.js') });
    expect(expected.name).toBe('prahari-api-staging');
    expect(config!.deploy).toMatchObject({ name: expected.name, vars: expected.vars, routes: expected.routes, workers_dev: expected.workers_dev, compatibility_date: expected.compatibility_date });
    expect(config!.deploy!.vars).toEqual({ STAGE: 'staging' });
    expect(config!.deploy!.workers_dev).toBe(false);
    expect((config!.deploy!.d1_databases as { database_name: string; migrations_dir: string }[]).map((item) => [item.database_name, item.migrations_dir])).toEqual([['prahari-db-staging', 'apps/api/migrations']]);
    expect(config!.deploy!.r2_buckets ?? []).toEqual(expected.r2_buckets);
    expect(expected.r2_buckets).toEqual([]);
    const named = await readWorkerConfig(sandbox, 'apps/api/wrangler.jsonc', true, 'named');
    expect(named?.name).toBe('prahari-api-qa');
    const production = await readWorkerConfig(sandbox, 'apps/api/wrangler.jsonc', true);
    expect(production).toMatchObject({ name: 'prahari-api', deploy: { vars: { STAGE: 'production' }, r2_buckets: [{ binding: 'FILES', bucket_name: 'prahari-files' }] } });
    expect(production?.environment).toBeUndefined();
    const bundle = await buildWorkerBundle(sandbox, config!);
    expect(bundle.mainModule).toBe('staging.js');
    expect(new TextDecoder().decode(bundle.modules[0].content)).toContain('Response("staging")');
    expect(workerBuildScript('apps/api/wrangler.jsonc', 'staging')).toContain("--env 'staging'");
  }, 120_000);

  it('refuses an environment the config does not define, naming the file and key', async () => {
    const root = monorepo({ ...apiFiles, 'apps/web/wrangler.jsonc': JSON.stringify({ name: 'prahari-web', main: 'src/index.js', compatibility_date: '2026-07-01' }), 'apps/web/src/index.js': 'export default {}\n' });
    const sandbox = sandboxFor(root);
    const failure = await readWorkerConfig(sandbox, 'apps/web/wrangler.jsonc', true, 'staging').catch((error) => error);
    expect(failure).toMatchObject({ code: 'DEPLOY_ENVIRONMENT_MISSING' });
    expect(failure.message).toContain('apps/web/wrangler.jsonc has no env.staging block');
    const partial = monorepo({ ...apiFiles, 'apps/api/wrangler.jsonc': JSON.stringify({ ...apiConfig, env: { qa: {} } }) });
    await expect(readWorkerConfig(sandboxFor(partial), 'apps/api/wrangler.jsonc', true, 'staging')).rejects.toMatchObject({ code: 'DEPLOY_ENVIRONMENT_MISSING' });
  }, 120_000);

  it('accepts a redirected build only when it was built for the requested environment', async () => {
    const staged = { ...JSON.parse(viteOutput['apps/web/dist/server/wrangler.json']), name: 'prahari-web-staging', services: [{ binding: 'API', service: 'prahari-api-staging' }], targetEnvironment: 'staging', topLevelName: 'prahari-web', definedEnvironments: ['staging'] };
    const root = monorepo({ ...viteOutput, 'apps/web/dist/server/wrangler.json': JSON.stringify(staged) });
    const sandbox = sandboxFor(root);
    const config = await readWorkerConfig(sandbox, 'apps/web/wrangler.jsonc', true, 'staging');
    expect(config).toMatchObject({ environment: 'staging', name: 'prahari-web-staging', deploy: { services: [{ service: 'prahari-api-staging' }] } });
    expect((await buildWorkerBundle(sandbox, config!)).mainModule).toBe('index.js');
    await expect(readWorkerConfig(sandbox, 'apps/web/wrangler.jsonc', true)).rejects.toMatchObject({ code: 'DEPLOY_ENVIRONMENT_MISSING' });
    const unstaged = monorepo(viteOutput);
    const failure = await readWorkerConfig(sandboxFor(unstaged), 'apps/web/wrangler.jsonc', true, 'staging').catch((error) => error);
    expect(failure).toMatchObject({ code: 'DEPLOY_ENVIRONMENT_MISSING' });
    expect(failure.message).toContain('CLOUDFLARE_ENV=staging');
  }, 120_000);

  it('selects the environment for the build command through CLOUDFLARE_ENV', () => {
    const root = monorepo({});
    const staged = spawnSync('bash', ['-c', deployBuildScript('echo "${CLOUDFLARE_ENV:-none}" > env.txt', 'staging')], { cwd: root, encoding: 'utf8', env: { ...process.env, CLOUDFLARE_ENV: 'other' } });
    expect(staged.status).toBe(0);
    expect(spawnSync('cat', [join(root, 'env.txt')], { encoding: 'utf8' }).stdout.trim()).toBe('staging');
    const production = spawnSync('bash', ['-c', deployBuildScript('echo "${CLOUDFLARE_ENV:-none}" > env.txt')], { cwd: root, encoding: 'utf8', env: { ...process.env, CLOUDFLARE_ENV: 'staging' } });
    expect(production.status).toBe(0);
    expect(spawnSync('cat', [join(root, 'env.txt')], { encoding: 'utf8' }).stdout.trim()).toBe('none');
    expect(() => deployBuildScript('true', 'Bad Env')).toThrow('Invalid deploy environment');
  });
});

describe('Cloudflare deploy client', () => {
  const accountId = 'a'.repeat(32);
  it('stays inside the selected account, applies the session bearer and maps errors', async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (request: Request) => {
      requests.push(request);
      const { pathname } = new URL(request.url);
      if (pathname.endsWith('/missing')) return new Response('{}', { status: 404 });
      if (pathname.endsWith('/denied')) return Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 });
      if (request.method === 'PUT') return Response.json({ success: true, result: { deployment_id: '0123456789abcdef0123456789abcdef' } });
      return Response.json({ success: true, result: { id: 'v1' } });
    });
    const client = cloudflareDeployClient({ accessToken: 'oauth', accountId, scopes: [], source: 'repository' }, fetcher);
    await expect(client.call('/accounts/other/workers/scripts')).rejects.toMatchObject({ code: 'INVALID_CLOUDFLARE_PATH' });
    await expect(client.call(`/accounts/${accountId}/../x`)).rejects.toMatchObject({ code: 'INVALID_CLOUDFLARE_PATH' });
    expect(await client.call(`/accounts/${accountId}/missing`, { allowNotFound: true })).toBeNull();
    await expect(client.call(`/accounts/${accountId}/denied`)).rejects.toMatchObject({ code: 'CLOUDFLARE_PERMISSION_DENIED', detail: expect.stringContaining('Authentication error [10000]') });
    await client.call(`/accounts/${accountId}/workers/assets/upload`, { method: 'POST', bearer: 'session-jwt', query: { base64: 'true' } });
    expect(requests.at(-1)!.headers.get('authorization')).toBe('Bearer session-jwt');
    expect(new URL(requests.at(-1)!.url).search).toBe('?base64=true');
    const deployer = workerDeployer(client, 'prahari-api');
    const bundle = { config: { compatibilityDate: '2026-07-01', compatibilityFlags: [] }, mainModule: 'index.js', modules: [{ name: 'index.js', contentType: 'application/javascript+module', content: new TextEncoder().encode('export default {}') }], totalBytes: 17 } as never;
    expect(await deployer.uploadScript!(bundle, { main_module: 'index.js', migrations: { new_tag: 'v1', steps: [] } })).toEqual({ id: '01234567-89ab-cdef-0123-456789abcdef' });
    expect(new URL(requests.at(-1)!.url).search).toBe('?excludeScript=true&bindings_inherit=strict');
    await deployer.uploadVersion(bundle, {}, { main_module: 'index.js', bindings: [] });
    expect(new URL(requests.at(-1)!.url).pathname).toBe(`/client/v4/accounts/${accountId}/workers/scripts/prahari-api/versions`);
    expect(new URL(requests.at(-1)!.url).search).toBe('?bindings_inherit=strict');
    expect(JSON.parse(String((await requests.at(-1)!.formData()).get('metadata')))).toEqual({ main_module: 'index.js', bindings: [] });
  });
});
