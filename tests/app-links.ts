import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REPOSITORY_SETTINGS_PATHS = ['settings', 'settings/branches', 'settings/streams', 'streams', 'settings/secrets', 'settings/mirror', 'settings/github-mirror', 'settings/previews', 'settings/checks', 'settings/cloudflare', 'settings/deploys', 'settings/deployments', 'settings/environments', 'deployments', 'settings/access'];

function literal(value: string): string | null {
  const path = value.replace(/\$\{[^}]*\}/g, 'abc').replace(/\?.*$/, '');
  return path.includes('$') || path.includes('{') || /^\/?abc(\/|$)/.test(path) ? null : path.startsWith('/') ? path : `/${path}`;
}

export function appLinks(root = '.'): string[] {
  const links = new Set<string>(REPOSITORY_SETTINGS_PATHS.map(path => `/repository/abc/${path}`));
  const dir = join(root, 'src/ui');
  for (const name of readdirSync(dir).filter(file => file.endsWith('.tsx'))) {
    const source = readFileSync(join(dir, name), 'utf8');
    for (const match of source.matchAll(/navigate\(\s*[`"]([^`"]+)[`"]/g)) { const path = literal(match[1]!); if (path) links.add(path); }
    for (const match of source.matchAll(/href=\{?[`"](\/[^`"#]*)/g)) { const path = literal(match[1]!); if (path) links.add(path); }
    const tabOwner = name === 'App.tsx' ? 'repository' : name === 'MissionDetail.tsx' ? 'mission' : null;
    const tabs = tabOwner === 'repository' ? source.slice(source.indexOf('aria-label="Repository navigation"'), source.indexOf('].map', source.indexOf('aria-label="Repository navigation"'))) : source;
    if (tabOwner) for (const match of tabs.matchAll(/\{ value: "([a-z/]+)", label:/g)) links.add(`/${tabOwner}/abc/${match[1]}`);
  }
  return [...links].filter(path => !/^\/(?:api|mcp|oauth)\//.test(path)).sort();
}
