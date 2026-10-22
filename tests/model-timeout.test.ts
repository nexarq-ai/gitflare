import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgentLoop, MIN_MODEL_RETRY_MS, type ExecutionEnv, type SandboxRunner } from '../src/worker/execution';
import { classifyModelFailure, inferenceMessage, MODEL_CALL_CAP_MS, MODEL_CALL_FLOOR_MS, MODEL_STREAM_CAP_MS, modelCallTimeoutMs, ModelTimeoutError } from '../src/worker/model-adapter';
import { STREAM_ABORT_GRACE_MS } from '../src/worker/model-transport';

const fable = { id: 'anthropic/claude-fable-5.1', label: 'Claude Fable 5.1', source: 'gateway' as const, protocol: 'anthropic' as const };
const opus = { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5', source: 'gateway' as const, protocol: 'anthropic' as const };
const opusChat = { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5', source: 'gateway' as const, protocol: 'chat' as const };
const luna = { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna', source: 'gateway' as const, protocol: 'responses' as const };
const done = { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Wrote the renderer' }] };
const sandbox: SandboxRunner = { prepare: vi.fn(), destroy: vi.fn(), command: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })) };
const timedOut = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

function envWith(run: ReturnType<typeof vi.fn>): ExecutionEnv {
  return { AI_GATEWAY_ID: 'gitflare', AI: { run } as unknown as ExecutionEnv['AI'] };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('model call timeout', () => {
  it('gives streamed Fable and Opus 5.x answers up to 600 s and other models up to 300 or 180 s, scaled by output tokens', () => {
    expect(modelCallTimeoutMs(fable, 8192, 900_000)).toBe(MODEL_STREAM_CAP_MS);
    expect(modelCallTimeoutMs(opus, 16_384, 900_000)).toBe(600_000);
    expect(modelCallTimeoutMs(opusChat, 8192, 900_000)).toBe(205_000);
    expect(modelCallTimeoutMs(opusChat, 16_384, 900_000)).toBe(MODEL_CALL_CAP_MS.long);
    expect(modelCallTimeoutMs(luna, 8192, 600_000)).toBe(123_000);
    expect(modelCallTimeoutMs(luna, 16_384, 600_000)).toBe(MODEL_CALL_CAP_MS.standard);
    expect(modelCallTimeoutMs(luna, 16, 600_000)).toBe(MODEL_CALL_FLOOR_MS);
  });

  it('never exceeds the remaining run budget', () => {
    expect(modelCallTimeoutMs(fable, 16_384, 42_000)).toBe(42_000);
    expect(modelCallTimeoutMs(luna, 4096, 1)).toBe(1);
  });

  it('asks for a stream and gives the gateway call the stream cap plus the abort grace', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const run = vi.fn(async (..._args: unknown[]) => done);
    await inferenceMessage(envWith(run), fable, [{ role: 'user', content: 'go' }], [], 900_000, 16_384);
    expect(timeout).toHaveBeenCalledWith(MODEL_STREAM_CAP_MS + STREAM_ABORT_GRACE_MS);
    expect(run.mock.calls[0][1]).toMatchObject({ stream: true });
  });

  it('reports a timed-out call as a named model timeout', async () => {
    const run = vi.fn(async () => { throw timedOut(); });
    const failure = await inferenceMessage(envWith(run), opusChat, [{ role: 'user', content: 'go' }], [], 600_000, 8192).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelTimeoutError);
    expect(failure).toMatchObject({ timeoutMs: 205_000, message: 'Claude Opus 5.5 did not answer within 205s.' });
    expect(classifyModelFailure(failure)).toEqual({ operation: 'inference', errorName: 'TimeoutError' });
  });
});

describe('agent loop model timeout retries', () => {
  it('retries a timed-out call on the same pinned model and records the retry', async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockRejectedValueOnce(timedOut()).mockResolvedValue(done);
    const notices: string[] = [];
    const outcome = runAgentLoop(envWith(run), sandbox, 'Write the renderer', async () => true, async () => {}, fable, { onModelRetry: async (notice) => { notices.push(notice); } });
    await vi.runAllTimersAsync();
    expect(await outcome).toBe('Wrote the renderer');
    expect(run).toHaveBeenCalledTimes(2);
    expect(new Set(run.mock.calls.map(([model]) => model))).toEqual(new Set([fable.id]));
    expect(notices).toEqual(['Model call timed out after 600s; retrying (1/2)']);
  });

  it('retries an overloaded 529 on the same model', async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Overloaded'), { status: 529 })).mockResolvedValue(done);
    const notices: string[] = [];
    const outcome = runAgentLoop(envWith(run), sandbox, 'Write the renderer', async () => true, async () => {}, fable, { onModelRetry: async (notice) => { notices.push(notice); } });
    await vi.runAllTimersAsync();
    expect(await outcome).toBe('Wrote the renderer');
    expect(notices).toEqual(['Claude Fable 5.1 is overloaded; retrying (1/2)']);
  });

  it('fails with a readable error after two timed-out retries', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => { throw timedOut(); });
    const notices: string[] = [];
    const outcome = runAgentLoop(envWith(run), sandbox, 'Write the renderer', async () => true, async () => {}, fable, { onModelRetry: async (notice) => { notices.push(notice); } });
    const settled = outcome.catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const failure = await settled;
    expect(failure).toBeInstanceOf(ModelTimeoutError);
    expect((failure as Error).message).toBe('Claude Fable 5.1 did not answer within 597s (step 1). Retry the agent; Gitflare will resume from its last checkpoint.');
    expect((failure as Error).message).not.toContain('aborted due to timeout');
    expect(run).toHaveBeenCalledTimes(3);
    expect(notices).toEqual(['Model call timed out after 600s; retrying (1/2)', 'Model call timed out after 599s; retrying (2/2)']);
  });

  it('does not retry a timeout when too little run budget remains', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const run = vi.fn(async () => { now = 600_000 - MIN_MODEL_RETRY_MS + 1; throw timedOut(); });
    await expect(runAgentLoop(envWith(run), sandbox, 'Write the renderer', async () => true, async () => {}, fable)).rejects.toThrow('(step 1). Retry the agent');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
