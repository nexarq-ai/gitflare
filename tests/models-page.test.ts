import { describe, expect, it } from 'vitest';
import type { AiKeysSnapshot, ModelConnection } from '../src/shared/types';
import { inferenceRoute, modelStatus } from '../src/ui/models-data';
import { effectiveDefaultModel } from '../src/worker/model-config';

const sonnet: ModelConnection = { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5', source: 'gateway', protocol: 'anthropic' };
const luna: ModelConnection = { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna', source: 'gateway', protocol: 'responses' };
const llama: ModelConnection = { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama', source: 'workers-ai', protocol: 'workers-ai' };
const keys = (patch: Partial<AiKeysSnapshot>): AiKeysSnapshot => ({ providers: [{ id: 'anthropic', label: 'Anthropic' }, { id: 'openai', label: 'OpenAI' }], keys: [], gateway: null, operatorAccess: false, ready: false, ...patch });
const workers = { workersAI: { enabled: true } };

describe('AI models page', () => {
  it('says whether each model is ready, needs a key or is not verified', () => {
    expect(modelStatus(sonnet, keys({ operatorAccess: true }), workers)).toBe('ready');
    expect(modelStatus(sonnet, keys({}), workers)).toBe('needs-key');
    const withKey = keys({ keys: [{ provider: 'anthropic', last4: 'abcd', addedBy: 'u', addedAt: '2026-10-18T00:00:00Z', verifiedModel: sonnet.id }] });
    expect(modelStatus(sonnet, withKey, workers)).toBe('ready');
    expect(modelStatus({ ...sonnet, id: 'anthropic/claude-opus-5-5' }, withKey, workers)).toBe('unverified');
    expect(modelStatus(luna, withKey, workers)).toBe('needs-key');
    expect(modelStatus(luna, keys({ gateway: { accountId: 'a', gatewayId: 'mine', authenticated: false, updatedBy: 'u', updatedAt: '' } }), workers)).toBe('unverified');
    expect(modelStatus({ ...luna, verification: { status: 'failed', checkedAt: '', detail: '' } }, keys({ operatorAccess: true }), workers)).toBe('failed');
    expect(modelStatus(llama, null, { workersAI: { enabled: false } })).toBe('unavailable');
  });

  it('names where inference goes in one line', () => {
    expect(inferenceRoute(keys({ operatorAccess: true }))?.text).toBe("Inference goes through Gitflare's AI Gateway. No key needed.");
    expect(inferenceRoute(keys({ gateway: { accountId: 'a', gatewayId: 'acme-gw', authenticated: true, updatedBy: 'u', updatedAt: '' } }))?.text).toContain('your AI Gateway, acme-gw');
    expect(inferenceRoute(keys({ keys: [{ provider: 'openai', last4: '1234', addedBy: 'u', addedAt: '', verifiedModel: luna.id }] }))?.text).toBe("Inference uses your OpenAI key through Gitflare's AI Gateway.");
    expect(inferenceRoute(keys({}))?.tone).toBe('warn');
  });

  it('falls back to the platform default when the stored default is gone', () => {
    expect(effectiveDefaultModel([sonnet, luna], luna.id)).toBe(luna.id);
    expect(effectiveDefaultModel([sonnet, luna], 'custom/removed')).toBe(sonnet.id);
    expect(effectiveDefaultModel([luna], null)).toBe(luna.id);
  });
});
