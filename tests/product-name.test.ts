import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const DEPRECATED_ENV = /\bGITBRAID_[A-Z_]+\b/g;

function files(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    if (relative(root, path) === join('docs', 'journal') || name === 'screenshots') return [];
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function offending(path: string): string[] {
  const scripts = relative(root, path).startsWith('scripts/');
  return readFileSync(path, 'utf8').split('\n').flatMap((line, index) => {
    if (scripts && line.includes('GITBRAID_')) return [];
    const text = line.replace(DEPRECATED_ENV, '');
    return /gitbraid/i.test(text) ? [`${relative(root, path)}:${index + 1}`] : [];
  });
}

describe('product name', () => {
  it('uses only Gitflare as the product name in source, scripts and current docs', () => {
    const scanned = ['src', 'scripts', 'docs'].flatMap(directory => files(resolve(root, directory))).filter(path => /\.(?:ts|tsx|mjs|js|css|json|md|html)$/.test(path));
    expect(scanned.length).toBeGreaterThan(50);
    expect(scanned.flatMap(offending)).toEqual([]);
  });
});
