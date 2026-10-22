import { describe, expect, it, vi } from 'vitest';
import type { Mission, ModelConnection } from '../src/shared/types';
import { assertPinnedModel, defaultModelConnections, modelIdentifier, pinMissionModels, resolveModelConnection, validateModelConnection, verifyModelConnection, WORKERS_AI_CATALOG } from '../src/worker/model-config';
import { chatMessages, classifyModelFailure, inferenceMessage, modelOutputShape, ModelResponseError, normalizeModelMessage, workersAIMessages } from '../src/worker/model-adapter';
import { runAgentLoop } from '../src/worker/execution';
import { missionInput } from '../src/worker/domain';

const chat: ModelConnection = { id: 'custom-acme/coding-model', label: 'Coding model', source: 'gateway', protocol: 'chat' };
const workers = WORKERS_AI_CATALOG[0]!;
const task = { name: 'Implementation', role: 'Implementation', task: 'Implement this requested feature.' };

function mission(): Mission {
  return { id: 'mission', repositoryId: 'repository', title: 'Change', prompt: 'Make the requested change', status: 'draft', baseSha: 'a'.repeat(40), candidateSha: null, epoch: 0, runs: [{ id: 'run', ...task, model: chat.id, status: 'queued', changedFiles: [] }], checks: [], changes: [], events: [], createdAt: '', updatedAt: '' };
}

describe('owner model registry', () => {
  it.each(['https://provider.example/model', 'openai/../secret', 'openai//model', 'openai/model?key=secret', 'openai/model#secret', 'dynamic/fallback', '@cf/provider/../model', 'Bearer secret', 'openai/model\nkey'])('rejects unsafe identifier %s', id => {
    expect(() => modelIdentifier(id)).toThrow('INVALID_MODEL');
  });
  it('accepts a configured compatible model without restricting provider names', () => {
    expect(validateModelConnection(chat)).toEqual(chat);
    expect(resolveModelConnection([chat], chat.id)).toEqual(chat);
    expect(() => resolveModelConnection(defaultModelConnections(), chat.id)).toThrow('MODEL_NOT_CONFIGURED');
    expect(validateModelConnection({ ...chat, id: 'openrouter/anthropic/claude-sonnet' }).id).toBe('openrouter/anthropic/claude-sonnet');
  });
  it('rejects credential fields, unsupported protocols and undocumented native models', () => {
    expect(() => validateModelConnection({ ...chat, apiKey: 'secret' })).toThrow('INVALID_MODEL');
    expect(() => validateModelConnection({ ...chat, protocol: 'anthropic' })).toThrow('INVALID_MODEL');
    expect(() => validateModelConnection({ ...chat, protocol: 'responses' })).toThrow('INVALID_MODEL');
    expect(() => validateModelConnection({ ...workers, id: '@cf/unknown/model' })).toThrow('INVALID_MODEL');
  });
  it('pins the chosen model and fails closed after removal or transport change', () => {
    const original = mission();
    const pinned = pinMissionModels(original, [chat]);
    expect(original.runs[0]!.modelConfig).toBeUndefined();
    expect(pinned.runs[0]!.modelConfig).toEqual(chat);
    expect(() => pinMissionModels(pinned, [])).toThrow('MODEL_NOT_CONFIGURED');
    expect(() => assertPinnedModel([{ ...chat, protocol: 'responses', id: 'openai/custom' }], { ...chat, id: 'openai/custom' })).toThrow('MODEL_CONNECTION_CHANGED');
  });
  it('defaults omitted legacy choices to Claude Sonnet 5.5 and bypasses AI for deterministic skills', () => {
    const legacy = mission();
    delete legacy.runs[0]!.model;
    expect(pinMissionModels(legacy, defaultModelConnections()).runs[0]!.model).toBe('anthropic/claude-sonnet-5-5');
    const skill = { ...legacy, skillChange: { action: 'create' as const, path: 'docs/skills/a/SKILL.md', content: 'text', baseSha: 'a'.repeat(40) } };
    expect(pinMissionModels(skill, [])).toBe(skill);
  });
  it('validates and preserves a per-agent identifier from UI/MCP authoring', () => {
    expect(missionInput({ title: 'Change', repositoryId: 'repository', prompt: 'Make the requested change', tasks: [{ ...task, model: chat.id }] }).tasks?.[0]?.model).toBe(chat.id);
    expect(() => missionInput({ title: 'Change', repositoryId: 'repository', prompt: 'Make the requested change', tasks: [{ ...task, model: 'https://provider.example/model' }] })).toThrow('INVALID_MODEL');
  });
});

describe('provider response boundaries', () => {
  it('normalizes chat function calls and rejects incomplete outputs', () => {
    const body = { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'shell', arguments: '{"command":"pwd"}' } }] } }] };
    expect(normalizeModelMessage(body, 'chat').calls).toEqual([{ call_id: 'call-1', name: 'shell', arguments: '{"command":"pwd"}' }]);
    expect(() => normalizeModelMessage({ choices: [{ ...body.choices[0], finish_reason: 'length' }] }, 'chat')).toThrow('completed response');
    expect(() => normalizeModelMessage({ response: '', tool_calls: [{ name: 'shell', arguments: ['pwd'] }] }, 'workers-ai')).toThrow('invalid function call');
  });
  it('rejects more than four tool calls and duplicate call IDs before execution', () => {
    const call = { type: 'function_call', call_id: 'same', name: 'shell', arguments: '{}' };
    expect(() => normalizeModelMessage({ status: 'completed', output: Array(5).fill(call) }, 'responses')).toThrow('per-turn tool limit');
    expect(() => normalizeModelMessage({ status: 'completed', output: [call, call] }, 'responses')).toThrow('invalid function call');
  });
  it('preserves matching tool call IDs in chat and documented native tool names', () => {
    const context = [{ role: 'system', content: 'Work' }, { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{"command":"pwd"}' }, { type: 'function_call_output', call_id: 'call-1', output: '{"stdout":"/workspace/repo"}' }];
    expect(chatMessages(context)[1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'shell', arguments: '{"command":"pwd"}' } }] });
    expect(chatMessages(context)[2]).toEqual({ role: 'tool', tool_call_id: 'call-1', content: '{"stdout":"/workspace/repo"}' });
    expect(workersAIMessages(context)[2]).toEqual({ role: 'tool', name: 'shell', content: '{"stdout":"/workspace/repo"}' });
    expect(workersAIMessages(context).every(message => typeof message.content === 'string')).toBe(true);
  });
});

describe('gateway-only inference', () => {
  it('does not call any model without a Gateway connection', async () => {
    const run = vi.fn();
    await expect(inferenceMessage({ AI: { run } }, workers, [], [], 1000)).rejects.toThrow('Gateway connection');
    expect(run).not.toHaveBeenCalled();
  });
  it('bounds verification, routes Workers AI through the Gateway and retains no provider response', async () => {
    const run = vi.fn(async (_model: string, _input: Record<string, unknown>) => ({ response: 'OK' }));
    const result = await verifyModelConnection({ AI: { run }, AI_GATEWAY_ID: 'gitflare' }, workers);
    expect(result.verification?.status).toBe('verified');
    expect(run).toHaveBeenCalledWith(workers.id, expect.objectContaining({ max_tokens: 16 }), expect.objectContaining({ gateway: { id: 'gitflare' }, signal: expect.any(AbortSignal) }));
    expect(run.mock.calls[0]?.[1]).not.toHaveProperty('tools');
    expect(JSON.stringify(result)).not.toContain('"OK"');
  });
  it('reports the redacted provider error and never retries or substitutes models', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secret = 'sk-ant-api03-PRIVATEKEYMATERIAL';
    const token = 'A'.repeat(40);
    const run = vi.fn(async () => { throw Object.assign(new Error(`5007: No such model ${chat.id} (key ${secret}, token ${token})`), { name: 'InferenceUpstreamError', code: 5007 }); });
    const result = await verifyModelConnection({ AI: { run }, AI_GATEWAY_ID: 'gitflare' }, chat);
    expect(result.verification?.status).toBe('failed');
    expect(result.verification?.detail).toContain(`The AI binding rejected inference (code 5007): 5007: No such model ${chat.id} (key sk-[redacted], token [redacted]).`);
    expect(JSON.stringify(result)).not.toContain('PRIVATEKEYMATERIAL');
    expect(JSON.stringify(result)).not.toContain(token);
    expect(run).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'model_verification_failed', model: chat.id, operation: 'inference', errorName: 'InferenceUpstreamError', providerCode: 5007, providerMessage: `5007: No such model ${chat.id} (key sk-[redacted], token [redacted])` }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATEKEYMATERIAL');
    log.mockRestore();
  });
  it('classifies only safe names, numeric provider state and known output errors', () => {
    expect(classifyModelFailure({ name: 'InferenceUpstreamError', status: 429, code: 3040, message: 'private-key-material', body: 'private-response' })).toEqual({ operation: 'inference', errorName: 'InferenceUpstreamError', providerStatus: 429, providerCode: 3040 });
    expect(classifyModelFailure({ name: 'private-key-material', status: 'private', code: 'private' })).toEqual({ operation: 'inference', errorName: 'Error' });
    expect(classifyModelFailure(new ModelResponseError('empty_response', 'private-response'))).toEqual({ operation: 'normalize', errorName: 'ModelResponseError', code: 'empty_response' });
  });
  it('describes rejected native output without exposing content or arbitrary keys', () => {
    const shape = modelOutputShape({ response: '', tool_calls: [], usage: { total_tokens: 50 }, secret: 'private-key-material' });
    expect(shape).toEqual({ bodyType: 'object', knownKeys: ['response', 'tool_calls', 'usage'], responseType: 'string', responseLength: 0, toolCallsPresent: true, toolCallsCount: 0, choicesCount: -1, outputCount: -1 });
    expect(JSON.stringify(shape)).not.toContain('private-key-material');
    expect(JSON.stringify(modelOutputShape({ response: 'private-response', providerKey: 'secret' }))).not.toContain('private-response');
    expect(() => normalizeModelMessage({ response: '', tool_calls: [] }, 'workers-ai')).toThrow('no usable response');
    expect(() => normalizeModelMessage({}, 'workers-ai')).toThrow('no usable response');
  });
  it('records output-shape failure honestly with a safe diagnostic', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await verifyModelConnection({ AI: { run: vi.fn(async () => ({})) }, AI_GATEWAY_ID: 'gitflare' }, workers);
    expect(result.verification).toMatchObject({ status: 'failed', detail: expect.stringContaining('empty_response') });
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'model_verification_failed', model: workers.id, operation: 'normalize', errorName: 'ModelResponseError', code: 'empty_response' }));
    log.mockRestore();
  });
  it.each([workers, chat])('supports two bounded turns with $protocol transport and pinned model selection', async model => {
    const toolReply = model.protocol === 'workers-ai' ? { response: '', tool_calls: [{ name: 'shell', arguments: { command: 'pwd' } }] } : { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'tool-1', function: { name: 'shell', arguments: '{"command":"pwd"}' } }] } }] };
    const done = model.protocol === 'workers-ai' ? { response: 'Finished' } : { choices: [{ finish_reason: 'stop', message: { content: 'Finished' } }] };
    const run = vi.fn().mockResolvedValueOnce(toolReply).mockResolvedValueOnce(done);
    const check = vi.fn(async () => {});
    const command = vi.fn(async () => ({ exitCode: 0, stdout: '/workspace/repo', stderr: '' }));
    expect(await runAgentLoop({ AI: { run }, AI_GATEWAY_ID: 'gitflare', assertModelAllowed: check }, { prepare: vi.fn(), destroy: vi.fn(), command }, 'Do this work', async () => true, async () => {}, model)).toBe('Finished');
    expect(command).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.every(([id, , options]) => id === model.id && options.gateway.id === 'gitflare')).toBe(true);
    const followup = run.mock.calls[1]![1] as { messages: { role: string; content?: string; name?: string }[] };
    expect(followup.messages.some(message => message.role === 'tool' && message.content?.includes('/workspace/repo'))).toBe(true);
    if (model.protocol === 'workers-ai') expect(followup.messages.find(message => message.role === 'tool')?.name).toBe('shell');
  });
  it('honors model revocation before a second inference call', async () => {
    const run = vi.fn(async () => ({ response: '', tool_calls: [{ name: 'shell', arguments: { command: 'pwd' } }] }));
    const check = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('model revoked'));
    const command = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
    await expect(runAgentLoop({ AI: { run }, AI_GATEWAY_ID: 'gitflare', assertModelAllowed: check }, { prepare: vi.fn(), destroy: vi.fn(), command }, 'Work', async () => true, async () => {}, workers)).rejects.toThrow('model revoked');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('strict native final-summary recovery', () => {
  const tool = { response: '', tool_calls: [{ name: 'shell', arguments: { command: 'pwd' } }] };
  const empty = { response: '', tool_calls: [] };
  const done = { response: 'Edited the assigned file; trusted checks are pending.' };
  function fixture(exitCode = 0) {
    const run = vi.fn().mockResolvedValueOnce(tool).mockResolvedValueOnce(empty).mockResolvedValueOnce(done);
    const command = vi.fn(async () => ({ exitCode, stdout: 'tool evidence', stderr: '' }));
    const assertModelAllowed = vi.fn(async () => {});
    const env = { AI: { run }, AI_GATEWAY_ID: 'gitflare', assertModelAllowed };
    const sandbox = { prepare: vi.fn(), destroy: vi.fn(), command };
    const loop = (active = async () => true) => runAgentLoop(env, sandbox, 'Make the assigned edit', active, async () => {}, workers);
    return { run, command, env, loop, assertModelAllowed };
  }
  it('requires actual same-model text after exact empty native output and a successful tool', async () => {
    const f = fixture();
    expect(await f.loop()).toBe(done.response);
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(f.command).toHaveBeenCalledTimes(1);
    expect(f.assertModelAllowed).toHaveBeenCalledTimes(3);
    expect(f.run.mock.calls.every(([id, , options]) => id === workers.id && options.gateway.id === 'gitflare')).toBe(true);
    expect(f.run.mock.calls[2]![1]).not.toHaveProperty('tools');
    expect(f.run.mock.calls[2]![1].messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('Do not claim completion') });
  });
  it.each([{}, { response: '' }, { response: ' ', tool_calls: [] }, { response: '', tool_calls: null }, { response: '', tool_calls: [], errors: ['hidden'] }, { response: '', tool_calls: [], success: false }, { response: '', tool_calls: [], usage: 'invalid' }])('never recovers malformed or ambiguous output %j', async body => {
    const f = fixture();
    f.run.mockReset().mockResolvedValueOnce(tool).mockResolvedValueOnce(body).mockResolvedValueOnce(done);
    await expect(f.loop()).rejects.toThrow();
    expect(f.run).toHaveBeenCalledTimes(2);
  });
  it('rejects exact empty native output on the first turn', async () => {
    const f = fixture();
    f.run.mockReset().mockResolvedValueOnce(empty).mockResolvedValueOnce(done);
    await expect(f.loop()).rejects.toThrow('no usable response');
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.command).not.toHaveBeenCalled();
  });
  it('rejects recovery after a failed shell command', async () => {
    const f = fixture(1);
    await expect(f.loop()).rejects.toThrow('no usable response');
    expect(f.run).toHaveBeenCalledTimes(2);
  });
  it.each([empty, tool, { response: '' }, { error: 'hidden' }])('requires a nonempty tool-free final summary %j', async summary => {
    const f = fixture();
    f.run.mockReset().mockResolvedValueOnce(tool).mockResolvedValueOnce(empty).mockResolvedValueOnce(summary);
    await expect(f.loop()).rejects.toThrow();
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(f.command).toHaveBeenCalledTimes(1);
    expect(f.run.mock.calls.every(([id]) => id === workers.id)).toBe(true);
  });
  it('rechecks owner registry approval before final inference', async () => {
    const f = fixture();
    f.assertModelAllowed.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('model revoked'));
    await expect(f.loop()).rejects.toThrow('model revoked');
    expect(f.run).toHaveBeenCalledTimes(2);
  });
  it('rechecks cancellation before final inference', async () => {
    const f = fixture();
    let active = true;
    f.run.mockReset().mockResolvedValueOnce(tool).mockImplementationOnce(async () => { active = false; return empty; }).mockResolvedValueOnce(done);
    await expect(f.loop(async () => active)).rejects.toThrow('cancelled');
    expect(f.run).toHaveBeenCalledTimes(2);
  });
  it('counts final inference within the original sixteen-call ceiling', async () => {
    const f = fixture();
    f.run.mockReset();
    for (let i = 0; i < 15; i++) f.run.mockResolvedValueOnce(tool);
    f.run.mockResolvedValueOnce(empty).mockResolvedValueOnce(done);
    await expect(f.loop()).rejects.toThrow('no usable response');
    expect(f.run).toHaveBeenCalledTimes(16);
    expect(f.command).toHaveBeenCalledTimes(15);
  });
  it('requires remaining time before final inference', async () => {
    const f = fixture();
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    f.run.mockReset().mockResolvedValueOnce(tool).mockImplementationOnce(async () => { now = 600_001; return empty; }).mockResolvedValueOnce(done);
    try {
      await expect(f.loop()).rejects.toThrow('ten-minute budget');
      expect(f.run).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); }
  });
});
