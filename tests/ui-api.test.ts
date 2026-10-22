import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, RequestError } from '../src/ui/api';

afterEach(() => { vi.unstubAllGlobals(); });

describe('UI request failures', () => {
  it('turns a read timeout into a retryable error with a readable message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }));
    const failure = await request('/api/workspace').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RequestError);
    expect(failure).toMatchObject({ status: 0, code: 'TIMEOUT', message: 'Gitflare did not answer within 30 seconds. Try again.' });
  });

  it('reports an unreachable server separately and passes other failures through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(request('/api/workspace')).rejects.toMatchObject({ code: 'NETWORK' });
    const aborted = new DOMException('Aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn(async () => { throw aborted; }));
    await expect(request('/api/workspace')).rejects.toBe(aborted);
  });
});
