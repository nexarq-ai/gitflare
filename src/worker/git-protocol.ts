import { Buffer } from 'node:buffer';

export const ZERO_SHA = '0'.repeat(40);

const encoder = new TextEncoder();

export function pktLine(payload: string | Uint8Array): Uint8Array {
  const bytes = typeof payload === 'string' ? encoder.encode(payload) : payload;
  const line = new Uint8Array(bytes.length + 4);
  line.set(encoder.encode((bytes.length + 4).toString(16).padStart(4, '0')));
  line.set(bytes, 4);
  return line;
}

export function boundedPacket(line: string, tooLarge: () => Error): Buffer {
  const payload = Buffer.from(line);
  const length = payload.length + 4;
  if (length > 65520) throw tooLarge();
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0')), payload]);
}

export interface PacketErrors { invalid(): Error; badLength(): Error; truncatedHeader?(): Error }

export function packetLines(bytes: Uint8Array, errors: PacketErrors): string[] {
  const buffer = Buffer.from(bytes); const lines: string[] = []; let offset = 0;
  while (offset < buffer.length) {
    if (errors.truncatedHeader && offset + 4 > buffer.length) throw errors.truncatedHeader();
    const prefix = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/i.test(prefix)) throw errors.invalid();
    const length = parseInt(prefix, 16); offset += 4;
    if (length === 0) { lines.push(''); continue; }
    if (length < 4 || offset + length - 4 > buffer.length) throw errors.badLength();
    lines.push(buffer.subarray(offset, offset + length - 4).toString('utf8')); offset += length - 4;
  }
  return lines;
}

export interface BodyErrors { empty(): Error; tooLarge(): Error }

export async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number, errors: BodyErrors): Promise<Uint8Array> {
  if (!body) throw errors.empty();
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw errors.tooLarge();
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return new Uint8Array(Buffer.concat(chunks));
}

export interface AdvertisedRef { index: number; sha: string; ref: string; capabilities?: string }
export interface AdvertisementErrors { header(): Error; reference(advertised: string): Error }

export function* advertisedRefs(lines: string[], service: string, errors: AdvertisementErrors): Generator<AdvertisedRef> {
  if (lines[0] !== `# service=${service}\n` || lines[1] !== '') throw errors.header();
  for (const [index, line] of lines.slice(2).filter(Boolean).entries()) {
    const [advertised, capabilities] = line.replace(/\n$/, '').split('\0');
    const match = /^([a-f0-9]{40}) (\S+)$/.exec(advertised);
    if (!match) throw errors.reference(advertised);
    yield { index, sha: match[1], ref: match[2], capabilities };
  }
}
