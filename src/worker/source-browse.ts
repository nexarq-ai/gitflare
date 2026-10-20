import type { Repository } from '../shared/types';
import { ApiError, repositoryPath, repositoryRef } from './domain';
import type { AppEnv } from './env';

export type SourceHandle = Awaited<ReturnType<NonNullable<AppEnv['ARTIFACTS']>['get']>>;
export type SourceCommit = Awaited<ReturnType<SourceHandle['log']>>[number];
export interface CandidateSources { find(commitSha: string): Promise<{ missionId: string; forkName?: string } | undefined>; matching?(prefix: string): Promise<string[]>; authorize(missionId: string): Promise<void> }

const SHORT_SHA = /^[a-f0-9]{7,39}$/;
const PREFIX_HISTORY_LIMIT = 1000;

export async function resolveShortSha(source: SourceHandle, repository: Repository, prefix: string, candidates?: CandidateSources): Promise<string | null> {
  const history = await source.log({ ref: repository.defaultBranch, limit: PREFIX_HISTORY_LIMIT }).catch(() => []);
  const matches = new Set(history.map((commit) => commit.hash).filter((hash) => hash.startsWith(prefix)));
  for (const sha of await candidates?.matching?.(prefix) ?? []) matches.add(sha);
  if (matches.size > 1) throw new ApiError(409, 'AMBIGUOUS_REF', `Commit prefix ${prefix} matches ${matches.size} commits (${[...matches].slice(0, 5).map((sha) => sha.slice(0, 12)).join(', ')}). Pass more characters or the full SHA.`);
  return matches.size ? [...matches][0]! : null;
}

async function openFork(env: AppEnv, name: string): Promise<SourceHandle | null> {
  try { return await env.ARTIFACTS!.get(name); } catch { return null; }
}

export async function browseRepository(env: AppEnv, repository: Repository, kind: string, url: URL, candidates?: CandidateSources): Promise<Response> {
  if (!env.ARTIFACTS || repository.provider !== 'artifacts') throw new ApiError(409, 'REPOSITORY_NOT_CONNECTED', 'Connect an Artifacts repository to browse its source.');
  const ref = repositoryRef(url.searchParams.get('ref') || repository.defaultBranch);
  const path = repositoryPath(url.searchParams.get('path') ?? '', kind === 'tree');
  using source = await env.ARTIFACTS.get(repository.name);
  const commit = (await source.log({ ref, limit: 1 }))[0];
  if (commit) return await sourceView(source, commit, kind, path, ref);
  const resolved = SHORT_SHA.test(ref) ? await resolveShortSha(source, repository, ref, candidates) : null;
  if (resolved) {
    const full = new URL(url);
    full.searchParams.set('ref', resolved);
    return await browseRepository(env, repository, kind, full, candidates);
  }
  const fullSha = /^[a-f0-9]{40}$/.test(ref);
  const candidate = fullSha && candidates ? await candidates.find(ref) : undefined;
  if (candidate) {
    await candidates!.authorize(candidate.missionId);
    using fork = candidate.forkName ? await openFork(env, candidate.forkName) : null;
    const held = fork ? (await fork.log({ ref, limit: 1 }).catch(() => []))[0] : undefined;
    if (fork && held?.hash === ref) return await sourceView(fork, held, kind, path, ref, candidate.missionId);
    throw new ApiError(404, 'MISSION_CANDIDATE_UNAVAILABLE', `Commit ${ref.slice(0, 12)} is a candidate of mission ${candidate.missionId}, and the fork that held it can no longer be read. This commit is a mission candidate; use gitflare_inspect_mission view changes (GET /api/missions/${candidate.missionId}) to read its diff.`);
  }
  if (fullSha) throw new ApiError(404, 'REF_NOT_FOUND', `Commit ${ref.slice(0, 12)} is not in this repository or in any of its mission candidates. Pass a branch, tag or a commit from gitflare_inspect_mission.`);
  if (SHORT_SHA.test(ref)) throw new ApiError(404, 'REF_NOT_FOUND', `No commit starting with ${ref} is in the last ${PREFIX_HISTORY_LIMIT} commits of ${repository.defaultBranch} or among this repository's mission candidates. Pass the full SHA, a branch or a tag.`);
  throw new ApiError(404, 'REF_NOT_FOUND', 'This branch, tag, or commit does not exist. Push an initial commit if the repository is empty.');
}

export async function sourceView(source: SourceHandle, commit: SourceCommit, kind: string, path: string, ref: string, missionId?: string): Promise<Response> {
  const origin = missionId ? { missionId, source: 'mission-candidate' as const } : {};
  if (kind === 'file') {
    const blob = await source.readFile({ ref: commit.hash, path });
    if (!blob) throw new ApiError(404, 'FILE_NOT_FOUND', 'This file could not be found at the selected commit.');
    if (blob.size > 524_288) throw new ApiError(413, 'FILE_TOO_LARGE', 'The source viewer supports files up to 512 KB. Clone the repository to inspect this file.');
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer());
    } catch {
      throw new ApiError(415, 'BINARY_FILE', 'This file contains binary data. Clone the repository to inspect it.');
    }
    if (content.includes('\0')) throw new ApiError(415, 'BINARY_FILE', 'This file contains binary data. Clone the repository to inspect it.');
    return Response.json({ path, content, commitSha: commit.hash, ...origin });
  }
  let tree = await source.readTree(commit.treeHash);
  for (const segment of path ? path.split('/') : []) {
    const entry = tree?.find((item) => item.name === segment && item.type === 'tree');
    if (!entry) throw new ApiError(404, 'DIRECTORY_NOT_FOUND', 'This directory could not be found at the selected commit.');
    tree = await source.readTree(entry.hash);
  }
  if (!tree) throw new ApiError(404, 'DIRECTORY_NOT_FOUND', 'This directory could not be found at the selected commit.');
  if (tree.length > 5000) throw new ApiError(413, 'DIRECTORY_TOO_LARGE', 'This directory contains more than 5,000 entries. Clone the repository to browse it.');
  const entries = tree.map((entry) => ({ name: entry.name, path: path ? `${path}/${entry.name}` : entry.name, type: entry.type === 'tree' ? 'directory' : 'file' })).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return Response.json({ entries, ref, commitSha: commit.hash, ...origin });
}
