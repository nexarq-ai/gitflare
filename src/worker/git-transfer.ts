import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { ApiError } from './domain';
import { capStream } from './url-import';

export const ZERO_SHA = '0'.repeat(40);
export const TRANSFER_LIMITS = { advertisementBytes: 4 * 1024 * 1024, reportBytes: 1024 * 1024, packBytes: 512 * 1024 * 1024, discoveryMs: 20_000, transferMs: 600_000, haves: 256 } as const;

export interface GitRemote { url: string; authorization: string; label: string }
export interface Advertisement { refs: Map<string, string>; capabilities: Set<string> }
export interface RefCommand { ref: string; oldSha: string; newSha: string }
export type CommandOutcome = { ref: string; ok: true } | { ref: string; ok: false; reason: string };
type Service = 'git-upload-pack' | 'git-receive-pack';

const USER_AGENT = 'git/2.47.0 gitflare-mirror';

function pkt(line: string): Buffer {
  const payload = Buffer.from(line);
  if (payload.length + 4 > 65520) throw new ApiError(500, 'GIT_PACKET_TOO_LARGE', 'A Git command was too large.');
  return Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, '0')), payload]);
}

function protocolError(remote: GitRemote, message: string): ApiError {
  return new ApiError(502, 'MIRROR_PROTOCOL', `${remote.label} returned ${message}.`);
}

function packets(remote: GitRemote, bytes: Uint8Array): string[] {
  const buffer = Buffer.from(bytes); const lines: string[] = []; let offset = 0;
  while (offset < buffer.length) {
    const prefix = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/i.test(prefix)) throw protocolError(remote, 'an invalid Git packet');
    const length = parseInt(prefix, 16); offset += 4;
    if (length === 0) { lines.push(''); continue; }
    if (length < 4 || offset + length - 4 > buffer.length) throw protocolError(remote, 'a truncated Git packet');
    lines.push(buffer.subarray(offset, offset + length - 4).toString('utf8')); offset += length - 4;
  }
  return lines;
}

async function bounded(remote: GitRemote, body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (!body) throw protocolError(remote, 'an empty response');
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new ApiError(413, 'MIRROR_TOO_LARGE', `${remote.label} advertised more data than the mirror allows.`);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return new Uint8Array(Buffer.concat(chunks));
}

async function send(remote: GitRemote, path: string, init: { method: string; headers: Record<string, string>; body?: ReadableStream<Uint8Array> | Uint8Array; timeoutMs: number }, fetcher: typeof fetch): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(`${remote.url}${path}`, { method: init.method, headers: { ...(remote.authorization ? { authorization: remote.authorization } : {}), 'user-agent': USER_AGENT, ...init.headers }, body: init.body as BodyInit | undefined, redirect: 'manual', signal: AbortSignal.timeout(init.timeoutMs) });
  } catch { throw new ApiError(502, 'MIRROR_UNREACHABLE', `${remote.label} could not be reached.`); }
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new ApiError(422, 'MIRROR_REDIRECT', `${remote.label} redirected the request. Check the repository owner and name.`); }
  if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new ApiError(422, 'MIRROR_AUTH_REJECTED', `${remote.label} rejected the credential. It needs Contents read and write access to this repository.`); }
  if (response.status === 404) { await response.body?.cancel(); throw new ApiError(404, 'MIRROR_REPOSITORY_NOT_FOUND', `${remote.label} has no such repository, or the credential cannot see it.`); }
  if (!response.ok) { await response.body?.cancel(); throw new ApiError(502, 'MIRROR_UNAVAILABLE', `${remote.label} returned HTTP ${response.status}.`); }
  return response;
}

function requireType(remote: GitRemote, response: Response, type: string): void {
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== type) throw protocolError(remote, 'a response that is not smart HTTP Git');
}

export function parseAdvertisement(remote: GitRemote, service: Service, bytes: Uint8Array): Advertisement {
  const lines = packets(remote, bytes);
  if (lines[0] !== `# service=${service}\n` || lines[1] !== '') throw protocolError(remote, 'an invalid service advertisement');
  const refs = new Map<string, string>(); const capabilities = new Set<string>();
  for (const [index, line] of lines.slice(2).filter(Boolean).entries()) {
    const [advertised, caps] = line.replace(/\n$/, '').split('\0');
    if (index === 0 && caps) for (const value of caps.split(' ')) if (value) capabilities.add(value);
    const match = /^([a-f0-9]{40}) (\S+)$/.exec(advertised);
    if (!match) throw protocolError(remote, /^[a-f0-9]{64} /.test(advertised) ? 'a SHA-256 repository, which is not supported' : 'an invalid reference');
    if (match[1] === ZERO_SHA || match[2].endsWith('^{}') || !match[2].startsWith('refs/')) continue;
    refs.set(match[2], match[1]);
  }
  if ([...capabilities].some(value => value.startsWith('object-format=') && value !== 'object-format=sha1')) throw protocolError(remote, 'a SHA-256 repository, which is not supported');
  return { refs, capabilities };
}

export async function advertise(remote: GitRemote, service: Service, fetcher: typeof fetch = fetch): Promise<Advertisement> {
  const response = await send(remote, `/info/refs?service=${service}`, { method: 'GET', headers: { accept: `application/x-${service}-advertisement` }, timeoutMs: TRANSFER_LIMITS.discoveryMs }, fetcher);
  requireType(remote, response, `application/x-${service}-advertisement`);
  return parseAdvertisement(remote, service, await bounded(remote, response.body, TRANSFER_LIMITS.advertisementBytes));
}

export function emptyPack(): Uint8Array {
  const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(0, 8);
  return new Uint8Array(Buffer.concat([header, createHash('sha1').update(header).digest()]));
}

function prefixed(prefix: Uint8Array, rest: ReadableStreamDefaultReader<Uint8Array> | null): ReadableStream<Uint8Array> {
  let sentPrefix = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentPrefix) { sentPrefix = true; if (prefix.byteLength) { controller.enqueue(prefix); return; } }
      if (!rest) { controller.close(); return; }
      const { done, value } = await rest.read();
      if (done) controller.close(); else controller.enqueue(value);
    },
    async cancel(reason) { await rest?.cancel(reason); },
  });
}

export async function uploadPack(remote: GitRemote, advertised: Advertisement, wants: string[], haves: string[], fetcher: typeof fetch = fetch): Promise<ReadableStream<Uint8Array>> {
  if (!wants.length) throw new ApiError(500, 'MIRROR_NOTHING_TO_FETCH', 'No objects were requested.');
  const capabilities = ['ofs-delta', 'no-progress'].filter(value => advertised.capabilities.has(value));
  const lines = [pkt(`want ${wants[0]}${capabilities.length ? ` ${capabilities.join(' ')}` : ''}\n`), ...wants.slice(1).map(sha => pkt(`want ${sha}\n`)), Buffer.from('0000'), ...haves.slice(0, TRANSFER_LIMITS.haves).map(sha => pkt(`have ${sha}\n`)), pkt('done\n')];
  const response = await send(remote, '/git-upload-pack', { method: 'POST', headers: { 'content-type': 'application/x-git-upload-pack-request', accept: 'application/x-git-upload-pack-result' }, body: new Uint8Array(Buffer.concat(lines)), timeoutMs: TRANSFER_LIMITS.transferMs }, fetcher);
  requireType(remote, response, 'application/x-git-upload-pack-result');
  if (!response.body) throw protocolError(remote, 'an empty pack');
  const reader = response.body.getReader();
  let buffer = Buffer.alloc(0);
  for (;;) {
    while (buffer.length >= 4) {
      const prefix = buffer.subarray(0, 4).toString('ascii');
      if (prefix === 'PACK') return capStream(prefixed(new Uint8Array(buffer), reader), TRANSFER_LIMITS.packBytes);
      if (!/^[0-9a-f]{4}$/i.test(prefix)) { await reader.cancel(); throw protocolError(remote, 'an invalid negotiation response'); }
      const length = parseInt(prefix, 16);
      if (length === 0) { buffer = buffer.subarray(4); continue; }
      if (length < 4) { await reader.cancel(); throw protocolError(remote, 'an invalid negotiation response'); }
      if (buffer.length < length) break;
      const line = buffer.subarray(4, length).toString('utf8').trimEnd();
      if (line.startsWith('ERR ')) { await reader.cancel(); throw new ApiError(502, 'MIRROR_FETCH_REJECTED', `${remote.label} refused the fetch: ${line.slice(4, 200)}`); }
      if (!/^(NAK|ACK [a-f0-9]{40}( .*)?)$/.test(line)) { await reader.cancel(); throw protocolError(remote, 'an unexpected negotiation line'); }
      buffer = buffer.subarray(length);
    }
    if (buffer.length > 65536) { await reader.cancel(); throw protocolError(remote, 'an oversized negotiation response'); }
    const { done, value } = await reader.read();
    if (done) throw protocolError(remote, 'no pack');
    buffer = Buffer.concat([buffer, Buffer.from(value)]);
  }
}

export function parseReport(remote: GitRemote, commands: RefCommand[], bytes: Uint8Array): CommandOutcome[] {
  const lines = packets(remote, bytes).filter(Boolean).map(line => line.trimEnd());
  const unpack = lines[0];
  if (!unpack?.startsWith('unpack ')) throw protocolError(remote, 'no push status');
  const unpackError = unpack === 'unpack ok' ? null : unpack.slice(7, 200);
  const byRef = new Map<string, CommandOutcome>();
  for (const line of lines.slice(1)) {
    const ok = /^ok (\S+)$/.exec(line), ng = /^ng (\S+) (.*)$/.exec(line);
    if (ok) byRef.set(ok[1], { ref: ok[1], ok: true });
    else if (ng) byRef.set(ng[1], { ref: ng[1], ok: false, reason: ng[2].slice(0, 200) });
  }
  return commands.map(command => unpackError ? { ref: command.ref, ok: false, reason: `unpack failed: ${unpackError}` } : byRef.get(command.ref) ?? { ref: command.ref, ok: false, reason: 'no status reported' });
}

export async function receivePack(remote: GitRemote, advertised: Advertisement, commands: RefCommand[], pack: ReadableStream<Uint8Array> | Uint8Array | null, fetcher: typeof fetch = fetch): Promise<CommandOutcome[]> {
  if (!commands.length) return [];
  if (!advertised.capabilities.has('report-status')) throw protocolError(remote, 'no report-status support');
  if (commands.some(command => command.newSha === ZERO_SHA) && !advertised.capabilities.has('delete-refs')) throw protocolError(remote, 'no support for deleting references');
  const header = new Uint8Array(Buffer.concat([...commands.map((command, index) => pkt(`${command.oldSha} ${command.newSha} ${command.ref}${index === 0 ? '\0report-status' : ''}\n`)), Buffer.from('0000')]));
  const body = pack === null ? header : pack instanceof Uint8Array ? new Uint8Array(Buffer.concat([header, pack])) : prefixed(header, pack.getReader());
  const response = await send(remote, '/git-receive-pack', { method: 'POST', headers: { 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result' }, body, timeoutMs: TRANSFER_LIMITS.transferMs }, fetcher);
  requireType(remote, response, 'application/x-git-receive-pack-result');
  return parseReport(remote, commands, await bounded(remote, response.body, TRANSFER_LIMITS.reportBytes));
}

export async function transferRefs(from: { remote: GitRemote; advertised: Advertisement }, to: { remote: GitRemote; advertised: Advertisement }, commands: RefCommand[], fetcher: typeof fetch = fetch): Promise<CommandOutcome[]> {
  if (!commands.length) return [];
  const known = new Set(to.advertised.refs.values());
  const wants = [...new Set(commands.map(command => command.newSha).filter(sha => sha !== ZERO_SHA && !known.has(sha)))];
  const updates = commands.some(command => command.newSha !== ZERO_SHA);
  const pack = !updates ? null : wants.length ? await uploadPack(from.remote, from.advertised, wants, [...known], fetcher) : emptyPack();
  return receivePack(to.remote, to.advertised, commands, pack, fetcher);
}

export function basicAuthorization(token: string): string {
  return `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
}
