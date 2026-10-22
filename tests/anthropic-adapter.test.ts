import { describe, expect, it, vi } from 'vitest';
import { anthropicInput, anthropicOutput, catalogModelId, nativeModelId } from '../src/worker/anthropic-adapter';
import { providerRequest } from '../src/worker/gateway-routing';
import { inferenceMessage } from '../src/worker/model-adapter';
import { validateModelConnection } from '../src/worker/model-config';

const model = { id: 'anthropic/claude-sonnet-5', label: 'Claude', source: 'gateway' as const, protocol: 'anthropic' as const };
const text = { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: 'OK' }] };
const call = { type: 'tool_use', id: 'call_1', name: 'shell', input: { command: 'git status' } };

describe('Anthropic Messages through Gateway', () => {
  it('uses adaptive thinking for Claude 5 models and disables it for older ones', () => {
    for (const id of ['anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5', 'claude-sonnet-5-5']) expect(anthropicInput([{ role: 'user', content: 'Hi' }], [], 64, id)).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
    const older = anthropicInput([{ role: 'user', content: 'Hi' }], [], 64, 'anthropic/claude-haiku-4-5');
    expect(older).toMatchObject({ thinking: { type: 'disabled' } });
    expect(older).not.toHaveProperty('output_config');
  });
  it('preserves system instructions and complete tool replay with original IDs', () => {
    const result = anthropicInput([
      { role: 'system', content: 'Isolation rules' }, { role: 'developer', content: 'Task rules' },
      { role: 'user', content: 'Inspect code' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Inspecting' }] },
      { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{bad' },
      { type: 'function_call_output', call_id: 'call_1', output: 'Invalid tool input' },
    ], [{ type: 'function', name: 'shell', description: 'Read code', parameters: { type: 'object' } }], 128);
    expect(result).toMatchObject({ system: 'Isolation rules\nTask rules', max_tokens: 128, thinking: { type: 'disabled' }, tools: [{ name: 'shell', input_schema: { type: 'object' } }] });
    expect(result).not.toHaveProperty('model');
    expect(result.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Inspect code' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Inspecting' }, { type: 'tool_use', id: 'call_1', name: 'shell', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Invalid tool input' }] },
    ]);
  });
  it('normalizes native text and tool calls without changing their IDs', () => {
    expect(anthropicOutput(text).text).toBe('OK');
    const result = anthropicOutput({ type: 'message', stop_reason: 'tool_use', content: [call] });
    expect(result.calls).toEqual([{ call_id: 'call_1', name: 'shell', arguments: '{"command":"git status"}' }]);
    expect(result.output).toEqual([{ type: 'function_call', ...result.calls[0] }]);
  });
  it.each(['max_tokens', 'pause_turn', 'refusal', null])('rejects unfinished output: %s', stop_reason => {
    expect(() => anthropicOutput({ ...text, stop_reason })).toThrow();
  });
  it('rejects missing, duplicate, excessive or malformed tool calls', () => {
    for (const content of [[call, call], [{ ...call, id: '' }], [{ ...call, input: [] }], Array.from({ length: 5 }, (_, i) => ({ ...call, id: `call_${i}` })), []]) {
      expect(() => anthropicOutput({ type: 'message', stop_reason: 'tool_use', content })).toThrow();
    }
    expect(() => anthropicOutput({ ...text, content: [call] })).toThrow();
    expect(() => anthropicOutput({ ...text, content: [{ type: 'text', text: '' }] })).toThrow();
  });
  it('restricts native transport to Anthropic gateway models', () => {
    expect(validateModelConnection(model)).toEqual(model);
    expect(() => validateModelConnection({ ...model, id: 'openai/gpt-4.1-mini' })).toThrow('INVALID_MODEL');
    expect(() => validateModelConnection({ ...model, source: 'workers-ai' })).toThrow('INVALID_MODEL');
  });
  it('pins Gateway and prevents Unified Billing fallback on the inference request', async () => {
    const run = vi.fn().mockResolvedValue(text);
    const result = await inferenceMessage({ AI: { run }, AI_GATEWAY_ID: 'gitflare' }, model, [{ role: 'user', content: 'Hello' }], [], 1000, 128);
    expect(result.text).toBe('OK');
    expect(run).toHaveBeenCalledExactlyOnceWith(model.id, expect.objectContaining({ max_tokens: 128 }), expect.objectContaining({ gateway: { id: 'gitflare' }, extraHeaders: { 'cf-aig-no-wholesale': 'true' } }));
  });
  it('names Claude versions with dots for the AI binding catalog and dashes for the Messages API', () => {
    expect(['anthropic/claude-opus-5-5', 'anthropic/claude-opus-5.5'].map(catalogModelId)).toEqual(['anthropic/claude-opus-5.5', 'anthropic/claude-opus-5.5']);
    expect(['anthropic/claude-fable-5.1', 'anthropic/claude-sonnet-5', 'anthropic/claude-haiku-4-5-20251001', 'openai/gpt-6-luna'].map(catalogModelId)).toEqual(['anthropic/claude-fable-5.1', 'anthropic/claude-sonnet-5', 'anthropic/claude-haiku-4-5-20251001', 'openai/gpt-6-luna']);
    expect(['anthropic/claude-opus-5-5', 'anthropic/claude-fable-5.1', 'claude-sonnet-5', 'anthropic/claude-haiku-4-5-20251001'].map(nativeModelId)).toEqual(['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);
    const opus = { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5', source: 'gateway' as const, protocol: 'anthropic' as const };
    expect(providerRequest({ ...opus, id: 'anthropic/claude-opus-5.5' }, {}, { workspaceId: 'w1', credential: { provider: 'anthropic', key: 'k' } }).body.model).toBe('claude-opus-5-5');
  });
  it('sends Opus 5.5 to the AI binding under its catalog name and keeps the configured id pinned', async () => {
    const opus = { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5', source: 'gateway' as const, protocol: 'anthropic' as const };
    const run = vi.fn().mockResolvedValue(text);
    expect((await inferenceMessage({ AI: { run }, AI_GATEWAY_ID: 'gitflare' }, opus, [{ role: 'user', content: 'Hello' }], [], 1000, 16)).text).toBe('OK');
    expect(run).toHaveBeenCalledExactlyOnceWith('anthropic/claude-opus-5.5', expect.objectContaining({ max_tokens: 16, thinking: { type: 'adaptive' }, stream: true }), expect.objectContaining({ gateway: { id: 'gitflare' }, extraHeaders: { 'cf-aig-no-wholesale': 'true' } }));
  });
});
