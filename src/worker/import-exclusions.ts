import type { ImportExclusion, ImportExclusionReason, ImportInstallSuggestion } from '../shared/types';
import { detectPackageManager, describeInstall, hasInstallableDependencies, testScript } from './package-manager';

export interface ClassifiedFile { path: string; archivePath: string; data: Uint8Array }

const ALWAYS_SKIPPED: Record<string, ImportExclusionReason> = { '.git': 'git', '.gitflare': 'git', node_modules: 'dependencies', '.venv': 'dependencies', venv: 'dependencies', __MACOSX: 'system', '.DS_Store': 'system' };
const GENERATED_DIRS = new Set(['__pycache__', '.pytest_cache', '.cache', '.next', '.nuxt', '.turbo', '.output', 'coverage']);
const OUTPUT_DIRS = new Set(['build', 'dist']);
const BUNDLE_EXTENSIONS = /\.(?:map|css|html?|wasm|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|otf|txt|json|d\.[cm]?ts)$/i;
const SCRIPT = /\.[cm]?jsx?$/i;
const HASHED = /[.-](?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{8,}(?:\.chunk)?\.[cm]?js$/;
const SCANNED = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i;
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.vue', '.svelte'];
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(['"])(\.\.?\/[^'"\n]+)\1/g;
const SCAN_LIMIT = 512 * 1024;
const decoder = new TextDecoder('utf-8');

function secret(part: string): boolean {
  return part === '.env' || part.startsWith('.env.') && part !== '.env.example' || /^(id_rsa|id_ed25519|credentials\.json)$/i.test(part) || /\.(pem|key)$/i.test(part);
}

export function alwaysSkipped(path: string): ImportExclusionReason | null {
  for (const part of path.split('/')) {
    if (secret(part)) return 'secret';
    if (ALWAYS_SKIPPED[part]) return ALWAYS_SKIPPED[part];
  }
  return null;
}

function text(data: Uint8Array): string { return decoder.decode(data.length > SCAN_LIMIT ? data.subarray(0, SCAN_LIMIT) : data); }

function normalize(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(part);
  }
  return parts.join('/');
}

const dirname = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const join = (base: string, relative: string) => normalize(base ? `${base}/${relative}` : relative);

export function declaredOutputs(files: ClassifiedFile[]): { rooted: Set<string>; anywhere: Set<string> } {
  const rooted = new Set<string>(), anywhere = new Set<string>();
  const add = (base: string, value: string) => { const path = join(base, value.trim()); if (path) rooted.add(path); };
  for (const file of files) {
    const name = file.path.split('/').at(-1)!, base = dirname(file.path);
    if (file.path === '.gitignore') {
      for (const raw of text(file.data).split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('!') || /[*?[]/.test(line)) continue;
        const pattern = line.replace(/^\/+/, '').replace(/\/+$/, '');
        if (!pattern) continue;
        if (line.startsWith('/') || pattern.includes('/')) add('', pattern); else anywhere.add(pattern);
      }
    } else if (/^(?:vite|vitest|astro|svelte|nuxt|next|rollup|webpack|tsup|electron\.vite)\.config\.[cm]?[jt]s$/.test(name)) {
      const source = text(file.data);
      const found = [...source.matchAll(/\boutDir\s*:\s*(['"`])([^'"`\n]+)\1/g)].map(match => match[2]);
      for (const value of found) add(base, value);
      if (/^vite\.config\./.test(name) && !found.length) add(base, 'dist');
    } else if (/^tsconfig[^/]*\.json$/.test(name)) {
      for (const match of text(file.data).matchAll(/"outDir"\s*:\s*"([^"\n]+)"/g)) add(base, match[1]);
    } else if (name === 'package.json') {
      for (const match of text(file.data).matchAll(/--out-?[dD]ir[=\s]+['"]?([^\s'"&|;]+)/g)) add(base, match[1]);
    }
  }
  return { rooted, anywhere };
}

function bundleArtifact(file: ClassifiedFile): boolean {
  if (BUNDLE_EXTENSIONS.test(file.path)) return true;
  if (!SCRIPT.test(file.path)) return false;
  if (HASHED.test(file.path)) return true;
  const source = text(file.data);
  return /\/[/*][#@] sourceMappingURL=/.test(source) || source.startsWith('/******/') || source.split('\n').some(line => line.length > 1000);
}

function outputDirectory(path: string): string | null {
  const parts = path.split('/');
  const index = parts.findIndex((part, position) => position < parts.length - 1 && OUTPUT_DIRS.has(part));
  return index < 0 ? null : parts.slice(0, index + 1).join('/');
}

export function specifiers(file: ClassifiedFile): string[] {
  if (!SCANNED.test(file.path)) return [];
  return [...text(file.data).matchAll(SPECIFIER)].map(match => match[2].split(/[?#]/)[0]);
}

export function resolveSpecifier(from: string, specifier: string, exists: (path: string) => boolean): string | null {
  const target = join(dirname(from), specifier);
  if (target === null || !target) return null;
  const candidates = [target, ...RESOLVE_EXTENSIONS.map(extension => `${target}${extension}`), ...RESOLVE_EXTENSIONS.map(extension => `${target}/index${extension}`)];
  const swapped = /\.([cm]?)jsx?$/.exec(target);
  if (swapped) candidates.push(target.replace(/\.[cm]?jsx?$/, `.${swapped[1]}ts`), target.replace(/\.jsx?$/, '.tsx'));
  return candidates.find(exists) ?? null;
}

export interface Classification { kept: ClassifiedFile[]; exclusions: ImportExclusion[]; warnings: string[] }

export function classifyImport(files: ClassifiedFile[], keep: readonly string[] = []): Classification {
  const requested = new Set(keep);
  const reasons = new Map<string, ImportExclusionReason>();
  for (const file of files) { const reason = alwaysSkipped(file.archivePath) ?? alwaysSkipped(file.path); if (reason) reasons.set(file.path, reason); }
  const candidates = files.filter(file => !reasons.has(file.path));
  const outputs = declaredOutputs(candidates);
  const directories = new Map<string, ClassifiedFile[]>();
  for (const file of candidates) {
    if (file.path.split('/').slice(0, -1).some(part => GENERATED_DIRS.has(part))) { reasons.set(file.path, 'generated'); continue; }
    const directory = outputDirectory(file.path);
    if (directory) directories.set(directory, [...directories.get(directory) ?? [], file]);
  }
  for (const [directory, members] of directories) {
    const declared = outputs.rooted.has(directory) || outputs.anywhere.has(directory.split('/').at(-1)!);
    if (declared || members.every(bundleArtifact)) for (const member of members) reasons.set(member.path, 'generated');
  }
  const byPath = new Map(files.map(file => [file.path, file]));
  const queue = files.filter(file => !reasons.has(file.path) || requested.has(file.archivePath) && reasons.get(file.path) === 'generated');
  for (const file of queue) reasons.delete(file.path);
  const warnings: string[] = [];
  for (let index = 0; index < queue.length; index++) {
    const file = queue[index]!;
    for (const specifier of specifiers(file)) {
      const target = resolveSpecifier(file.path, specifier, path => byPath.has(path));
      if (!target) { warnings.push(`${file.path} imports ${specifier}, which is not in the archive.`); continue; }
      const reason = reasons.get(target);
      if (reason === 'generated') { reasons.delete(target); queue.push(byPath.get(target)!); }
      else if (reason) warnings.push(`${file.path} imports ${specifier}, which is not imported (${reason}).`);
    }
  }
  const exclusions: ImportExclusion[] = files.filter(file => reasons.has(file.path)).map(file => ({ path: file.archivePath, reason: reasons.get(file.path)!, keepable: reasons.get(file.path) === 'generated' }));
  const unknown = [...requested].find(path => !files.some(file => file.archivePath === path && !reasons.has(file.path)));
  if (unknown !== undefined) throw new KeepError(unknown);
  return { kept: files.filter(file => !reasons.has(file.path)), exclusions, warnings: [...new Set(warnings)].slice(0, 50) };
}

export class KeepError extends Error { constructor(readonly path: string) { super(path); } }

export function installSuggestion(files: { path: string; data: Uint8Array }[]): ImportInstallSuggestion | null {
  const find = (path: string) => files.find(file => file.path === path);
  const manifest = find('package.json');
  if (!manifest) return null;
  const paths = files.map(file => file.path), packageJson = text(manifest.data);
  if (!hasInstallableDependencies(paths, packageJson)) return null;
  const policy = find('gitflare.json');
  if (policy) { try { const parsed = JSON.parse(text(policy.data)) as Record<string, unknown>; if (parsed && typeof parsed === 'object' && 'install' in parsed) return null; } catch { return null; } }
  const plan = detectPackageManager({ files: paths, packageJson, lockHead: (() => { const lock = paths.find(path => /^(?:pnpm-lock\.yaml|yarn\.lock)$/.test(path)); return lock ? text(find(lock)!.data).slice(0, 4096) : null; })() });
  if (!plan) return null;
  const manager = plan.installer === 'npm' ? 'npm' : plan.installer === 'pnpm' ? 'pnpm' : 'yarn';
  const script = testScript(packageJson);
  if (script && !/no test specified/.test(script)) return { manager, lockfile: plan.lockfile, automatic: true, message: `Checks run the package.json test script and install dependencies with ${describeInstall(plan)}.` };
  return { manager, lockfile: plan.lockfile, automatic: false, message: `package.json lists dependencies but has no test script, so checks will not install them. Enable dependency install (${describeInstall(plan)}) in the repository check settings before running a test command that needs packages.` };
}
