import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, RequestError } from '../src/ui/api';
import { confirmSession, retryDelay, SESSION_CHECK_EVENT, sessionStatus, transientFailure } from '../src/ui/session-health';

afterEach(() => { vi.unstubAllGlobals(); });

const reply = (status: number, body?: unknown) => async () => body === undefined ? new Response('upstream unavailable', { status }) : Response.json(body, { status });

describe('client session health', () => {
  it('signs out only on a definitive AUTH_REQUIRED from the session endpoint', async () => {
    expect(await sessionStatus(vi.fn(reply(200, { authenticated: true })))).toBe('signed-in');
    expect(await sessionStatus(vi.fn(reply(401, { error: { code: 'AUTH_REQUIRED', message: 'Sign in to Gitflare.' } })))).toBe('signed-out');
    expect(await sessionStatus(vi.fn(reply(401)))).toBe('unreachable');
    expect(await sessionStatus(vi.fn(reply(401, { error: { code: 'OTHER' } })))).toBe('unreachable');
    for (const status of [429, 500, 502, 503]) expect(await sessionStatus(vi.fn(reply(status, { error: { code: 'SECURITY_DEPLOYMENT_PENDING' } })))).toBe('unreachable');
    expect(await sessionStatus(vi.fn(async () => { throw new TypeError('Failed to fetch'); }))).toBe('unreachable');
    const fetcher = vi.fn(reply(200, {}));
    await sessionStatus(fetcher);
    expect(fetcher).toHaveBeenCalledWith('/api/session', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
  });

  it('shares one session check between concurrent failures', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    const checks = [confirmSession(fetcher), confirmSession(fetcher), confirmSession(fetcher)];
    finish(Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 }));
    expect(await Promise.all(checks)).toEqual(['signed-out', 'signed-out', 'signed-out']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await confirmSession(vi.fn(reply(200, {})))).toBe('signed-in');
  });

  it('retries network errors, rate limits, server errors and unconfirmed 401s with bounded backoff', () => {
    for (const status of [0, 401, 408, 429, 500, 503]) expect(transientFailure(new RequestError('x', status))).toBe(true);
    for (const status of [400, 403, 404, 409]) expect(transientFailure(new RequestError('x', status))).toBe(false);
    expect(transientFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(transientFailure(new Error('render'))).toBe(false);
    expect([0, 1, 2, 3, 4, 10].map(retryDelay)).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('asks for a session check on a 401 instead of signing out', async () => {
    const events: string[] = [];
    const target = new EventTarget();
    target.addEventListener(SESSION_CHECK_EVENT, () => events.push(SESSION_CHECK_EVENT));
    target.addEventListener('gitflare:session-required', () => events.push('gitflare:session-required'));
    vi.stubGlobal('window', target);
    vi.stubGlobal('fetch', vi.fn(reply(401, { error: { code: 'AUTH_REQUIRED', message: 'Sign in to Gitflare.' } })));
    await expect(request('/api/workspace')).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    await expect(request('/api/session')).rejects.toMatchObject({ status: 401 });
    expect(events).toEqual([SESSION_CHECK_EVENT]);
  });
});
