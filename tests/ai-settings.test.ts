import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../src/worker/env';
import { securityHarness } from './security-harness';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {}, WorkflowEntrypoint: class {} }));

const ownerToken = 'o'.repeat(48);

function environment(extra: Partial<Record<string, unknown>> = {}) {
  let aiEnabled = true;
  const catalog = {
    getAiEnabled: async () => aiEnabled,
    setAiEnabled: async (value: boolean) => { aiEnabled = value; return value; },
    listRepositories: async () => [], getRepository: async () => undefined, getModelConnections: async () => [], getDefaultModel: async () => null,
  };
  const env = { GITFLARE_SECURITY: securityHarness().namespace, APP_ENV: 'production', OWNER_TOKEN: ownerToken, GITFLARE_COORDINATOR: { getByName: () => catalog }, ...extra } as unknown as AppEnv;
  return env;
}

async function call(env: AppEnv, path: string, body?: unknown) {
  const worker = (await import('../src/worker/index')).default;
  const response = await worker.fetch(new Request(`https://gitflare.test${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${ownerToken}`, Origin: 'https://gitflare.test', 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  return { status: response.status, body: await response.json() as Record<string, unknown> & { error?: { code: string } } };
}

describe('AI on/off', () => {
  it('lets an owner turn AI off and refuses model work while it is off', async () => {
    const env = environment();
    expect((await call(env, '/api/settings/ai')).body).toEqual({ enabled: true, locked: false });
    expect((await call(env, '/api/settings/ai', { enabled: false })).body).toEqual({ enabled: false, locked: false });
    const draft = await call(env, '/api/missions/draft', { repositoryId: 'r', goal: 'Make this deployable on Workers.' });
    expect(draft).toMatchObject({ status: 403, body: { error: { code: 'AI_DISABLED' } } });
    const mission = await call(env, '/api/missions', { repositoryId: 'r', title: 'Agent work', prompt: 'Change the page title.', tasks: [{ name: 'A', role: 'R', task: 'Change the page title please.' }] });
    expect(mission).toMatchObject({ status: 403, body: { error: { code: 'AI_DISABLED' } } });
    const model = await call(env, '/api/models/action', { action: 'verify', modelId: 'openai/gpt-6-luna' });
    expect(model).toMatchObject({ status: 403, body: { error: { code: 'AI_DISABLED' } } });
    expect((await call(env, '/api/settings/ai', { enabled: true })).body).toEqual({ enabled: true, locked: false });
  });

  it('keeps an installation without AI locked off', async () => {
    const env = environment({ AI_FEATURES: 'disabled' });
    expect((await call(env, '/api/settings/ai')).body).toEqual({ enabled: false, locked: true });
    expect(await call(env, '/api/settings/ai', { enabled: true })).toMatchObject({ status: 409, body: { error: { code: 'AI_LOCKED' } } });
    expect(await call(env, '/api/missions/draft', { repositoryId: 'r', goal: 'Make this deployable on Workers.' })).toMatchObject({ status: 403 });
  });

  it('keeps AI off and says why when the setting cannot be read', async () => {
    const env = environment();
    const catalog = (env.GITFLARE_COORDINATOR as unknown as { getByName(name: string): { getAiEnabled(): Promise<boolean> } }).getByName('catalog');
    catalog.getAiEnabled = async () => { throw new Error('storage unavailable'); };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await call(env, '/api/settings/ai')).body).toEqual({ enabled: false, locked: false, unavailable: true });
      const draft = await call(env, '/api/missions/draft', { repositoryId: 'r', goal: 'Make this deployable on Workers.' });
      expect(draft).toMatchObject({ status: 503, body: { error: { code: 'AI_SETTINGS_UNAVAILABLE', message: expect.stringContaining('stay off') } } });
      expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({ event: 'ai_settings_read_failed', errorName: 'Error' });
      expect(JSON.stringify(logged.mock.calls)).not.toContain('storage unavailable');
    } finally { logged.mockRestore(); }
  });

  it('rejects a malformed setting', async () => {
    expect(await call(environment(), '/api/settings/ai', { enabled: 'no' })).toMatchObject({ status: 400 });
  });
});
