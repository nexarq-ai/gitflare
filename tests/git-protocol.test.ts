import { describe, expect, it } from 'vitest';
import { advertisedRefs, boundedPacket, packetLines, pktLine, readLimited, ZERO_SHA } from '../src/worker/git-protocol';
import { ZERO_SHA as transferZero, parseAdvertisement } from '../src/worker/git-transfer';
import { ZERO_SHA as protectionZero } from '../src/worker/branch-protection';
import { parsePackets, packet } from '../src/worker/repository-initialization';
import { parseAdvertisement as parseSource } from '../src/worker/url-import';

const errors = { invalid: () => new Error('invalid'), badLength: () => new Error('length') };
const bytes = (text: string) => new TextEncoder().encode(text);
const stream = (...chunks: string[]) => new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(bytes(chunk)); controller.close(); } });
const sha = 'a'.repeat(40);
const advertisement = (service: string, ...lines: string[]) => Buffer.concat([pktLine(`# service=${service}\n`), bytes('0000'), ...lines.map(line => pktLine(line)), bytes('0000')]);

describe('git protocol primitives', () => {
  it('shares one zero SHA', () => {
    expect(ZERO_SHA).toBe('0'.repeat(40));
    expect(transferZero).toBe(ZERO_SHA);
    expect(protectionZero).toBe(ZERO_SHA);
  });

  it('writes pkt-lines and refuses oversized bounded packets', () => {
    expect(new TextDecoder().decode(pktLine('done\n'))).toBe('0009done\n');
    expect(boundedPacket('done\n', () => new Error('big')).toString()).toBe('0009done\n');
    expect(() => boundedPacket('x'.repeat(65517), () => new Error('big'))).toThrow('big');
    expect(() => packet('x'.repeat(65517))).toThrow('Git packet is too large');
  });

  it('reads packet lines with the caller’s errors', () => {
    expect(packetLines(bytes('0009done\n0000'), errors)).toEqual(['done\n', '']);
    expect(packetLines(bytes('000Adone!\n'), errors)).toEqual(['done!\n']);
    expect(() => packetLines(bytes('zzzz'), errors)).toThrow('invalid');
    expect(() => packetLines(bytes('00'), errors)).toThrow('invalid');
    expect(() => packetLines(bytes('0003'), errors)).toThrow('length');
    expect(() => packetLines(bytes('0009do'), errors)).toThrow('length');
    expect(() => packetLines(bytes('00'), { ...errors, truncatedHeader: () => new Error('header') })).toThrow('header');
    expect(() => parsePackets(bytes('00'))).toThrow('Git returned a truncated packet.');
    expect(() => parsePackets(bytes('zzzz'))).toThrow('Git returned an invalid packet.');
    expect(() => parsePackets(bytes('0003'))).toThrow('Git returned an invalid packet length.');
  });

  it('reads a bounded body and cancels the stream', async () => {
    const limits = { empty: () => new Error('empty'), tooLarge: () => new Error('large') };
    expect(new TextDecoder().decode(await readLimited(stream('ab', 'cd'), 4, limits))).toBe('abcd');
    await expect(readLimited(stream('ab', 'cde'), 4, limits)).rejects.toThrow('large');
    await expect(readLimited(null, 4, limits)).rejects.toThrow('empty');
  });

  it('validates each advertised reference before the caller sees it', () => {
    const header = { header: () => new Error('header'), reference: (line: string) => new Error(`ref:${line}`) };
    const lines = packetLines(advertisement('git-upload-pack', `${sha} HEAD\0symref=HEAD:refs/heads/main\n`, `${sha} refs/heads/main\n`, 'bad\n'), errors);
    const seen: string[] = [];
    expect(() => { for (const entry of advertisedRefs(lines, 'git-upload-pack', header)) seen.push(`${entry.index}:${entry.ref}:${entry.capabilities ?? ''}`); }).toThrow('ref:bad');
    expect(seen).toEqual(['0:HEAD:symref=HEAD:refs/heads/main', '1:refs/heads/main:']);
    expect(() => [...advertisedRefs(lines, 'git-receive-pack', header)]).toThrow('header');
  });

  it('keeps the mirror and URL-import advertisement results', () => {
    const remote = { url: 'https://example.test/repo.git', authorization: '', label: 'GitHub' };
    const mirror = parseAdvertisement(remote, 'git-upload-pack', advertisement('git-upload-pack', `${sha} HEAD\0report-status delete-refs\n`, `${sha} refs/heads/main\n`, `${ZERO_SHA} refs/heads/gone\n`, `${sha} refs/tags/v1^{}\n`));
    expect([...mirror.refs]).toEqual([['refs/heads/main', sha]]);
    expect([...mirror.capabilities]).toEqual(['report-status', 'delete-refs']);
    expect(() => parseAdvertisement(remote, 'git-upload-pack', advertisement('git-upload-pack', `${'b'.repeat(64)} refs/heads/main\n`))).toThrow('GitHub returned a SHA-256 repository, which is not supported.');
    expect(parseSource(advertisement('git-upload-pack', `${sha} HEAD\0symref=HEAD:refs/heads/trunk\n`, `${sha} refs/heads/trunk\n`, `${sha} refs/tags/v1\n`, `${sha} refs/tags/v1^{}\n`))).toEqual({ defaultBranch: 'trunk', headSha: sha, branches: 1, tags: 1 });
    expect(() => parseSource(advertisement('git-upload-pack', `${sha} HEAD\0object-format=sha256\n`, 'bad\n'))).toThrow('SHA-256 repositories are not supported.');
  });
});
