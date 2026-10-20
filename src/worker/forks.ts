import type { ForkStatus, ForkSyncResult, ForkSyncState, Repository } from '../shared/types';
import { repositoryLabel } from '../shared/repository-names';
import { waitForFork, type ArtifactRepo, type ArtifactsBinding } from './artifacts';
import { ApiError, assertMutationOrigin, readJson, repositoryName, requireIdempotencyKey, requireString, storageRepositoryName } from './domain';
import type { AppEnv } from './env';
import { pktLine } from './git-http';
import { PUBLIC_NOT_FOUND, publicUrls, resolvePublicRepository, siteOrigin } from './public-repositories';
import { consume, rateLimitedResponse } from './rate-limits';
import { publicPrincipal, type Principal, type SecurityService } from './security';

export const FORK_STORAGE_LIMIT_BYTES = 1_073_741_824;
const FORKS_PER_HOUR = 10;
const FORKS_PER_UPSTREAM_PER_DAY = 5;
const SYNC_HISTORY = 1000;
const SYNC_TOKEN_SECONDS = 600;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ForkCatalog {
  getRepository(id: string): Promise<Repository | undefined>;
  createRepository(key: string, repository: Repository): Promise<Repository>;
  saveRepository(repository: Repository): Promise<void>;
  claimProvision(id: string): Promise<boolean>;
}
export interface ForkRecords {
  saveRepository(repository: Repository): Promise<void>;
  forkStorage(): Promise<number>;
  addForkStorage(bytes: number): Promise<number>;
  recordFork(entry: { workspaceId: string; repositoryId: string; forkedAt: string }): Promise<void>;
}
export interface ForkContext {
  env: AppEnv;
  principal: Principal;
  access: SecurityService;
  catalog: ForkCatalog;
  catalogOf(workspaceId: string): Pick<ForkCatalog, 'getRepository'>;
  records(repositoryId: string): ForkRecords;
  fetcher?: typeof fetch;
}

function hostedOnly(env: AppEnv) {
  if (env.EDITION === 'self-hosted' || env.DEMO_MODE === 'true') throw new ApiError(403, 'HOSTED_ONLY', 'Forks of public repositories are part of hosted Gitflare.');
}

function artifactsOf(env: AppEnv): ArtifactsBinding {
  if (!env.ARTIFACTS) throw new ApiError(503, 'REPOSITORY_SETUP_REQUIRED', 'Connect Artifacts before forking.');
  return env.ARTIFACTS;
}

async function head(artifacts: ArtifactsBinding, repository: Pick<Repository, 'name' | 'defaultBranch'>, branch = repository.defaultBranch): Promise<string | null> {
  using source = await artifacts.get(repository.name);
  return (await source.log({ ref: branch, limit: 1 }).catch(() => []))[0]?.hash ?? null;
}

async function limited(access: SecurityService, key: string, max: number, windowMs: number, message: string) {
  try { await access.rateLimit(key, max, windowMs); }
  catch (error) { if (error instanceof ApiError && error.code === 'RATE_LIMITED') throw new ApiError(429, 'RATE_LIMITED', message); throw error; }
}

export async function upstreamOf(context: Pick<ForkContext, 'env' | 'access' | 'catalogOf'>, fork: Repository): Promise<{ repository: Repository; handle: string } | null> {
  const link = fork.fork?.upstream;
  if (!link) return null;
  const repository = await context.catalogOf(link.workspaceId).getRepository(link.repositoryId);
  if (!repository || repository.provider !== 'artifacts') return null;
  const visible = await context.access.check(publicPrincipal(link.workspaceId), 'read', 'repository', repository.id).then(() => true, () => false);
  const handle = visible ? await context.access.handleOf(link.workspaceId) : null;
  return handle ? { repository, handle } : null;
}

export function syncState(forkHead: string | null, upstreamHead: string | null, upstreamHistory: string[], forkHistory: string[]): ForkSyncState {
  if (!forkHead || !upstreamHead) return 'unknown';
  if (forkHead === upstreamHead) return 'up-to-date';
  if (upstreamHistory.includes(forkHead)) return 'behind';
  if (forkHistory.includes(upstreamHead)) return 'ahead';
  return upstreamHistory.length < SYNC_HISTORY && forkHistory.length < SYNC_HISTORY ? 'diverged' : 'unknown';
}

export async function forkStatus(context: ForkContext, fork: Repository, origin: string): Promise<ForkStatus> {
  const link = fork.fork!;
  const artifacts = artifactsOf(context.env);
  const upstream = await upstreamOf(context, fork);
  const allowed = (action: 'land' | 'contribute') => context.access.checkMany(context.principal, action, [{ resourceType: 'repository', resourceId: fork.id }]).then(([value]) => value === true, () => false);
  const [used, canLand, canContribute] = await Promise.all([Promise.resolve().then(() => context.records(fork.id).forkStorage()).catch(() => 0), allowed('land'), allowed('contribute')]);
  let upstreamHead: string | null = null, sync: ForkSyncState = 'unknown';
  using source = await artifacts.get(fork.name);
  const forkHead = (await source.log({ ref: fork.defaultBranch, limit: 1 }).catch(() => []))[0]?.hash ?? null;
  if (upstream) {
    using remote = await artifacts.get(upstream.repository.name);
    const upstreamHistory = (await remote.log({ ref: upstream.repository.defaultBranch, limit: SYNC_HISTORY }).catch(() => [])).map(commit => commit.hash);
    upstreamHead = upstreamHistory[0] ?? null;
    const forkHistory = forkHead && upstreamHead && forkHead !== upstreamHead && !upstreamHistory.includes(forkHead) ? (await source.log({ ref: forkHead, limit: SYNC_HISTORY }).catch(() => [])).map(commit => commit.hash) : [];
    sync = syncState(forkHead, upstreamHead, upstreamHistory, forkHistory);
  }
  const urls = upstream ? publicUrls(origin, upstream.handle, upstream.repository) : null;
  const name = upstream ? repositoryLabel(upstream.repository) : link.upstream.label.split('/').slice(1).join('/') || link.upstream.label;
  return {
    repositoryId: fork.id, defaultBranch: fork.defaultBranch, headSha: forkHead, forkedAt: link.forkedAt,
    upstream: { label: upstream ? `${upstream.handle}/${name}` : link.upstream.label, handle: upstream?.handle ?? null, name, url: urls?.url ?? null, available: !!upstream, defaultBranch: upstream?.repository.defaultBranch ?? null, headSha: upstreamHead },
    sync, storage: { usedBytes: used, limitBytes: FORK_STORAGE_LIMIT_BYTES },
    canSync: sync === 'behind' && canLand, canPropose: !!upstream && canContribute,
  };
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function remoteBase(remote: string): string {
  const url = new URL(remote);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Artifacts returned an invalid remote');
  return url.href.replace(/\/$/, '');
}

export class ForkSyncError extends Error { constructor(readonly code: string, message: string) { super(message); } }

export function packAfterAcknowledgement(body: ReadableStream<Uint8Array>, maxBytes: number, counter: { bytes: number }): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let pending: Uint8Array = new Uint8Array(0);
  let started = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          if (!started) controller.error(new ForkSyncError('SYNC_FAILED', 'Upstream sent no pack.'));
          else controller.close();
          return;
        }
        let chunk = next.value;
        if (!started) {
          pending = concat([pending, chunk]);
          if (pending.length < 4) continue;
          const length = parseInt(decoder.decode(pending.subarray(0, 4)), 16);
          if (!Number.isFinite(length) || length < 4) { controller.error(new ForkSyncError('SYNC_FAILED', 'Upstream answered with an invalid Git response.')); return; }
          if (pending.length < length) continue;
          const line = decoder.decode(pending.subarray(4, length));
          if (!/^(?:NAK|ACK [0-9a-f]{40})\n?$/.test(line)) { controller.error(new ForkSyncError('SYNC_FAILED', 'Upstream refused the fetch.')); return; }
          started = true;
          chunk = pending.subarray(length);
          if (!chunk.length) continue;
        }
        counter.bytes += chunk.length;
        if (counter.bytes > maxBytes) { await reader.cancel(); controller.error(new ForkSyncError('FORK_STORAGE_LIMIT', 'Syncing would exceed this fork’s storage limit.')); return; }
        controller.enqueue(chunk);
        return;
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

export function receivePackOutcome(bytes: Uint8Array, ref: string): string | null {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const length = parseInt(decoder.decode(bytes.subarray(offset, offset + 4)), 16);
    if (!Number.isFinite(length)) return 'Gitflare could not read the fork’s answer.';
    if (length === 0) { offset += 4; continue; }
    if (length < 4 || offset + length > bytes.length) return 'Gitflare could not read the fork’s answer.';
    lines.push(decoder.decode(bytes.subarray(offset + 4, offset + length)).replace(/\n$/, ''));
    offset += length;
  }
  if (lines[0] !== 'unpack ok') return `The fork rejected the objects: ${(lines[0] ?? 'no answer').slice(0, 200)}`;
  return lines.includes(`ok ${ref}`) ? null : `The fork rejected the update: ${(lines.find(line => line.startsWith('ng ')) ?? 'no answer').slice(0, 200)}`;
}

export async function fastForwardFork(input: { upstream: ArtifactRepo; fork: ArtifactRepo; branch: string; from: string; to: string; maxBytes: number; fetcher?: typeof fetch }): Promise<{ bytes: number }> {
  const fetcher = input.fetcher ?? fetch;
  if (!/^[0-9a-f]{40}$/.test(input.from) || !/^[0-9a-f]{40}$/.test(input.to)) throw new ForkSyncError('SYNC_FAILED', 'Sync needs exact commits.');
  const ref = `refs/heads/${input.branch}`;
  const [source, target] = await Promise.all([input.upstream.info(), input.fork.info()]);
  const read = await input.upstream.createToken('read', SYNC_TOKEN_SECONDS);
  const write = await input.fork.createToken('write', SYNC_TOKEN_SECONDS);
  const counter = { bytes: 0 };
  try {
    const wants = concat([pktLine(`want ${input.to} no-progress\n`), encoder.encode('0000'), pktLine(`have ${input.from}\n`), pktLine('done\n')]);
    const fetched = await fetcher(`${remoteBase(source.remote)}/git-upload-pack`, { method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${read.plaintext}`, 'Content-Type': 'application/x-git-upload-pack-request', Accept: 'application/x-git-upload-pack-result', 'User-Agent': 'gitflare-fork-sync' }, body: wants });
    if (!fetched.ok || !fetched.body || fetched.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/x-git-upload-pack-result') { await fetched.body?.cancel(); throw new ForkSyncError('SYNC_FAILED', 'Gitflare could not read the upstream repository. Try again shortly.'); }
    const command = concat([pktLine(`${input.from} ${input.to} ${ref}\0report-status\n`), encoder.encode('0000')]);
    const pack = packAfterAcknowledgement(fetched.body, input.maxBytes, counter);
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sent) { sent = true; controller.enqueue(command); return; }
        const reader = pack.getReader();
        try {
          for (;;) { const next = await reader.read(); if (next.done) break; controller.enqueue(next.value); }
          controller.close();
        } catch (error) { controller.error(error); }
        finally { reader.releaseLock(); }
      },
    });
    let pushed: Response;
    try {
      pushed = await fetcher(`${remoteBase(target.remote)}/git-receive-pack`, { method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${write.plaintext}`, 'Content-Type': 'application/x-git-receive-pack-request', Accept: 'application/x-git-receive-pack-result', 'User-Agent': 'gitflare-fork-sync' }, body });
    } catch (error) {
      if (error instanceof ForkSyncError) throw error;
      throw new ForkSyncError('SYNC_FAILED', 'Gitflare could not write to the fork. Try again shortly.');
    }
    const answer = new Uint8Array(await pushed.arrayBuffer());
    if (!pushed.ok) throw new ForkSyncError('SYNC_FAILED', 'The fork rejected the sync. Try again shortly.');
    const problem = receivePackOutcome(answer, ref);
    if (problem) throw new ForkSyncError('SYNC_FAILED', problem);
    return { bytes: counter.bytes };
  } finally {
    await Promise.all([input.upstream.revokeToken(read.plaintext).catch(() => false), input.fork.revokeToken(write.plaintext).catch(() => false)]);
  }
}

async function createFork(request: Request, context: ForkContext): Promise<Response> {
  const { env, principal, access, catalog } = context;
  hostedOnly(env);
  assertMutationOrigin(request);
  const key = requireIdempotencyKey(request);
  const body = await readJson(request, 4096);
  await access.authorize(principal, 'manage');
  const throttled = await consume(env, 'FORK_RATE_LIMIT', `user:${principal.userId}`);
  if (throttled) return rateLimitedResponse(throttled, 'forks');
  const handle = requireString(body.handle, 'Handle', 100).toLowerCase();
  const name = requireString(body.repository, 'Repository', 100);
  let target = await resolvePublicRepository(env, access, handle, name);
  if (target && 'redirect' in target) target = await resolvePublicRepository(env, access, target.redirect, name);
  if (!target || 'redirect' in target) throw new ApiError(404, 'NOT_FOUND', PUBLIC_NOT_FOUND);
  const upstream = target.repository;
  if (target.workspaceId === principal.workspaceId) throw new ApiError(409, 'FORK_SAME_WORKSPACE', 'This repository already belongs to this workspace. Fork it into another workspace.');
  const artifacts = artifactsOf(env);
  const upstreamHead = await head(artifacts, upstream);
  if (!upstreamHead) throw new ApiError(409, 'EMPTY_REPOSITORY', 'This repository has no commits to fork yet.');
  const requested = repositoryName(body.name === undefined || body.name === '' ? repositoryLabel(upstream) : body.name);
  const storage = await storageRepositoryName(principal.workspaceId, requested);
  const now = new Date().toISOString();
  let repository = await catalog.createRepository(key, {
    id: crypto.randomUUID(), workspaceId: principal.workspaceId, name: storage, ...(storage === requested ? {} : { displayName: requested }), description: upstream.description, defaultBranch: upstream.defaultBranch, headSha: null, provider: 'artifacts',
    fork: { upstream: { workspaceId: target.workspaceId, repositoryId: upstream.id, label: `${target.handle}/${repositoryLabel(upstream)}` }, forkedAt: now, forkedAtSha: upstreamHead, forkedBy: principal.userId },
    createdAt: now, updatedAt: now,
  });
  repository = await catalog.getRepository(repository.id) ?? repository;
  if (!repository.fork) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key belongs to another repository creation.');
  if (repository.remote) return Response.json(repository, { status: 201 });
  await limited(access, `fork:${principal.userId}`, FORKS_PER_HOUR, 3_600_000, `You can fork ${FORKS_PER_HOUR} repositories an hour. Try again later.`);
  await limited(access, `fork:${principal.userId}:${upstream.id}`, FORKS_PER_UPSTREAM_PER_DAY, 86_400_000, `You forked this repository ${FORKS_PER_UPSTREAM_PER_DAY} times today. Try again tomorrow.`);
  if (!await catalog.claimProvision(repository.id)) throw new ApiError(409, 'PROVISIONING_PENDING', 'This fork is being created or needs reconciliation after an interrupted request. Its creation will not be repeated.');
  try {
    using source = await artifacts.get(upstream.name);
    const created = await source.fork(storage, { description: `Fork of ${repository.fork.upstream.label}`, readOnly: false, defaultBranchOnly: true });
    using forked = await waitForFork(artifacts, created.name);
    await forked.revokeToken(created.token);
    const forkedHead = (await forked.log({ ref: upstream.defaultBranch, limit: 1 }).catch(() => []))[0]?.hash ?? upstreamHead;
    repository = { ...repository, remote: created.remote, headSha: forkedHead, fork: { ...repository.fork!, forkedAtSha: forkedHead }, updatedAt: new Date().toISOString() };
  } catch {
    throw new ApiError(503, 'FORK_INTERRUPTED', 'The fork did not finish. Inspect its Artifacts state before retrying to avoid duplicate storage.');
  }
  await catalog.saveRepository(repository);
  await context.records(repository.id).saveRepository(repository);
  await Promise.resolve().then(() => context.records(upstream.id).recordFork({ workspaceId: principal.workspaceId, repositoryId: repository.id, forkedAt: now })).catch(() => {});
  await access.auditRepositoryChange(principal, 'repository.fork', repository.id);
  return Response.json({ ...repository, displayName: repositoryLabel(repository) }, { status: 201 });
}

async function syncFork(request: Request, context: ForkContext, fork: Repository, origin: string): Promise<Response> {
  const { env, principal, access } = context;
  hostedOnly(env);
  assertMutationOrigin(request);
  requireIdempotencyKey(request);
  await access.authorize(principal, 'land', 'repository', fork.id);
  const before = await forkStatus(context, fork, origin);
  if (before.sync === 'up-to-date') return Response.json({ status: before, updated: false, headSha: before.headSha } satisfies ForkSyncResult);
  if (!before.upstream.available) throw new ApiError(409, 'UPSTREAM_UNAVAILABLE', 'The upstream repository is no longer public.');
  if (before.sync === 'ahead') throw new ApiError(409, 'FORK_AHEAD', `${fork.defaultBranch} already has every upstream commit. Propose your commits upstream instead.`);
  if (before.sync !== 'behind') throw new ApiError(409, 'FORK_DIVERGED', `${fork.defaultBranch} has commits upstream doesn’t. Sync moves it only forward; work on a stream instead.`);
  const upstream = (await upstreamOf(context, fork))!;
  const remaining = FORK_STORAGE_LIMIT_BYTES - before.storage.usedBytes;
  if (remaining <= 0) throw new ApiError(413, 'FORK_STORAGE_LIMIT', 'This fork has reached its 1 GiB storage limit.');
  const artifacts = artifactsOf(env);
  using source = await artifacts.get(upstream.repository.name);
  using target = await artifacts.get(fork.name);
  let bytes: number;
  try { ({ bytes } = await fastForwardFork({ upstream: source, fork: target, branch: fork.defaultBranch, from: before.headSha!, to: before.upstream.headSha!, maxBytes: remaining, ...(context.fetcher ? { fetcher: context.fetcher } : {}) })); }
  catch (error) {
    if (error instanceof ForkSyncError) throw new ApiError(error.code === 'FORK_STORAGE_LIMIT' ? 413 : 502, error.code, error.message);
    throw error;
  }
  await context.records(fork.id).addForkStorage(bytes);
  const headSha = (await target.log({ ref: fork.defaultBranch, limit: 1 }).catch(() => []))[0]?.hash ?? null;
  if (headSha !== before.upstream.headSha) throw new ApiError(502, 'SYNC_UNCONFIRMED', 'The sync could not be confirmed. Refresh and try again.');
  const updated = { ...fork, headSha, updatedAt: new Date().toISOString() };
  await context.catalog.saveRepository(updated);
  await context.records(fork.id).saveRepository(updated);
  await access.auditRepositoryChange(principal, 'repository.fork.sync', fork.id);
  return Response.json({ status: await forkStatus(context, updated, origin), updated: true, headSha } satisfies ForkSyncResult);
}

export async function handleForks(request: Request, url: URL, context: ForkContext): Promise<Response | null> {
  const origin = siteOrigin(context.env, url.origin);
  if (url.pathname === '/api/forks') {
    if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use POST to fork a repository.');
    return createFork(request, context);
  }
  const route = /^\/api\/repositories\/([a-zA-Z0-9-]+)\/fork(?:\/(sync))?$/.exec(url.pathname);
  if (!route) return null;
  const fork = await context.catalog.getRepository(route[1]!);
  if (!fork) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
  await context.access.authorize(context.principal, 'read', 'repository', fork.id);
  if (!fork.fork) throw new ApiError(404, 'NOT_A_FORK', 'This repository is not a fork.');
  if (route[2] === 'sync') {
    if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use POST to sync a fork.');
    return syncFork(request, context, fork, origin);
  }
  if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET to read a fork.');
  return Response.json(await forkStatus(context, fork, origin));
}
