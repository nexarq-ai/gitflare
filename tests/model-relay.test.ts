import { afterEach, describe, expect, it, vi } from 'vitest';
import { inferenceMessage, ModelHttpError, ModelLocationError } from '../src/worker/model-adapter';
import { isLocationRefusal, performModelCall, relayRegions, type ModelCall, type ModelCallOutcome } from '../src/worker/model-transport';
import type { ModelConnection } from '../src/shared/types';

vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} }, WorkerEntrypoint: class {} }));

afterEach(() => { vi.restoreAllMocks(); });

const luna: ModelConnection = { id: 'openai/gpt-6-luna', label: 'Luna', source: 'gateway', protocol: 'responses' };
const sonnet: ModelConnection = { id: 'anthropic/claude-sonnet-5-5', label: 'Sonnet', source: 'gateway', protocol: 'anthropic' };
const workersAi: ModelConnection = { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama', source: 'workers-ai', protocol: 'workers-ai' };
const completed = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] };
const anthropicOk = JSON.stringify({ type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 3, output_tokens: 1 } });
const refusalBody = JSON.stringify({ type: 'error', error: { type: 'forbidden', message: 'Request not allowed' } });

function relayWith(...outcomes: ModelCallOutcome[]) {
  const calls: { name: string; hint?: string; call: ModelCall }[] = [];
  let index = 0;
  const relay = {
    idFromName: vi.fn((name: string) => name as unknown as DurableObjectId),
    get: vi.fn((id: DurableObjectId, options?: { locationHint?: string }) => ({
      call: vi.fn(async (call: ModelCall) => {
        calls.push({ name: id as unknown as string, hint: options?.locationHint, call });
        return outcomes[Math.min(index++, outcomes.length - 1)]!;
      }),
    })),
  };
  return { relay, calls };
}

describe('model relay transport', () => {
  it('sends gateway model calls through a relay placed with the configured location hint', async () => {
    const run = vi.fn();
    const { relay, calls } = relayWith({ kind: 'value', value: completed });
    const message = await inferenceMessage({ AI: { run }, AI_GATEWAY_ID: 'gitflare', MODEL_RELAY: relay }, luna, [{ role: 'user', content: 'hi' }], [], 10_000, 16);
    expect(message.text).toBe('OK');
    expect(run).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.hint).toBe('enam');
    expect(calls[0]!.name).toMatch(/^relay-enam-[0-7]$/);
    expect(calls[0]!.call).toMatchObject({ kind: 'run', gatewayId: 'gitflare', model: 'openai/gpt-6-luna', extraHeaders: { 'cf-aig-no-wholesale': 'true' } });
  });

  it('honours MODEL_RELAY_LOCATION_HINT and falls back to enam for unknown values', async () => {
    expect(relayRegions('wnam')).toEqual(['wnam', 'enam']);
    expect(relayRegions(' WEUR ')).toEqual(['weur', 'enam']);
    expect(relayRegions('mars')).toEqual(['enam', 'wnam']);
    expect(relayRegions(undefined)).toEqual(['enam', 'wnam']);
    const { relay, calls } = relayWith({ kind: 'response', status: 200, body: anthropicOk, logId: 'log-1' });
    const message = await inferenceMessage({ AI: { run: vi.fn(), gateway: vi.fn() }, AI_GATEWAY_ID: 'gitflare', MODEL_RELAY: relay, MODEL_RELAY_LOCATION_HINT: 'wnam' }, sonnet, [{ role: 'user', content: 'hi' }], [], 10_000, 16);
    expect(message.text).toBe('OK');
    expect(calls[0]!.hint).toBe('wnam');
    expect(calls[0]!.call).toMatchObject({ kind: 'gateway', gatewayId: 'gitflare', request: { provider: 'anthropic', headers: { 'cf-aig-no-wholesale': 'true' } } });
  });

  it('relays BYOK gateway fetches with the same URL and headers', async () => {
    const route = { workspaceId: 'w1', credential: { provider: 'openai' as const, key: 'sk-workspace-secret-123' }, gateway: { accountId: 'acct', gatewayId: 'gitflare', token: 'gw-token' } };
    const { relay: fetchRelay, calls: fetchCalls } = relayWith({ kind: 'response', status: 200, body: JSON.stringify(completed) });
    await inferenceMessage({ MODEL_RELAY: fetchRelay, modelAccess: async () => route }, luna, [{ role: 'user', content: 'hi' }], [], 10_000, 16);
    expect(fetchCalls[0]!.call).toMatchObject({ kind: 'fetch', url: 'https://gateway.ai.cloudflare.com/v1/acct/gitflare/openai/responses', headers: { Authorization: 'Bearer sk-workspace-secret-123', 'cf-aig-authorization': 'Bearer gw-token', 'cf-aig-no-wholesale': 'true' } });
  });

  it('keeps the in-place call when the relay binding is missing', async () => {
    const run = vi.fn(async () => completed);
    const message = await inferenceMessage({ AI: { run }, AI_GATEWAY_ID: 'gitflare' }, luna, [{ role: 'user', content: 'hi' }], [], 10_000, 16);
    expect(message.text).toBe('OK');
    expect(run).toHaveBeenCalledExactlyOnceWith('openai/gpt-6-luna', expect.anything(), expect.objectContaining({ gateway: { id: 'gitflare' }, extraHeaders: { 'cf-aig-no-wholesale': 'true' } }));
  });

  it('runs Workers AI models in place even with a relay', async () => {
    const run = vi.fn(async () => ({ response: 'OK' }));
    const { relay, calls } = relayWith({ kind: 'value', value: {} });
    await inferenceMessage({ AI: { run }, AI_GATEWAY_ID: 'gitflare', MODEL_RELAY: relay }, workersAi, [{ role: 'user', content: 'hi' }], [], 10_000, 16);
    expect(run).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it('retries a location refusal once from another region', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { relay, calls } = relayWith({ kind: 'response', status: 403, body: refusalBody, colo: 'HKG' }, { kind: 'response', status: 200, body: anthropicOk });
    const message = await inferenceMessage({ AI: { run: vi.fn(), gateway: vi.fn() }, AI_GATEWAY_ID: 'gitflare', MODEL_RELAY: relay }, sonnet, [{ role: 'user', content: 'hi' }], [], 10_000, 16);
    expect(message.text).toBe('OK');
    expect(calls.map((call) => call.hint)).toEqual(['enam', 'wnam']);
    expect(calls[1]!.call).toEqual(calls[0]!.call);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"model_location_refused"'));
  });

  it('raises one location error naming both regions and the colo when the retry is refused too', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { relay, calls } = relayWith({ kind: 'response', status: 403, body: refusalBody, colo: 'HKG', logId: 'log-a' }, { kind: 'response', status: 403, body: refusalBody, colo: 'SIN', logId: 'log-b' });
    const failure = await inferenceMessage({ AI: { run: vi.fn(), gateway: vi.fn() }, AI_GATEWAY_ID: 'gitflare', MODEL_RELAY: relay }, sonnet, [{ role: 'user', content: 'hi' }], [], 10_000, 16).catch((error: unknown) => error);
    expect(calls).toHaveLength(2);
    expect(failure).toBeInstanceOf(ModelLocationError);
    expect(failure).toMatchObject({ status: 403, regions: ['enam', 'wnam'], colo: 'SIN', gatewayLogId: 'log-b' });
    expect((failure as Error).message).toContain('Cloudflare location SIN');
    expect((failure as Error).message).toContain('relay regions enam and wnam');
  });

  it('does not retry ordinary 403s such as a bad key', async () => {
    const { relay, calls } = relayWith({ kind: 'response', status: 403, body: JSON.stringify({ error: { type: 'permission_error', message: 'key lacks access' } }) });
    const failure = await inferenceMessage({ AI: { run: vi.fn(), gateway: vi.fn() }, AI_GATEWAY_ID: 'gitflare', MODEL_RELAY: relay }, sonnet, [{ role: 'user', content: 'hi' }], [], 10_000, 16).catch((error: unknown) => error);
    expect(calls).toHaveLength(1);
    expect(failure).toBeInstanceOf(ModelHttpError);
    expect(failure).not.toBeInstanceOf(ModelLocationError);
  });

  it('reconstructs thrown binding errors with their name and status', async () => {
    const { relay } = relayWith({ kind: 'error', error: { name: 'InferenceUpstreamError', message: 'upstream 502', status: 502 } });
    const failure = await inferenceMessage({ AI: { run: vi.fn() }, AI_GATEWAY_ID: 'gitflare', MODEL_RELAY: relay }, luna, [{ role: 'user', content: 'hi' }], [], 10_000, 16).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'InferenceUpstreamError', message: 'upstream 502', status: 502 });
  });

  it('records the colo where a 403 happened and recognises provider location refusals', async () => {
    const gateway = vi.fn(() => ({ run: async () => new Response(refusalBody, { status: 403, headers: { 'cf-aig-log-id': 'log-1' } }) }));
    const outcome = await performModelCall({ AI: { run: vi.fn(), gateway } }, { kind: 'gateway', gatewayId: 'gitflare', request: { provider: 'anthropic', endpoint: 'v1/messages', headers: {}, query: {} }, timeoutMs: 1000 }, async () => 'HKG');
    expect(outcome).toEqual({ kind: 'response', status: 403, body: refusalBody, logId: 'log-1', colo: 'HKG' });
    expect(isLocationRefusal(outcome)).toBe(true);
    expect(isLocationRefusal({ kind: 'response', status: 403, body: '{"error":{"code":"unsupported_country_region_territory"}}' })).toBe(true);
    expect(isLocationRefusal({ kind: 'response', status: 401, body: refusalBody })).toBe(false);
  });

  it('exposes the relay as a Durable Object that performs the same call', async () => {
    const { ModelRelay } = await import('../src/worker/model-relay');
    const run = vi.fn(async () => completed);
    const relay = new ModelRelay({} as never, { AI: { run } } as never);
    expect(await relay.call({ kind: 'run', gatewayId: 'gitflare', model: 'openai/gpt-6-luna', input: {}, timeoutMs: 1000 })).toEqual({ kind: 'value', value: completed });
    expect(run).toHaveBeenCalledWith('openai/gpt-6-luna', {}, expect.objectContaining({ gateway: { id: 'gitflare' } }));
  });
});

describe('sandbox deadline message', () => {
  it('names the redacted command, the deadline, the elapsed time and the last 20 lines', async () => {
    const { OutputTail, commandSummary, deadlineMessage } = await import('../runner/sandbox');
    const tail = new OutputTail();
    const encoder = new TextEncoder();
    for (let line = 1; line <= 30; line++) tail.add(encoder.encode(`line ${line}${line === 30 ? ' token=abc123' : ''}\n`));
    const message = deadlineMessage(['/bin/bash', '-lc', 'npm install --registry https://user:pass@registry.example/ --token=s3cret'], 300_000, 312_400, tail);
    expect(message).toMatch(/^Sandbox command exceeded its execution deadline: `npm install --registry https:\/\/\[redacted\]@registry\.example\/ --token=\[redacted\]` ran 312\.4 s against a 300 s deadline \(plus 10 s grace\)/);
    expect(message).toContain('Last 20 lines of output:\nline 11\n');
    expect(message).not.toContain('line 10\n');
    expect(message).toContain('line 30 token=[redacted]');
    expect(message).not.toMatch(/pass@|s3cret|abc123/);
    expect(deadlineMessage(['git', 'clone', '--', 'https://a.example/r.git', '/workspace/repo'], 120_000, 130_000, new OutputTail())).toContain('`git clone -- https://a.example/r.git /workspace/repo` ran 130 s against a 120 s deadline (plus 10 s grace) and the runner was stopped.\nThe command produced no output.');
    expect(commandSummary(['node', '-e', 'x'.repeat(400)]).length).toBeLessThanOrEqual(240);
  });
});
