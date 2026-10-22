import { describe, expect, it, vi } from 'vitest';
const modulePath = '../scripts/deploy-self-hosted.mjs';
const { deploymentConfiguration, preflightDeployment, ensureResources, ensureEncryptionKey, ensurePreviewsWorker, ensurePreviewsToken, installerPreviewsToken, checkInstallerToken, previewsWorkerName, ProvisioningError, appendTail, commandFailure } = await import(modulePath);
const input = { name: 'gitflare', compatibility_date: '2026-10-12', vars: { EDITION: 'self-hosted', AI_GATEWAY_ID: 'gitflare' }, workflows: [{ name: 'gitflare-missions' }], containers: [{ name: 'gitflare-runner' }], artifacts: [{ binding: 'ARTIFACTS', namespace: 'gitflare' }] };
const legacyInput = { ...input, name: 'gitbraid', vars: { ...input.vars, GITBRAID_INSTALLATION: 'gitbraid', GITBRAID_PRIMARY_WORKER: 'gitbraid' }, artifacts: [{ binding: 'ARTIFACTS', namespace: 'gitbraid' }] };
const bindings = [{ type: 'plain_text', name: 'GITFLARE_INSTALLATION', text: 'gitflare' }, { type: 'plain_text', name: 'GITFLARE_PRIMARY_WORKER', text: 'mine' }];
const legacyBindings = [{ type: 'plain_text', name: 'GITBRAID_INSTALLATION', text: 'gitbraid' }, { type: 'plain_text', name: 'GITBRAID_PRIMARY_WORKER', text: 'mine' }];

describe('self-hosted deployment provisioning', () => {
  it('uses the selected account and CI Worker name for isolated main and preview resources', () => {
    const { config, preview } = deploymentConfiguration(input, 'a'.repeat(32), 'my-subdomain', 'mine');
    expect(config).toMatchObject({ name: 'mine', account_id: 'a'.repeat(32), vars: { PREVIEW_ORIGIN: 'https://mine-preview.my-subdomain.workers.dev' }, workflows: [{ name: 'mine-missions' }], artifacts: [{ namespace: 'mine' }] });
    expect(config.vars).toMatchObject({ GITFLARE_INSTALLATION: 'gitflare', GITFLARE_PRIMARY_WORKER: 'mine' });
    expect(preview).toMatchObject({ name: 'mine-preview', services: [{ service: 'mine', entrypoint: 'PreviewRelay' }], vars: { GITFLARE_INSTALLATION: 'gitflare', GITFLARE_PRIMARY_WORKER: 'mine' } });
    expect(input.name).toBe('gitflare');
    expect(() => deploymentConfiguration(input, '', 'unknown', 'mine')).toThrow();
    expect(() => deploymentConfiguration(input, 'a'.repeat(32), undefined, 'mine')).toThrow();
  });

  it('points Worker Previews at a dedicated Worker in the installer’s own account', async () => {
    const { config } = deploymentConfiguration(input, 'd'.repeat(32), 'my-subdomain', 'mine');
    expect(config.vars).toMatchObject({ PREVIEWS_ACCOUNT_ID: 'd'.repeat(32), PREVIEWS_WORKER_NAME: 'mine-previews' });
    expect(previewsWorkerName('x'.repeat(49))).toHaveLength(40);
    const missing = vi.fn(async (method: string) => method === 'GET' ? null : {});
    expect(await ensurePreviewsWorker(missing, 'mine-previews')).toBe(true);
    expect(missing.mock.calls).toEqual([['GET', '/workers/workers/mine-previews', undefined, true], ['POST', '/workers/workers', { name: 'mine-previews', subdomain: { enabled: true, previews_enabled: true } }]]);
    const present = vi.fn(async () => ({ id: 'existing' }));
    expect(await ensurePreviewsWorker(present, 'mine-previews')).toBe(false);
    const secrets = vi.fn(async () => ({}));
    expect(await ensurePreviewsToken(secrets, 'mine', undefined)).toBe(false);
    expect(await ensurePreviewsToken(secrets, 'mine', 'scoped-token')).toBe(true);
    expect(secrets.mock.calls).toEqual([['PUT', '/workers/scripts/mine/secrets', { name: 'PREVIEWS_API_TOKEN', type: 'secret_text', text: 'scoped-token' }]]);
  });

  it('asks the installer for the previews token at most once and checks it before storing', async () => {
    expect(installerPreviewsToken({ GITFLARE_CLOUDFLARE_TOKEN: ' new-token ', GITBRAID_CLOUDFLARE_TOKEN: 'deprecated-token', GITBRAID_PREVIEWS_API_TOKEN: 'old-token' })).toBe('new-token');
    expect(installerPreviewsToken({ GITBRAID_CLOUDFLARE_TOKEN: ' deprecated-token ', GITBRAID_PREVIEWS_API_TOKEN: 'old-token' })).toBe('deprecated-token');
    expect(installerPreviewsToken({ GITBRAID_PREVIEWS_API_TOKEN: 'old-token' })).toBe('old-token');
    expect(installerPreviewsToken({})).toBeUndefined();
    const paths: string[] = [];
    const allowed = vi.fn(async (url: string) => { paths.push(new URL(url).pathname); return Response.json({ success: !url.includes('/d1/') }, { status: url.includes('/d1/') ? 403 : 200 }); });
    expect(await checkInstallerToken('scoped-token', 'd'.repeat(32), 'mine-previews', allowed)).toEqual({ d1: false });
    expect(paths).toEqual([`/client/v4/accounts/${'d'.repeat(32)}/workers/workers/mine-previews/previews`, `/client/v4/accounts/${'d'.repeat(32)}/d1/database`]);
    const denied = vi.fn(async () => Response.json({ success: false }, { status: 403 }));
    await expect(checkInstallerToken('scoped-token', 'd'.repeat(32), 'mine-previews', denied)).rejects.toThrow('Settings → Cloudflare');
  });

  it('reuses existing gateway, namespace and encryption key without changing them', async () => {
    const api = vi.fn(async (_method: string, path: string) => path.includes('/settings') ? { bindings: [...bindings, { type: 'secret_text', name: 'AUTH_ENCRYPTION_KEY' }] } : { id: 'existing' });
    const plan = await preflightDeployment(api, 'mine', 'gitflare', 'mine');
    expect(plan).toEqual({ gatewayExists: true, namespaceExists: true, encryptionKeyExists: true });
    await ensureResources(api, plan, 'gitflare', 'mine');
    expect(await ensureEncryptionKey(api, 'mine', true)).toBe(false);
    expect(api.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });

  it('never touches AI Gateway for an installation without AI', async () => {
    const api = vi.fn(async (_method: string, path: string) => path.includes('/settings') ? null : path.includes('/artifacts/') ? null : { id: 'unused' });
    const plan = await preflightDeployment(api, 'mine', null, 'mine');
    expect(plan).toEqual({ gatewayExists: true, namespaceExists: false, encryptionKeyExists: false });
    await ensureResources(api, plan, null, 'mine');
    expect(api.mock.calls.some(([, path]) => String(path).includes('ai-gateway'))).toBe(false);
    expect(api.mock.calls.filter(([method]) => method === 'POST').map(([, path]) => path)).toEqual(['/artifacts/namespaces']);
  });

  it('keeps upgrading installations deployed under the deprecated GITBRAID_* markers', async () => {
    const { config, preview } = deploymentConfiguration(legacyInput, 'a'.repeat(32), 'my-subdomain');
    expect(config).toMatchObject({ name: 'gitbraid', artifacts: [{ namespace: 'gitbraid' }], vars: { GITFLARE_INSTALLATION: 'gitflare', GITFLARE_PRIMARY_WORKER: 'gitbraid' } });
    expect(config.vars).not.toHaveProperty('GITBRAID_INSTALLATION');
    expect(config.vars).not.toHaveProperty('GITBRAID_PRIMARY_WORKER');
    expect(preview.vars).toEqual({ GITFLARE_INSTALLATION: 'gitflare', GITFLARE_PRIMARY_WORKER: 'gitbraid' });
    const api = vi.fn(async (_method: string, path: string) => path.includes('/settings') ? { bindings: legacyBindings } : { id: 'existing' });
    await expect(preflightDeployment(api, 'mine', 'gitflare', 'mine')).resolves.toMatchObject({ gatewayExists: true });
    const mismatched = vi.fn(async (_method: string, path: string) => path.includes('/settings') ? { bindings: [{ type: 'plain_text', name: 'GITBRAID_INSTALLATION', text: 'gitbraid' }, { type: 'plain_text', name: 'GITFLARE_PRIMARY_WORKER', text: 'mine' }] } : { id: 'existing' });
    await expect(preflightDeployment(mismatched, 'mine', 'gitflare', 'mine')).rejects.toThrow('another application');
  });

  it('does not mutate anything when account permissions fail or a Worker belongs to another app', async () => {
    const denied = vi.fn(async () => { throw new ProvisioningError(403, 'Gateway access'); });
    await expect(preflightDeployment(denied, 'mine', 'gitflare', 'mine')).rejects.toThrow('Cloudflare dashboard');
    expect(denied).toHaveBeenCalledTimes(1);
    const unrelated = vi.fn(async (_method: string, path: string) => path.includes('/settings') ? { bindings: [] } : null);
    await expect(preflightDeployment(unrelated, 'mine', 'gitflare', 'mine')).rejects.toThrow('another application');
    expect(unrelated.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });

  it('creates the gateway before other resource changes and stops on denied creation', async () => {
    const denied = vi.fn(async () => { throw new ProvisioningError(403, 'Gateway creation'); });
    await expect(ensureResources(denied, { gatewayExists: false, namespaceExists: false }, 'gitflare', 'mine')).rejects.toThrow('AI Gateway');
    expect(denied).toHaveBeenCalledTimes(1);
    expect(denied.mock.calls[0]).toEqual(['POST', '/ai-gateway/gateways', expect.objectContaining({ id: 'gitflare', byok_only: true, authentication: true })]);
  });

  it('generates an encryption key only after checking the current remote secret names', async () => {
    const api = vi.fn(async (method: string) => method === 'GET' ? [] : {});
    expect(await ensureEncryptionKey(api, 'mine', false, () => 'b'.repeat(64))).toBe(true);
    expect(api.mock.calls).toEqual([['GET', '/workers/scripts/mine/secrets'], ['PUT', '/workers/scripts/mine/secrets', { name: 'AUTH_ENCRYPTION_KEY', type: 'secret_text', text: 'b'.repeat(64) }]]);
    const existing = vi.fn(async () => [{ name: 'AUTH_ENCRYPTION_KEY' }]);
    expect(await ensureEncryptionKey(existing, 'mine', false)).toBe(false);
    expect(existing).toHaveBeenCalledTimes(1);
  });

  it('reports the tail of a failed command\'s stderr without echoing credentials', () => {
    let errors = '';
    for (let index = 0; index < 100; index += 1) errors = appendTail(errors, `line ${index} ${'x'.repeat(60)}\n`);
    expect(errors.length).toBe(4096);
    expect(errors).toContain('line 99');
    expect(errors).not.toContain('line 0 ');
    const token = 'cf-secret-token-value-123';
    const failure = commandFailure(1, `✘ [ERROR] Authentication error [code: 10000] for ${token}\n`, [token, 'a'.repeat(32), undefined]);
    expect(failure.message).toContain('Deployment command failed (1).');
    expect(failure.message).toContain('Authentication error [code: 10000]');
    expect(failure.message).toContain('[redacted]');
    expect(failure.message).not.toContain(token);
    expect(commandFailure(2, '  ').message).toBe('Deployment command failed (2). Inspect Cloudflare build diagnostics; secret values are not printed by this helper.');
  });
});
