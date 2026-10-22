import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { ArtifactsBinding } from './artifacts';
import { ApiError } from './domain';
import { boundedBody, packet, parsePackets, requireGitResponse } from './repository-initialization';
import { ZERO_SHA } from './git-protocol';

export interface DemoPerson { name: string; email: string }
export interface DemoCommit { id: string; parent?: string; message: string; author: DemoPerson; at: number; changes: Record<string, string | null> }
export interface DemoHistory { commits: DemoCommit[]; refs: Record<string, string> }
export interface BuiltDemoHistory { pack: Uint8Array; shas: Record<string, string>; refs: Record<string, string>; snapshots: Record<string, Record<string, string>>; objectCount: number }

type GitObject = { type: 'blob' | 'tree' | 'commit'; data: Buffer; hash: string };

function gitObject(type: GitObject['type'], data: Buffer): GitObject {
  return { type, data, hash: createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex') };
}

function packEntry(object: GitObject): Buffer {
  let size = object.data.length;
  const bytes = [{ commit: 1, tree: 2, blob: 3 }[object.type] << 4 | size & 15];
  size = Math.floor(size / 16);
  if (size) bytes[0] |= 128;
  while (size) { const byte = size & 127; size = Math.floor(size / 128); bytes.push(byte | (size ? 128 : 0)); }
  return Buffer.concat([Buffer.from(bytes), deflateSync(object.data)]);
}

interface TreeNode { files: Map<string, string>; dirs: Map<string, TreeNode> }

function writeTree(node: TreeNode, objects: Map<string, GitObject>): string {
  const entries: { name: string; sortKey: string; mode: string; hash: string }[] = [];
  for (const [name, hash] of node.files) entries.push({ name, sortKey: name, mode: '100644', hash });
  for (const [name, child] of node.dirs) entries.push({ name, sortKey: `${name}/`, mode: '40000', hash: writeTree(child, objects) });
  entries.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  const tree = gitObject('tree', Buffer.concat(entries.map((entry) => Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.hash, 'hex')]))));
  objects.set(tree.hash, tree);
  return tree.hash;
}

function snapshotTree(snapshot: Record<string, string>, objects: Map<string, GitObject>): string {
  const root: TreeNode = { files: new Map(), dirs: new Map() };
  for (const path of Object.keys(snapshot).sort()) {
    const parts = path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part);
      if (!next) { next = { files: new Map(), dirs: new Map() }; node.dirs.set(part, next); }
      node = next;
    }
    const blob = gitObject('blob', Buffer.from(snapshot[path], 'utf8'));
    objects.set(blob.hash, blob);
    node.files.set(parts.at(-1)!, blob.hash);
  }
  return writeTree(root, objects);
}

export function buildDemoHistory(history: DemoHistory): BuiltDemoHistory {
  const objects = new Map<string, GitObject>();
  const shas: Record<string, string> = {};
  const snapshots: Record<string, Record<string, string>> = {};
  for (const commit of history.commits) {
    if (shas[commit.id]) throw new Error(`Duplicate demo commit ${commit.id}`);
    if (commit.parent && !shas[commit.parent]) throw new Error(`Demo commit ${commit.id} names unknown parent ${commit.parent}`);
    const snapshot = { ...(commit.parent ? snapshots[commit.parent] : {}) };
    for (const [path, content] of Object.entries(commit.changes)) if (content === null) delete snapshot[path]; else snapshot[path] = content;
    const tree = snapshotTree(snapshot, objects);
    const person = `${commit.author.name} <${commit.author.email}> ${commit.at} +0000`;
    const object = gitObject('commit', Buffer.from(`tree ${tree}\n${commit.parent ? `parent ${shas[commit.parent]}\n` : ''}author ${person}\ncommitter ${person}\n\n${commit.message}\n`));
    objects.set(object.hash, object);
    shas[commit.id] = object.hash;
    snapshots[commit.id] = snapshot;
  }
  const refs = Object.fromEntries(Object.entries(history.refs).map(([ref, id]) => {
    if (!shas[id]) throw new Error(`Demo ref ${ref} names unknown commit ${id}`);
    return [ref, shas[id]];
  }));
  const ordered = [...objects.values()];
  const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(ordered.length, 8);
  const body = Buffer.concat([header, ...ordered.map(packEntry)]);
  return { pack: new Uint8Array(Buffer.concat([body, createHash('sha1').update(body).digest()])), shas, refs, snapshots, objectCount: ordered.length };
}

export async function pushDemoHistory(artifacts: ArtifactsBinding, name: string, built: BuiltDemoHistory, fetcher: typeof fetch = fetch): Promise<void> {
  using repository = await artifacts.get(name);
  const info = await repository.info();
  const base = new URL(info.remote).href.replace(/\/$/, '');
  const token = await repository.createToken('write', 120);
  try {
    const headers = { authorization: `Bearer ${token.plaintext}` };
    const discovery = await fetcher(`${base}/info/refs?service=git-receive-pack`, { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    requireGitResponse(discovery, 'application/x-git-receive-pack-advertisement');
    const advertised = parsePackets(await boundedBody(discovery)).slice(2).filter(Boolean);
    if (advertised.some((line) => !line.startsWith(ZERO_SHA))) throw new ApiError(409, 'REPOSITORY_NOT_EMPTY', `Demo repository ${name} already has history; reset refuses to overwrite it.`);
    const refs = Object.entries(built.refs);
    const commands = refs.map(([ref, sha], index) => packet(`${ZERO_SHA} ${sha} ${ref}${index === 0 ? '\0report-status' : ''}\n`));
    const response = await fetcher(`${base}/git-receive-pack`, { method: 'POST', headers: { ...headers, 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result' }, body: new Uint8Array(Buffer.concat([...commands, Buffer.from('0000'), built.pack])), redirect: 'manual', signal: AbortSignal.timeout(30000) });
    requireGitResponse(response, 'application/x-git-receive-pack-result');
    const status = parsePackets(await boundedBody(response)).filter(Boolean).map((line) => line.trimEnd());
    const expected = ['unpack ok', ...refs.map(([ref]) => `ok ${ref}`)];
    if (status.length !== expected.length || expected.some((line) => !status.includes(line))) throw new ApiError(502, 'DEMO_PUSH_REJECTED', `Git did not confirm every demo ref for ${name}: ${status.join('; ').slice(0, 300)}`);
  } finally { await repository.revokeToken(token.plaintext); }
}
