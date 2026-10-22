import { describe, expect, it } from 'vitest';
import { ApiError, assertActiveRun, assertApproval, assertMutationOrigin, assertReplayFingerprint, findRepositoryByName, isLocalRequest, storageRepositoryName, missionInput, publicError, readJson, repositoryName, repositoryPath, repositoryRef, requireIdempotencyKey } from '../src/worker/domain';
import { repositoryLabel } from '../src/shared/repository-names';

const base = 'a'.repeat(40);
const candidate = 'b'.repeat(40);
const approval = { status: 'needs_review', baseSha: base, candidateSha: candidate, currentHead: base, requestedBase: base, requestedCandidate: candidate, checksPassed: true };

describe('commit-bound approval', () => {
  it('accepts the currently tested candidate and base', () => {
    expect(() => assertApproval(approval)).not.toThrow();
  });
  it.each([
    { currentHead: 'c'.repeat(40) },
    { requestedCandidate: 'c'.repeat(40) },
    { requestedBase: 'c'.repeat(40) },
    { candidateSha: null },
    { baseSha: null },
    { checksPassed: false },
    { status: 'running' },
    { status: 'cancelled' },
  ])('rejects stale or unverified state %j', (change) => {
    expect(() => assertApproval({ ...approval, ...change })).toThrow();
  });
});

describe('repository browser boundaries', () => {
  it.each(['/etc/passwd', '../secret', 'src/../secret', 'src//file', 'src/./file', 'src\\file', 'src/\0file'])('rejects noncanonical paths %s', (path) => {
    expect(() => repositoryPath(path)).toThrow();
  });
  it('allows root listing and nested files but requires a path for file reads', () => {
    expect(repositoryPath('')).toBe('');
    expect(repositoryPath('src/handler.ts', false)).toBe('src/handler.ts');
    expect(() => repositoryPath('', false)).toThrow();
  });
  it.each(['main..head', '-main', 'main:README.md', 'main@{0}', 'main\n'])('rejects invalid refs %s', (ref) => {
    expect(() => repositoryRef(ref)).toThrow();
  });
  it('allows normal branch names and immutable commit IDs', () => {
    expect(repositoryRef('feature/checkout')).toBe('feature/checkout');
    expect(repositoryRef(base)).toBe(base);
  });
});

describe('mission authoring', () => {
  const input = { title: 'Checkout reliability', prompt: 'Make checkout operations idempotent.', repositoryId: 'repo-1' };
  const tasks = [{ name: 'Implementation', role: 'Implementation', task: 'Implement idempotent order creation.' }, { name: 'Compatibility', role: 'Contract', task: 'Preserve client compatibility for order results.' }];
  it('retains acceptance criteria and independently assigned tasks', () => {
    expect(missionInput({ ...input, acceptanceCriteria: ['Retries do not duplicate orders'], tasks })).toEqual({ ...input, acceptanceCriteria: ['Retries do not duplicate orders'], tasks });
  });
  it('rejects ambiguous agent assignments and malformed criteria', () => {
    expect(() => missionInput({ ...input, tasks: [] })).toThrow();
    expect(missionInput({ ...input, tasks: Array.from({ length: 10 }, (_, index) => ({ ...tasks[0], name: `Agent ${index + 1}` })) }).tasks).toHaveLength(10);
    expect(() => missionInput({ ...input, tasks: Array.from({ length: 11 }, (_, index) => ({ ...tasks[0], name: `Agent ${index + 1}` })) })).toThrow();
    expect(() => missionInput({ ...input, tasks: [tasks[0], tasks[0]] })).toThrow();
    expect(() => missionInput({ ...input, tasks: [...tasks, { ...tasks[0], name: ' implementation ' }] })).toThrow();
    expect(() => missionInput({ ...input, acceptanceCriteria: [''] })).toThrow();
    expect(() => missionInput({ ...input, acceptanceCriteria: ['criterion', 42] })).toThrow();
    expect(() => missionInput({ ...input, acceptanceCriteria: Array(13).fill('Too many criteria') })).toThrow();
  });
  it.each([1, 3, 8])('accepts %i independently named agent assignments', count => {
    const assignments = Array.from({ length: count }, (_, index) => ({ ...tasks[0], name: `Agent ${index + 1}` }));
    expect(missionInput({ ...input, tasks: assignments }).tasks).toEqual(assignments);
  });
  it('keeps omitted assignments available for the default proposal agents', () => {
    expect(missionInput(input).tasks).toBeUndefined();
  });
  it('retains only an exact valid optional draft baseline', () => {
    expect(missionInput({ ...input, expectedBaseSha: 'a'.repeat(40) }).expectedBaseSha).toBe('a'.repeat(40));
    expect(() => missionInput({ ...input, expectedBaseSha: 'main' })).toThrow('INVALID_COMMIT');
    expect(() => missionInput({ ...input, expectedBaseSha: 'A'.repeat(40) })).toThrow('INVALID_COMMIT');
  });
});

describe('execution leases and request retries', () => {
  it('rejects a cancelled run even when its epoch matches', () => {
    expect(() => assertActiveRun('cancelled', 1, 1)).toThrow();
  });
  it('rejects late results from an earlier attempt', () => {
    expect(() => assertActiveRun('running', 2, 1)).toThrow();
    expect(() => assertActiveRun('running', 2, 2)).not.toThrow();
  });
  it('allows exact retries but rejects reusing keys with changed intent', () => {
    expect(() => assertReplayFingerprint('same-action', 'same-action')).not.toThrow();
    expect(() => assertReplayFingerprint('first-action', 'changed-action')).toThrow();
  });
});

describe('request boundaries', () => {
  it('preserves domain errors over RPC without exposing unknown error details', () => {
    const transported = new Error(new ApiError(409, 'STALE_APPROVAL', 'Review changed.').message);
    expect(publicError(transported)).toEqual({ status: 409, code: 'STALE_APPROVAL', message: 'Review changed.' });
    expect(publicError(new Error('private secret in upstream response'))).toEqual({ status: 500, code: 'INTERNAL_ERROR', message: 'The request could not be completed. Please try again.' });
  });
  it('only bypasses authentication on explicit localhost development', () => {
    expect(isLocalRequest(new Request('http://localhost:5188/api/workspace'), 'local')).toBe(true);
    expect(isLocalRequest(new Request('https://gitflare.example/api/workspace'), 'local')).toBe(false);
    expect(isLocalRequest(new Request('http://127.0.0.1/api/workspace'), 'production')).toBe(false);
  });
  it('rejects cross-origin and non-JSON mutations', () => {
    expect(() => assertMutationOrigin(new Request('https://gitflare.example/api/missions', { headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' } }))).toThrow();
    expect(() => assertMutationOrigin(new Request('https://gitflare.example/api/missions', { headers: { 'Content-Type': 'text/plain' } }))).toThrow();
    expect(() => assertMutationOrigin(new Request('https://gitflare.example/api/missions', { headers: { Origin: 'https://gitflare.example', 'Content-Type': 'application/json' } }))).not.toThrow();
  });
  it('requires an idempotency key', () => {
    expect(() => requireIdempotencyKey(new Request('https://gitflare.example'))).toThrow();
    expect(requireIdempotencyKey(new Request('https://gitflare.example', { headers: { 'Idempotency-Key': 'unique-request-key-0001' } }))).toBe('unique-request-key-0001');
  });
  it.each(['../repo', 'repo/name', 'repo.git', '', 'bad repo'])('rejects unsafe repository names: %s', (name) => {
    expect(() => repositoryName(name)).toThrow();
  });
  it('derives distinct storage names for long repository names without truncating the shown name', async () => {
    const workspace = '0123abcd-0123-abcd-0123-abcdef012345';
    const prefix = 'w-0123abcd0123abcd0123abcdef012345-';
    expect(await storageRepositoryName('legacy', 'customer-portal-frontend-service-alpha')).toBe('customer-portal-frontend-service-alpha');
    expect(await storageRepositoryName(workspace, 'a'.repeat(29))).toBe(prefix + 'a'.repeat(29));
    const alpha = await storageRepositoryName(workspace, 'customer-portal-frontend-service-alpha');
    const beta = await storageRepositoryName(workspace, 'customer-portal-frontend-service-beta');
    expect(alpha).toMatch(/^w-0123abcd0123abcd0123abcdef012345-customer-portal-fron-[0-9a-f]{8}$/);
    expect(alpha).not.toBe(beta);
    expect(await storageRepositoryName(workspace, 'Customer-Portal-Frontend-Service-Alpha')).toBe(alpha.replace('customer-portal-fron', 'Customer-Portal-Fron'));
    expect((await storageRepositoryName(workspace, 'x'.repeat(64))).length).toBe(64);
  });
  it('finds repositories by storage name, shown name or a pre-existing truncated name', () => {
    const workspace = '0123abcd-0123-abcd-0123-abcdef012345';
    const prefix = 'w-0123abcd0123abcd0123abcdef012345-';
    const truncated = { name: `${prefix}customer-portal-frontend-serv` };
    const current = { name: `${prefix}customer-portal-fron-12345678`, displayName: 'customer-portal-frontend-service-beta' };
    const repositories = [truncated, current];
    expect(findRepositoryByName(repositories, workspace, 'customer-portal-frontend-service-beta')).toBe(current);
    expect(findRepositoryByName(repositories, workspace, current.name)).toBe(current);
    expect(findRepositoryByName(repositories, workspace, 'customer-portal-frontend-serv')).toBe(truncated);
    expect(findRepositoryByName(repositories, workspace, 'customer-portal-frontend-service-alpha')).toBe(truncated);
    expect(findRepositoryByName(repositories, 'legacy', 'customer-portal-frontend-service-alpha')).toBeUndefined();
    expect(repositoryLabel(truncated)).toBe('customer-portal-frontend-serv');
    expect(repositoryLabel(current)).toBe('customer-portal-frontend-service-beta');
    expect(repositoryLabel({ name: 'plain' })).toBe('plain');
  });
  it('bounds payload size and rejects non-object JSON', async () => {
    await expect(readJson(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ prompt: 'x'.repeat(17_000) }) }))).rejects.toThrow();
    await expect(readJson(new Request('http://localhost', { method: 'POST', body: '[]' }))).rejects.toThrow();
    await expect(readJson(new Request('http://localhost', { method: 'POST', body: '{"title":"Valid"}' }))).resolves.toEqual({ title: 'Valid' });
  });
});
