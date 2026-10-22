import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {}, WorkflowEntrypoint: class {} }));
import { errorFields, logFailure } from '../src/worker/log';
import { ApiError } from '../src/worker/domain';
import { runImportInline, type ImportRunContext } from '../src/worker/github-import';
import { visibilityChanged } from '../src/worker/public-discovery';
import type { AppEnv } from '../src/worker/env';
import type { Principal, SecurityService } from '../src/worker/security';
import type { Repository } from '../src/shared/types';

afterEach(() => vi.restoreAllMocks());

function captured(level: 'error' | 'warn') {
  const spy = vi.spyOn(console, level).mockImplementation(() => {});
  return () => spy.mock.calls.map(([line]) => JSON.parse(String(line)));
}

describe('failure logs', () => {
  it('records the event, context, error name and code but never the message', () => {
    const lines = captured('error');
    logFailure('slot_release_failed', new ApiError(503, 'CAPACITY_UNAVAILABLE', 'token gf1.secret leaked'), { missionId: 'm', epoch: 2 });
    expect(lines()).toEqual([{ event: 'slot_release_failed', missionId: 'm', epoch: 2, errorName: 'ApiError', errorCode: 'CAPACITY_UNAVAILABLE' }]);
    expect(JSON.stringify(lines())).not.toContain('secret');
  });

  it('drops names and codes that are not identifiers', () => {
    const odd = Object.assign(new Error('x'), { name: 'Bad name with spaces', code: 'ask me@example.test' });
    expect(errorFields(odd)).toEqual({ errorName: 'UnknownError' });
    expect(errorFields('a string')).toEqual({ errorName: 'UnknownError' });
    expect(errorFields(new TypeError('x'))).toEqual({ errorName: 'TypeError' });
  });

  it('logs a failed GitHub import slice and still hands the run back to continue', async () => {
    const lines = captured('warn');
    const context = { repositoryId: 'repo-1', records: { changeGithubImport: async () => { throw new TypeError('network down'); } } } as unknown as ImportRunContext;
    await expect(runImportInline(context, 'run-1')).resolves.toEqual({ state: 'continue' });
    expect(lines()).toEqual([{ event: 'github_import_slice_failed', repositoryId: 'repo-1', runId: 'run-1', slice: 0, errorName: 'TypeError' }]);
  });

  it('finishes public index work before returning when there is no execution context', async () => {
    captured('warn');
    let purged = false;
    const access = { handleOf: async () => { await Promise.resolve(); purged = true; return null; } } as unknown as SecurityService;
    await visibilityChanged({} as AppEnv, undefined, access, { userId: 'u', workspaceId: 'w', role: 'Owner' } as Principal, { id: 'repo-1', name: 'site' } as Repository, 'https://gitflare.test');
    expect(purged).toBe(true);
  });
});
