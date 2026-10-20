import { Buffer } from 'node:buffer';
import type { Release, ReleaseAsset, ReleaseAssetUsage, Repository } from '../shared/types';
import { ApiError, assertMutationOrigin, readJson, requireIdempotencyKey } from './domain';
import type { Principal } from './security';

export const RELEASE_ASSET_STORAGE_LIMIT = 2 * 1024 ** 3;
export const RELEASE_ASSET_MAX_BYTES = 95 * 1024 ** 2;
export const RELEASE_ASSET_INLINE_MAX_BYTES = 4 * 1024 ** 2;
export const RELEASE_ASSETS_PER_RELEASE = 50;
export const RELEASE_ASSET_DAILY_DOWNLOAD_BYTES = 20 * 1024 ** 3;
export const RELEASE_ASSET_INLINE_REQUEST_BYTES = Math.ceil(RELEASE_ASSET_INLINE_MAX_BYTES / 3) * 4 + 4096;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,127}$/;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const INERT_TYPES = /^(?:text\/(?:html|xml|javascript|css)|application\/(?:xhtml\+xml|xml|javascript|ecmascript)|image\/svg\+xml|multipart\/)/;
const USAGE_KEY = 'release-asset-bytes';

export interface StoredAsset { id: string; releaseId: string; name: string; size: number; contentType: string; sha256: string; uploadedBy: string; uploadedAt: string; objectKey: string }
export interface AssetStore { get<T>(key: string): T | undefined; put<T>(key: string, value: T): void; list<T>(prefix: string): T[]; delete(key: string): void }
export interface AssetRecords {
  getRelease(id: string): Release | undefined | Promise<Release | undefined>;
  listReleaseAssets(releaseId?: string): StoredAsset[] | Promise<StoredAsset[]>;
  releaseAssetUsage(): number | Promise<number>;
  commitReleaseAsset(key: string, asset: StoredAsset): StoredAsset | Promise<StoredAsset>;
  removeReleaseAsset(key: string, releaseId: string, assetId: string): StoredAsset | Promise<StoredAsset>;
}
export interface AssetAccess { authorize(principal: Principal, action: 'read' | 'land', resourceType?: string, resourceId?: string): Promise<unknown> }

const assetKey = (releaseId: string, assetId: string) => `release-asset:${releaseId}:${assetId}`;

export function assetName(value: unknown): string {
  if (typeof value !== 'string' || !NAME.test(value) || value.includes('..')) throw new ApiError(400, 'INVALID_ASSET_NAME', 'Asset names start with a letter or number and use up to 128 letters, numbers, ".", "_", "+", "~" or "-".');
  return value;
}

export function assetContentType(value: string | null | undefined): string {
  const type = (value ?? '').split(';')[0]!.trim().toLowerCase();
  return CONTENT_TYPE.test(type) ? type : 'application/octet-stream';
}

export function servedContentType(type: string): string {
  return INERT_TYPES.test(type) ? 'application/octet-stream' : type;
}

function sha256Value(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value.toLowerCase())) throw new ApiError(400, 'SHA256_REQUIRED', 'Send the file’s SHA-256 as 64 hexadecimal characters (X-Content-SHA256).');
  return value.toLowerCase();
}

export function listAssets(store: Pick<AssetStore, 'list'>, releaseId?: string): StoredAsset[] {
  return store.list<StoredAsset>(releaseId ? `release-asset:${releaseId}:` : 'release-asset:').sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt) || a.name.localeCompare(b.name));
}

export function assetUsage(store: Pick<AssetStore, 'get'>): number { return store.get<number>(USAGE_KEY) ?? 0; }

export function commitAsset(store: AssetStore, asset: StoredAsset): StoredAsset {
  if (!store.get<Release>(`release:${asset.releaseId}`)) throw new ApiError(404, 'RELEASE_NOT_FOUND', 'This release could not be found.');
  const existing = listAssets(store, asset.releaseId);
  if (existing.some(item => item.id === asset.id)) return existing.find(item => item.id === asset.id)!;
  if (existing.some(item => item.name === asset.name)) throw new ApiError(409, 'ASSET_EXISTS', `This release already has an asset named ${asset.name}. Delete it first.`);
  if (existing.length >= RELEASE_ASSETS_PER_RELEASE) throw new ApiError(409, 'ASSET_LIMIT', `A release can hold at most ${RELEASE_ASSETS_PER_RELEASE} assets.`);
  const used = assetUsage(store);
  if (used + asset.size > RELEASE_ASSET_STORAGE_LIMIT) throw new ApiError(409, 'ASSET_STORAGE_FULL', 'This repository has used its 2 GiB of release asset storage. Delete older assets first.');
  store.put(assetKey(asset.releaseId, asset.id), asset);
  store.put(USAGE_KEY, used + asset.size);
  return asset;
}

export function removeAsset(store: AssetStore, releaseId: string, assetId: string): StoredAsset {
  const asset = store.get<StoredAsset>(assetKey(releaseId, assetId));
  if (!asset) throw new ApiError(404, 'ASSET_NOT_FOUND', 'This asset could not be found.');
  store.delete(assetKey(releaseId, assetId));
  store.put(USAGE_KEY, Math.max(0, assetUsage(store) - asset.size));
  return asset;
}

export function removeReleaseAssets(store: AssetStore, releaseId: string): StoredAsset[] {
  return listAssets(store, releaseId).map(asset => removeAsset(store, releaseId, asset.id));
}

export function chargeDownload(store: Pick<AssetStore, 'get' | 'put'>, bytes: number, now = Date.now()): boolean {
  const key = `release-asset-downloads:${new Date(now).toISOString().slice(0, 10)}`;
  const used = store.get<number>(key) ?? 0;
  if (used + bytes > RELEASE_ASSET_DAILY_DOWNLOAD_BYTES) return false;
  store.put(key, used + bytes);
  return true;
}

export function usage(bucket: R2Bucket | undefined, usedBytes: number): ReleaseAssetUsage {
  return { available: !!bucket, usedBytes, limitBytes: RELEASE_ASSET_STORAGE_LIMIT, maxAssetBytes: RELEASE_ASSET_MAX_BYTES, maxInlineBytes: RELEASE_ASSET_INLINE_MAX_BYTES, maxAssetsPerRelease: RELEASE_ASSETS_PER_RELEASE };
}

export function assetView(asset: StoredAsset, repositoryId: string, publicBase: string | null, release: Pick<Release, 'tag' | 'draft'>): ReleaseAsset {
  const { objectKey: _objectKey, ...rest } = asset;
  return { ...rest, downloadUrl: `/api/repositories/${repositoryId}/releases/${asset.releaseId}/assets/${asset.id}`, publicUrl: publicBase && !release.draft ? publicDownloadUrl(publicBase, release.tag, asset.name) : null };
}

export function publicDownloadUrl(repositoryUrl: string, tag: string, name: string): string {
  return `${repositoryUrl}/releases/download/${tag.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(name)}`;
}

async function deterministicId(repositoryId: string, key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${repositoryId}\0${key}`));
  return Buffer.from(digest).toString('hex').slice(0, 32);
}

function notAvailable(): never { throw new ApiError(503, 'ASSETS_NOT_AVAILABLE', 'Release assets are not available on this installation: its R2 bucket is not set up.'); }

export interface AssetContext { bucket?: R2Bucket; repository: Repository; records: AssetRecords; principal: Principal; access: AssetAccess; publicBase: string | null }

async function upload(request: Request, context: AssetContext, release: Release): Promise<Response> {
  const { bucket, repository, records, principal } = context;
  if (!bucket) notAvailable();
  const key = requireIdempotencyKey(request);
  const id = await deterministicId(repository.id, key);
  let name: string, contentType: string, sha256: string, size: number, body: ReadableStream | Uint8Array;
  if (request.method === 'PUT') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new ApiError(403, 'ORIGIN_REJECTED', 'Requests must originate from this application.');
    name = assetName(new URL(request.url).searchParams.get('name'));
    contentType = assetContentType(request.headers.get('Content-Type'));
    sha256 = sha256Value(request.headers.get('X-Content-SHA256'));
    size = Number(request.headers.get('Content-Length'));
    if (!Number.isSafeInteger(size) || size < 1) throw new ApiError(411, 'LENGTH_REQUIRED', 'Send the file with a Content-Length header.');
    if (!request.body) throw new ApiError(400, 'INVALID_INPUT', 'Send the file as the request body.');
    body = request.body;
  } else {
    assertMutationOrigin(request);
    const input = await readJson(request, RELEASE_ASSET_INLINE_REQUEST_BYTES);
    name = assetName(input.name);
    contentType = assetContentType(typeof input.contentType === 'string' ? input.contentType : null);
    if (typeof input.contentBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.contentBase64)) throw new ApiError(400, 'INVALID_INPUT', 'contentBase64 must be the file encoded as base64.');
    const bytes = new Uint8Array(Buffer.from(input.contentBase64, 'base64'));
    if (!bytes.byteLength) throw new ApiError(400, 'INVALID_INPUT', 'The file is empty.');
    if (bytes.byteLength > RELEASE_ASSET_INLINE_MAX_BYTES) throw new ApiError(413, 'ASSET_TOO_LARGE', `Inline uploads are limited to ${RELEASE_ASSET_INLINE_MAX_BYTES / 1024 ** 2} MiB. Upload larger files with PUT.`);
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
    if (input.sha256 !== undefined && sha256Value(input.sha256) !== digest) throw new ApiError(400, 'SHA256_MISMATCH', 'The file does not match the SHA-256 you sent.');
    sha256 = digest; size = bytes.byteLength; body = bytes;
  }
  if (size > RELEASE_ASSET_MAX_BYTES) throw new ApiError(413, 'ASSET_TOO_LARGE', `Assets are limited to ${RELEASE_ASSET_MAX_BYTES / 1024 ** 2} MiB each.`);
  const existing = await records.listReleaseAssets(release.id);
  const replay = existing.find(asset => asset.id === id);
  if (replay) {
    if (replay.name !== name || replay.size !== size || replay.sha256 !== sha256) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used for a different upload.');
    return Response.json(assetView(replay, repository.id, context.publicBase, release), { status: 201 });
  }
  if (existing.some(asset => asset.name === name)) throw new ApiError(409, 'ASSET_EXISTS', `This release already has an asset named ${name}. Delete it first.`);
  if (existing.length >= RELEASE_ASSETS_PER_RELEASE) throw new ApiError(409, 'ASSET_LIMIT', `A release can hold at most ${RELEASE_ASSETS_PER_RELEASE} assets.`);
  if (await records.releaseAssetUsage() + size > RELEASE_ASSET_STORAGE_LIMIT) throw new ApiError(409, 'ASSET_STORAGE_FULL', 'This repository has used its 2 GiB of release asset storage. Delete older assets first.');
  const objectKey = `releases/${repository.id}/${release.id}/${id}`;
  const stored = await bucket.put(objectKey, body, { httpMetadata: { contentType }, sha256, customMetadata: { name } }).catch((error: unknown) => {
    if (error instanceof Error && /sha-?256|checksum|digest/i.test(error.message)) throw new ApiError(400, 'SHA256_MISMATCH', 'The file does not match the SHA-256 you sent.');
    throw error;
  });
  if (!stored || stored.size !== size) { await bucket.delete(objectKey).catch(() => {}); throw new ApiError(400, 'INCOMPLETE_UPLOAD', 'The upload ended before the whole file arrived. Try again.'); }
  const asset: StoredAsset = { id, releaseId: release.id, name, size, contentType, sha256, uploadedBy: principal.userId, uploadedAt: new Date().toISOString(), objectKey };
  try { return Response.json(assetView(await records.commitReleaseAsset(key, asset), repository.id, context.publicBase, release), { status: 201 }); }
  catch (error) { await bucket.delete(objectKey).catch(() => {}); throw error; }
}

export function contentDisposition(name: string): string {
  return `attachment; filename="${name.replace(/[^A-Za-z0-9._+~-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function serveAsset(request: Request, bucket: R2Bucket, asset: StoredAsset, cache: string, charge?: (bytes: number) => Promise<boolean>): Promise<Response> {
  const head = request.method === 'HEAD';
  const object = await bucket.get(asset.objectKey, { range: request.headers, onlyIf: request.headers });
  if (!object) return Response.json({ error: { code: 'ASSET_NOT_FOUND', message: 'This asset could not be found.' } }, { status: 404 });
  const headers = new Headers({ 'Content-Type': servedContentType(asset.contentType), 'Content-Disposition': contentDisposition(asset.name), 'Accept-Ranges': 'bytes', ETag: object.httpEtag, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'cross-origin', Digest: `sha-256=${Buffer.from(asset.sha256, 'hex').toString('base64')}` });
  if (!('body' in object)) return new Response(null, { status: request.headers.has('If-None-Match') || request.headers.has('If-Modified-Since') ? 304 : 412, headers });
  const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
  let start = 0, length = object.size;
  if (range && request.headers.has('Range')) {
    if (range.suffix !== undefined) { length = Math.min(range.suffix, object.size); start = object.size - length; }
    else { start = range.offset ?? 0; length = range.length ?? object.size - start; }
  }
  const partial = request.headers.has('Range') && (start > 0 || length < object.size);
  if (charge && !head && !await charge(length)) { await object.body.cancel(); return Response.json({ error: { code: 'DOWNLOAD_BUDGET', message: 'This repository has reached its daily download allowance. Try again tomorrow.' } }, { status: 429, headers: { 'Retry-After': '3600' } }); }
  headers.set('Content-Length', String(length));
  if (partial) headers.set('Content-Range', `bytes ${start}-${start + length - 1}/${object.size}`);
  if (head) { await object.body.cancel(); return new Response(null, { status: partial ? 206 : 200, headers }); }
  return new Response(object.body, { status: partial ? 206 : 200, headers });
}

export async function releaseAssetsApi(request: Request, context: AssetContext, releaseId: string, assetId?: string, operation?: string): Promise<Response> {
  const { repository, records, principal, access, bucket } = context;
  const release = await records.getRelease(releaseId);
  const read = request.method === 'GET' || request.method === 'HEAD';
  await access.authorize(principal, read ? 'read' : 'land', 'repository', repository.id);
  if (!release) throw new ApiError(404, 'RELEASE_NOT_FOUND', 'This release could not be found.');
  if (read && !assetId) return Response.json({ assets: (await records.listReleaseAssets(release.id)).map(asset => assetView(asset, repository.id, context.publicBase, release)), usage: usage(bucket, await records.releaseAssetUsage()) });
  if (read) {
    const asset = (await records.listReleaseAssets(release.id)).find(item => item.id === assetId);
    if (!asset) throw new ApiError(404, 'ASSET_NOT_FOUND', 'This asset could not be found.');
    if (!bucket) notAvailable();
    return serveAsset(request, bucket, asset, 'private, no-store');
  }
  if (principal.kind) throw new ApiError(403, 'FORBIDDEN', 'Only workspace members can change release assets.');
  if (!assetId && (request.method === 'PUT' || request.method === 'POST')) return upload(request, context, release);
  if (request.method !== 'POST' || operation !== 'delete') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use PUT to upload, GET to download and POST …/delete to remove an asset.');
  assertMutationOrigin(request);
  const key = requireIdempotencyKey(request);
  const removed = await records.removeReleaseAsset(key, release.id, assetId!);
  if (bucket) await bucket.delete(removed.objectKey);
  return Response.json({ deleted: true, asset: assetView(removed, repository.id, null, release) });
}
