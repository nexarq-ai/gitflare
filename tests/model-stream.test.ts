import { afterEach, describe, expect, it, vi } from 'vitest';
import { inferenceMessage, MODEL_STREAM_IDLE_MS, ModelResponseError, ModelTimeoutError } from '../src/worker/model-adapter';
import { MAX_STREAM_BYTES, performModelCall, streamText, type ModelCall, type ModelCallOutcome } from '../src/worker/model-transport';
import type { ExecutionEnv } from '../src/worker/execution';

const fable = { id: 'anthropic/claude-fable-5.1', label: 'Claude Fable 5.1', source: 'gateway' as const, protocol: 'anthropic' as const };
const encoder = new TextEncoder();

function sse(events: Record<string, unknown>[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } });
}

function split(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += size) parts.push(text.slice(index, index + size));
  return parts;
}

const toolTurn = sse([
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-fable-5-1', content: [], stop_reason: null, usage: { input_tokens: 1200, cache_read_input_tokens: 800, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan the ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'renderer.' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'ping' },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Writing ' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'the shader.' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'shell', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command": "cat > src/gl.ts' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ' <<EOF\\nexport {}\\nEOF"}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 4096 } },
  { type: 'message_stop' },
]);

function envWith(run: ReturnType<typeof vi.fn>): ExecutionEnv {
  return { AI_GATEWAY_ID: 'gitflare', AI: { run } as unknown as ExecutionEnv['AI'] };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('streamed Anthropic answers', () => {
  it('assembles thinking, text, a split tool call and usage from the event stream', async () => {
    const run = vi.fn(async (..._args: unknown[]) => streamOf(split(toolTurn.replace(/\n/g, '\r\n'), 37)));
    const message = await inferenceMessage(envWith(run), fable, [{ role: 'user', content: 'go' }], [], 900_000, 16_384);
    expect(run.mock.calls[0][1]).toMatchObject({ stream: true });
    expect(message.text).toBe('Writing the shader.');
    expect(message.calls).toEqual([{ call_id: 'toolu_1', name: 'shell', arguments: JSON.stringify({ command: 'cat > src/gl.ts <<EOF\nexport {}\nEOF' }) }]);
    expect(message.output[0]).toEqual({ type: 'anthropic_block', block: { type: 'thinking', thinking: 'Plan the renderer.', signature: 'sig-abc' } });
    expect(message.usage).toEqual({ inputTokens: 1200, outputTokens: 4096, cacheReadTokens: 800 });
  });

  it('accepts a plain JSON body when the gateway answers without a stream', async () => {
    const body = JSON.stringify({ type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] });
    const run = vi.fn(async () => streamOf(split(body, 10)));
    expect((await inferenceMessage(envWith(run), fable, [{ role: 'user', content: 'go' }], [], 900_000, 8192)).text).toBe('Done');
  });

  it('reports a stream that ends before message_stop as a transient truncated response', async () => {
    const run = vi.fn(async () => streamOf([toolTurn.slice(0, toolTurn.indexOf('message_delta'))]));
    const failure = await inferenceMessage(envWith(run), fable, [{ role: 'user', content: 'go' }], [], 900_000, 8192).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelResponseError);
    expect(failure).toMatchObject({ code: 'incomplete_response', transient: true, detail: { issue: 'truncated_response', httpStatus: 200 } });
  });

  it('maps an overloaded error event to the provider overload issue', async () => {
    const run = vi.fn(async () => streamOf([sse([{ type: 'message_start', message: { type: 'message', content: [] } }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])]));
    const failure = await inferenceMessage(envWith(run), fable, [{ role: 'user', content: 'go' }], [], 900_000, 8192).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'provider_error', detail: { issue: 'overloaded' } });
  });

  it('stops a stream that sends nothing for the idle limit with a readable timeout', async () => {
    vi.useFakeTimers();
    const silent = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(toolTurn.slice(0, 200))); } });
    const run = vi.fn(async () => silent);
    const settled = inferenceMessage(envWith(run), fable, [{ role: 'user', content: 'go' }], [], 900_000, 8192).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_MS + 1);
    const failure = await settled;
    expect(failure).toBeInstanceOf(ModelTimeoutError);
    expect(failure).toMatchObject({ idle: true, message: 'Claude Fable 5.1 stopped streaming its answer for 120s.' });
    expect((failure as ModelTimeoutError).atStep(3).message).toBe('Claude Fable 5.1 stopped streaming its answer for 120s (step 3). Retry the agent; Gitflare will resume from its last checkpoint.');
  });

  it('keeps reading while chunks keep arriving, past the idle limit in total', async () => {
    vi.useFakeTimers();
    const chunks = split(toolTurn, Math.ceil(toolTurn.length / 3));
    let sent = 0;
    const slow = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, MODEL_STREAM_IDLE_MS - 1000));
        if (sent < chunks.length) controller.enqueue(encoder.encode(chunks[sent++]!));
        else controller.close();
      },
    });
    const settled = inferenceMessage(envWith(vi.fn(async () => slow)), fable, [{ role: 'user', content: 'go' }], [], 900_000, 8192);
    await vi.advanceTimersByTimeAsync((chunks.length + 1) * MODEL_STREAM_IDLE_MS);
    expect((await settled).calls).toHaveLength(1);
  });
});

describe('stream transport', () => {
  it('returns the response body as a stream for a successful streamed gateway call', async () => {
    const gatewayRun = vi.fn(async () => new Response(streamOf([toolTurn]), { status: 200, headers: { 'cf-aig-log-id': 'log-9' } }));
    const call: ModelCall = { kind: 'gateway', gatewayId: 'gitflare', request: { provider: 'anthropic', endpoint: 'v1/messages', headers: {}, query: { stream: true } }, timeoutMs: 600_000, stream: true };
    const outcome = await performModelCall({ AI: { run: vi.fn(), gateway: () => ({ run: gatewayRun }) } }, call);
    expect(outcome).toMatchObject({ kind: 'stream', status: 200, logId: 'log-9' });
    let text = '';
    for await (const chunk of streamText((outcome as Extract<ModelCallOutcome, { kind: 'stream' }>).body, 1000, 10_000)) text += chunk;
    expect(text).toBe(toolTurn);
  });

  it('reads a rejected streamed call as an ordinary response so refusals stay readable', async () => {
    const gatewayRun = vi.fn(async () => new Response('{"error":{"message":"Request not allowed"}}', { status: 403 }));
    const call: ModelCall = { kind: 'gateway', gatewayId: 'gitflare', request: { provider: 'anthropic', endpoint: 'v1/messages', headers: {}, query: {} }, timeoutMs: 600_000, stream: true };
    const outcome = await performModelCall({ AI: { run: vi.fn(), gateway: () => ({ run: gatewayRun }) } }, call, async () => 'IAD');
    expect(outcome).toMatchObject({ kind: 'response', status: 403, colo: 'IAD' });
  });

  it('relays a streamed run through the relay object', async () => {
    const relayCall = vi.fn(async (_call: ModelCall): Promise<ModelCallOutcome> => ({ kind: 'stream', status: 200, body: streamOf([toolTurn]) }));
    const relay = { idFromName: vi.fn((name: string) => name as unknown as DurableObjectId), get: vi.fn(() => ({ call: relayCall })) };
    const message = await inferenceMessage({ AI: { run: vi.fn() }, AI_GATEWAY_ID: 'gitflare', MODEL_RELAY: relay }, fable, [{ role: 'user', content: 'go' }], [], 900_000, 8192);
    expect(message.calls).toHaveLength(1);
    expect(relayCall.mock.calls[0]![0]).toMatchObject({ kind: 'run', stream: true, model: fable.id, input: { stream: true } });
  });

  it('refuses a stream larger than the size limit', async () => {
    const big = new Uint8Array(MAX_STREAM_BYTES + 1);
    const reading = (async () => { for await (const chunk of streamText(new ReadableStream({ start(controller) { controller.enqueue(big); controller.close(); } }), 1000, 10_000)) void chunk; })();
    await expect(reading).rejects.toThrow('exceeded 8 MiB');
  });
});
