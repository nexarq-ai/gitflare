import type { CodeownerGroup } from '../shared/notifications';
import type { ArtifactsBinding } from './artifacts';

export const CODEOWNERS_PATHS = ['.gitflare/CODEOWNERS', '.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const;
export const CODEOWNERS_MAX_BYTES = 65_536;
export const CODEOWNERS_MAX_RULES = 500;
export const CODEOWNERS_MAX_OWNERS = 20;
const HANDLE = /^@([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)$/i;

export interface CodeownersRule { pattern: string; owners: string[]; matcher: RegExp }
export interface Codeowners { source: string | null; rules: CodeownersRule[]; ignored: string[] }

function escape(value: string): string { return value.replace(/[.+^${}()|[\]\\]/g, '\\$&'); }

export function patternMatcher(pattern: string): RegExp | null {
  let body = pattern.trim();
  if (!body || body.includes('\\') || body.startsWith('!') || body.includes('[')) return null;
  const directory = body.endsWith('/');
  if (directory) body = body.slice(0, -1);
  const anchored = body.startsWith('/') || body.includes('/');
  body = body.replace(/^\/+/, '');
  if (!body) return /^.*$/;
  let source = '';
  for (let index = 0; index < body.length; index++) {
    const character = body[index]!;
    if (character === '*' && body[index + 1] === '*') {
      const slash = body[index + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += escape(character);
  }
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${source}(?:/.*)?$`);
}

export function parseCodeowners(text: string, source: string | null = null): Codeowners {
  const rules: CodeownersRule[] = [];
  const ignored: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const [pattern, ...entries] = line.split(/\s+/);
    const matcher = patternMatcher(pattern!);
    if (!matcher) { ignored.push(pattern!); continue; }
    const owners: string[] = [];
    for (const entry of entries) {
      const handle = HANDLE.exec(entry)?.[1];
      if (handle) { if (!owners.includes(handle.toLowerCase())) owners.push(handle.toLowerCase()); }
      else if (!ignored.includes(entry)) ignored.push(entry);
    }
    rules.push({ pattern: pattern!, owners: owners.slice(0, CODEOWNERS_MAX_OWNERS), matcher });
    if (rules.length >= CODEOWNERS_MAX_RULES) break;
  }
  return { source, rules, ignored: ignored.slice(0, 50) };
}

export function ownersOf(codeowners: Codeowners, path: string): string[] {
  let owners: string[] = [];
  for (const rule of codeowners.rules) if (rule.matcher.test(path)) owners = rule.owners;
  return owners;
}

export function ownerHandleGroups(codeowners: Codeowners, paths: string[]): { handles: string[]; paths: string[] }[] {
  const groups = new Map<string, { handles: string[]; paths: string[] }>();
  for (const path of paths) {
    const owners = ownersOf(codeowners, path);
    if (!owners.length) continue;
    const id = [...owners].sort().join(' ');
    const group = groups.get(id) ?? { handles: owners, paths: [] };
    if (group.paths.length < 50) group.paths.push(path);
    groups.set(id, group);
  }
  return [...groups.values()];
}

export async function readCodeowners(artifacts: ArtifactsBinding, repositoryName: string, ref: string): Promise<Codeowners> {
  using source = await artifacts.get(repositoryName);
  for (const path of CODEOWNERS_PATHS) {
    const file = await source.readFile({ ref, path }).catch(() => null);
    if (!file) continue;
    if (file.size > CODEOWNERS_MAX_BYTES) return { source: path, rules: [], ignored: ['file larger than 64 KiB'] };
    return parseCodeowners(await file.text(), path);
  }
  return { source: null, rules: [], ignored: [] };
}

export async function resolveOwnerGroups(groups: { handles: string[]; paths: string[] }[], resolve: (handles: string[]) => Promise<Record<string, string>>): Promise<CodeownerGroup[]> {
  const ids = await resolve([...new Set(groups.flatMap(group => group.handles))]);
  return groups.map(group => ({ handles: group.handles, userIds: [...new Set(group.handles.flatMap(handle => ids[handle] ? [ids[handle]!] : []))], paths: group.paths }));
}
