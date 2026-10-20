import type { IssueTemplate, IssueTemplates } from '../shared/types';
import { issueLabel } from './issues';
import type { SourceHandle } from './source-browse';

export const ISSUE_TEMPLATE_DIRECTORIES = ['.gitflare/ISSUE_TEMPLATE', '.github/ISSUE_TEMPLATE'] as const;
export const ISSUE_TEMPLATES_MAX = 20;
export const ISSUE_TEMPLATE_MAX_BYTES = 16_384;
const TEMPLATE_FILE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}\.md$/;

function scalar(value: string): string {
  const trimmed = value.trim();
  const quoted = /^"(.*)"$/.exec(trimmed) ?? /^'(.*)'$/.exec(trimmed);
  return (quoted ? quoted[1]! : trimmed).replace(/\\"/g, '"');
}

function labels(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) { try { const label = issueLabel(scalar(value)); if (!result.some((item) => item.toLowerCase() === label.toLowerCase())) result.push(label); } catch { continue; } }
  return result.slice(0, 10);
}

export function parseIssueTemplate(file: string, source: string): IssueTemplate {
  const text = source.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const fields: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let open: string | null = null;
  for (const line of match ? match[1]!.split('\n') : []) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && open) { (lists[open] ??= []).push(item[1]!); continue; }
    const pair = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!pair) { open = null; continue; }
    const name = pair[1]!.toLowerCase(), value = pair[2]!;
    open = value.trim() ? null : name;
    if (/^\[.*\]$/.test(value.trim())) lists[name] = value.trim().slice(1, -1).split(',').filter((entry) => entry.trim());
    else if (name === 'labels' && value.trim()) lists[name] = value.split(',');
    else fields[name] = value;
  }
  const fallback = file.replace(/\.md$/, '').replace(/[-_]+/g, ' ').trim();
  return {
    file,
    name: scalar(fields.name ?? '').slice(0, 100) || fallback.charAt(0).toUpperCase() + fallback.slice(1),
    about: scalar(fields.about ?? fields.description ?? '').slice(0, 300),
    title: scalar(fields.title ?? '').slice(0, 200),
    labels: labels(lists.labels ?? []),
    body: (match ? text.slice(match[0].length) : text).replace(/^\n+/, '').slice(0, 20_000),
  };
}

export async function readIssueTemplates(source: SourceHandle, ref: string): Promise<IssueTemplates> {
  const commit = (await source.log({ ref, limit: 1 }).catch(() => []))[0];
  if (!commit) return { directory: null, commitSha: null, templates: [] };
  for (const directory of ISSUE_TEMPLATE_DIRECTORIES) {
    let tree = await source.readTree(commit.treeHash).catch(() => null);
    for (const segment of directory.split('/')) {
      const entry = tree?.find((item) => item.name === segment && item.type === 'tree');
      tree = entry ? await source.readTree(entry.hash).catch(() => null) : null;
    }
    const files = (tree ?? []).filter((entry) => entry.type !== 'tree' && TEMPLATE_FILE.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, ISSUE_TEMPLATES_MAX);
    if (!files.length) continue;
    const templates: IssueTemplate[] = [];
    for (const file of files) {
      const blob = await source.readFile({ ref: commit.hash, path: `${directory}/${file.name}` }).catch(() => null);
      if (!blob || blob.size > ISSUE_TEMPLATE_MAX_BYTES) continue;
      const text = await blob.text().catch(() => '');
      if (text && !text.includes('\0')) templates.push(parseIssueTemplate(file.name, text));
    }
    return { directory, commitSha: commit.hash, templates };
  }
  return { directory: null, commitSha: commit.hash, templates: [] };
}
