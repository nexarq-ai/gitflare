import type { AutoIncrease, CheckLimitSource, CheckPlan, CheckTimeout, RunnerSize, TestEvidence } from '../shared/types';
import { MAX_TEST_TIMEOUT_MS } from './budgets';
import { detectPackageManager, hasInstallableDependencies, runnerFor, testScript, type InstallPlan, type PackageManager } from './package-manager';

export const POLICY_FILE = 'gitflare.json';
export const DEFAULT_EDITABLE = ['src/', 'docs/', 'public/', 'static/', 'assets/', 'README.md'];

export type { RunnerSize } from '../shared/types';
export const RUNNER_SIZES: readonly RunnerSize[] = ['standard-1', 'standard-2', 'standard-3', 'standard-4'];
export const DEFAULT_RUNNER: RunnerSize = 'standard-1';
export const PACKAGE_SCRIPT_RUNNER: RunnerSize = 'standard-2';
export const DEFAULT_TEST_TIMEOUT_MS = 120_000;
export const PACKAGE_SCRIPT_TEST_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_SECONDS = 10;
export const MAX_TIMEOUT_SECONDS = MAX_TEST_TIMEOUT_MS / 1000;

export function isRunnerSize(value: unknown): value is RunnerSize {
  return RUNNER_SIZES.includes(value as RunnerSize);
}

export const DEFAULT_AUTO_INCREASE: AutoIncrease = { enabled: true, maxTimeoutSeconds: 900, maxRunner: 'standard-3' };

export function autoIncreaseOf(settings?: CheckPlan | null): AutoIncrease {
  return settings?.autoIncrease ?? DEFAULT_AUTO_INCREASE;
}

export function isFixedSource(source: CheckLimitSource): boolean { return source === 'gitflare.json' || source === 'owner'; }

export function escalatedLimits(timeout: CheckTimeout, auto: AutoIncrease): { seconds: number; runner: RunnerSize } | null {
  if (!auto.enabled) return null;
  const seconds = isFixedSource(timeout.timeoutSource) ? timeout.seconds : Math.max(timeout.seconds, Math.min(timeout.seconds * 2, MAX_TIMEOUT_SECONDS, auto.maxTimeoutSeconds));
  const current = RUNNER_SIZES.indexOf(timeout.runner);
  const runner = isFixedSource(timeout.runnerSource) ? timeout.runner : RUNNER_SIZES[Math.max(current, Math.min(current + 1, RUNNER_SIZES.indexOf(auto.maxRunner)))]!;
  return seconds > timeout.seconds || runner !== timeout.runner ? { seconds, runner } : null;
}

export function isPackageScriptTest(command: string): boolean {
  return /^(?:npm|pnpm|yarn)(?:\s+run)?\s+test(?:\s|$)/.test(command.trim());
}

export function defaultTestTimeoutMs(command: string): number {
  return isPackageScriptTest(command) ? PACKAGE_SCRIPT_TEST_TIMEOUT_MS : DEFAULT_TEST_TIMEOUT_MS;
}

export function defaultCheckRunner(command: string): RunnerSize {
  return isPackageScriptTest(command) ? PACKAGE_SCRIPT_RUNNER : DEFAULT_RUNNER;
}

export type EvidenceSource = 'gitflare.json' | 'owner' | 'default';
export type InstallSource = 'gitflare.json' | 'owner' | 'detected';

export interface RepositoryPolicy {
  testCommand: string;
  evidence: TestEvidence;
  evidenceSource?: EvidenceSource;
  editable: string[];
  install: InstallPlan | null;
  installSource?: InstallSource;
  dependencies?: boolean;
  previewCommand: string;
  testTimeoutMs: number;
  testTimeoutSource: CheckLimitSource;
  runner: RunnerSize;
  runnerSource: CheckLimitSource;
  autoIncrease: AutoIncrease;
  starter: boolean;
  untested: boolean;
  generated: GeneratedFiles | null;
  manifest?: boolean;
}

export interface GeneratedFiles { paths: string[]; command: string | null }
export const MAX_GENERATED_PATHS = 50;

export interface PathChange { path: string; status: string }
export interface StarterCheck { testCommand: string; evidence: RepositoryPolicy['evidence']; install: InstallPlan | null }

const DEFAULT_PREVIEW = 'node src/preview.mjs';
export const LOCKFILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/;
const ALWAYS_PROTECTED = /(^|\/)(package\.json|pnpm-workspace\.yaml|\.pnpmfile\.c?js|\.yarnrc|\.yarnrc\.yml|\.pnp\.c?js|\.pnp\.loader\.mjs|gitflare\.json|\.npmrc)$|(^|\/)\.yarn\/|^\.(git|github)(\/|$)/;
const TEST_PATHS = /(^|\/)(__tests__|tests?|node_modules)(\/|$)|\.(test|spec)\.[^.\/]+$|_test\.[^.\/]+$|(^|\/)(test_[^\/]+|conftest)\.py$/;

function command(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${POLICY_FILE}: "${field}" must be a single-line command of at most 500 characters`);
  return value.trim();
}

function editablePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 200 || value.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(value) || value.split('/').some((part, index, parts) => part === '..' || part === '.' || (!part && index !== parts.length - 1))) throw new Error(`${POLICY_FILE}: "editable" entries must be repository-relative files or directories ending in "/"`);
  return value;
}

function generatedFiles(value: unknown): GeneratedFiles {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${POLICY_FILE}: "generated" must be an object with "paths" and an optional "command"`);
  const fields = value as Record<string, unknown>;
  const unknown = Object.keys(fields).find((key) => key !== 'paths' && key !== 'command');
  if (unknown) throw new Error(`${POLICY_FILE}: unsupported field "generated.${unknown}"`);
  if (!Array.isArray(fields.paths) || !fields.paths.length || fields.paths.length > MAX_GENERATED_PATHS) throw new Error(`${POLICY_FILE}: "generated.paths" must list between 1 and ${MAX_GENERATED_PATHS} files or globs`);
  const paths = fields.paths.map((entry) => {
    if (typeof entry !== 'string' || !entry || entry.length > 200 || entry.startsWith('/') || entry.endsWith('/') || /[\\\u0000-\u001f\u007f]/.test(entry) || entry.split('/').some((part) => !part || part === '.' || part === '..') || entry === POLICY_FILE || /^\.git(\/|$)/.test(entry)) throw new Error(`${POLICY_FILE}: "generated.paths" entries must be repository-relative files or globs such as "src/generated/**"`);
    return entry;
  });
  return { paths, command: fields.command === undefined ? null : command(fields.command, 'generated.command') };
}

function globPattern(glob: string): RegExp {
  let pattern = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === '*' && glob[index + 1] === '*') {
      const slash = glob[index + 2] === '/';
      pattern += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (char === '*') pattern += '[^/]*';
    else if (char === '?') pattern += '[^/]';
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

export function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globPattern(glob).test(path));
}

export const isGeneratedPath = matchesGlobs;

const INSTALL_VALUES = ['npm', 'pnpm', 'yarn', 'auto'];

function startingTimeout(command: string, settings: CheckPlan | null | undefined): [number, CheckLimitSource] {
  const fallback = defaultTestTimeoutMs(command);
  const auto = autoIncreaseOf(settings);
  const learned = auto.enabled && settings?.learnedTimeoutSeconds ? Math.min(settings.learnedTimeoutSeconds, auto.maxTimeoutSeconds, MAX_TIMEOUT_SECONDS) * 1000 : 0;
  return learned > fallback ? [learned, 'learned'] : [fallback, 'default'];
}

export function defaultEvidence(command: string): TestEvidence {
  return isPackageScriptTest(command) ? 'exit-code' : 'tap';
}

function withOwnerPolicy(policy: RepositoryPolicy, settings?: CheckPlan | null): RepositoryPolicy {
  const owner = settings?.policyOverride;
  if (!owner?.test && !owner?.evidence) return policy;
  const testCommand = owner.test ?? policy.testCommand;
  const evidence = owner.evidence ?? (owner.test ? defaultEvidence(owner.test) : policy.evidence);
  return { ...policy, testCommand, evidence, evidenceSource: owner.evidence ? 'owner' : owner.test ? 'default' : policy.evidenceSource, ...(owner.test ? { untested: false } : {}) };
}

function withLimits(base: RepositoryPolicy, explicit: { timeoutSeconds?: number; runner?: RunnerSize }, settings?: CheckPlan | null): RepositoryPolicy {
  const policy = withOwnerPolicy(base, settings);
  const owner = settings?.policyOverride;
  const timeout: [number, CheckLimitSource] = settings?.override?.testTimeoutSeconds !== undefined ? [settings.override.testTimeoutSeconds * 1000, 'owner'] : owner?.testTimeoutSeconds !== undefined ? [owner.testTimeoutSeconds * 1000, 'owner'] : explicit.timeoutSeconds !== undefined ? [explicit.timeoutSeconds * 1000, 'gitflare.json'] : settings?.testTimeoutSeconds !== undefined ? [settings.testTimeoutSeconds * 1000, 'repository'] : startingTimeout(policy.testCommand, settings);
  const runner: [RunnerSize, CheckLimitSource] = settings?.override?.runner !== undefined ? [settings.override.runner, 'owner'] : owner?.runner !== undefined ? [owner.runner, 'owner'] : explicit.runner !== undefined ? [explicit.runner, 'gitflare.json'] : settings?.runner !== undefined ? [settings.runner, 'repository'] : [defaultCheckRunner(policy.testCommand), 'default'];
  return { ...policy, testTimeoutMs: timeout[0], testTimeoutSource: timeout[1], runner: runner[0], runnerSource: runner[1], autoIncrease: autoIncreaseOf(settings) };
}

export function startingTimeoutMs(command: string, settings?: CheckPlan | null): number {
  return startingTimeout(command, settings)[0];
}

function withOwnerInstall(policy: RepositoryPolicy, baseFiles: string[] | undefined, packageJson: string | null | undefined, lockHead: string | null | undefined, settings?: CheckPlan | null): RepositoryPolicy {
  const owner = settings?.install?.value;
  if (!owner || !baseFiles) return policy;
  if (owner === 'none') return { ...policy, install: null, installSource: 'owner' };
  const install = baseFiles.includes('package.json') && packageJson ? configuredInstall(owner, baseFiles, packageJson, lockHead) : null;
  return { ...policy, install, installSource: 'owner' };
}

export function parseRepositoryPolicy(raw: string | null, defaultTestCommand: string, baseFiles?: string[], basePackageJson?: string | null, baseLockHead?: string | null, settings?: CheckPlan | null): RepositoryPolicy {
  const dependencies = !!baseFiles && hasInstallableDependencies(baseFiles, basePackageJson ?? null);
  const fallback: RepositoryPolicy = { testCommand: defaultTestCommand, evidence: 'tap', editable: DEFAULT_EDITABLE, install: null, previewCommand: DEFAULT_PREVIEW, testTimeoutMs: DEFAULT_TEST_TIMEOUT_MS, testTimeoutSource: 'default', runner: DEFAULT_RUNNER, runnerSource: 'default', autoIncrease: DEFAULT_AUTO_INCREASE, starter: false, untested: false, generated: null };
  if (raw === null) {
    if (baseFiles === undefined) return withLimits(fallback, {}, settings);
    const untested = !baseFiles.some((path) => TEST_PATHS.test(path) && !path.includes('node_modules/'));
    const scripted = basePackageJson !== undefined && basePackageJson !== null ? packageTestCheck(baseFiles, basePackageJson, baseLockHead) : null;
    const detected: RepositoryPolicy = { ...fallback, starter: isStarterRepository(baseFiles), untested, manifest: baseFiles.includes('package.json'), dependencies, ...(scripted ? { testCommand: scripted.testCommand, evidence: scripted.evidence, install: scripted.install, ...(scripted.install ? { installSource: 'detected' as const } : {}) } : {}) };
    return withLimits(withOwnerInstall(detected, baseFiles, basePackageJson, baseLockHead, settings), {}, settings);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${POLICY_FILE} is not valid JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${POLICY_FILE} must contain a JSON object`);
  const fields = parsed as Record<string, unknown>;
  const unknown = Object.keys(fields).filter((key) => !['test', 'evidence', 'editable', 'install', 'preview', 'timeoutSeconds', 'runner', 'generated', 'deploy'].includes(key));
  if (unknown.length) throw new Error(`${POLICY_FILE}: unsupported field "${unknown[0]}"`);
  const policy: RepositoryPolicy = { ...fallback, ...(baseFiles ? { manifest: baseFiles.includes('package.json'), dependencies } : {}) };
  if (fields.test !== undefined) policy.testCommand = command(fields.test, 'test');
  if (fields.preview !== undefined) policy.previewCommand = command(fields.preview, 'preview');
  if (fields.evidence !== undefined) {
    if (fields.evidence !== 'tap' && fields.evidence !== 'exit-code') throw new Error(`${POLICY_FILE}: "evidence" must be "tap" or "exit-code"`);
    policy.evidence = fields.evidence;
    policy.evidenceSource = 'gitflare.json';
  } else policy.evidence = defaultEvidence(policy.testCommand);
  if (fields.install !== undefined) {
    if (fields.install !== false && !INSTALL_VALUES.includes(fields.install as string)) throw new Error(`${POLICY_FILE}: "install" must be "npm", "pnpm", "yarn", "auto" or false`);
    policy.install = fields.install === false ? null : configuredInstall(fields.install as PackageManager | 'auto', baseFiles ?? [], basePackageJson ?? null, baseLockHead);
    policy.installSource = 'gitflare.json';
  }
  const explicit: { timeoutSeconds?: number; runner?: RunnerSize } = {};
  if (fields.timeoutSeconds !== undefined) {
    if (!Number.isInteger(fields.timeoutSeconds) || (fields.timeoutSeconds as number) < MIN_TIMEOUT_SECONDS || (fields.timeoutSeconds as number) > MAX_TIMEOUT_SECONDS) throw new Error(`${POLICY_FILE}: "timeoutSeconds" must be a whole number between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS}`);
    explicit.timeoutSeconds = fields.timeoutSeconds as number;
  }
  if (fields.runner !== undefined) {
    if (!isRunnerSize(fields.runner)) throw new Error(`${POLICY_FILE}: "runner" must be one of ${RUNNER_SIZES.map((size) => `"${size}"`).join(', ')}`);
    explicit.runner = fields.runner;
  }
  if (fields.editable !== undefined) {
    if (!Array.isArray(fields.editable) || !fields.editable.length || fields.editable.length > 20) throw new Error(`${POLICY_FILE}: "editable" must list between 1 and 20 paths`);
    policy.editable = fields.editable.map(editablePath);
  }
  if (fields.generated !== undefined) policy.generated = generatedFiles(fields.generated);
  return withLimits(fields.install === undefined ? withOwnerInstall(policy, baseFiles, basePackageJson, baseLockHead, settings) : policy, explicit, settings);
}

function configuredInstall(value: PackageManager | 'auto', files: string[], packageJson: string | null, lockHead: string | null | undefined): InstallPlan | null {
  if (value === 'auto') return hasInstallableDependencies(files, packageJson) ? detectPackageManager({ files, packageJson, lockHead }) : null;
  return detectPackageManager({ files, packageJson: packageJson ?? '{}', lockHead, prefer: value });
}

const PACKAGE_COMMAND = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\b|run-script\b|exec\b|test\b|t\b|dlx\b|x\b)|(?:npx|pnpx|bunx)\s|(?:tsc|vite|vitest|jest|mocha|ava|webpack|rollup|esbuild|next|astro|nuxt|svelte-kit|eslint|prettier|tsx|ts-node|playwright|wrangler)(?:\s|$))/;

export function needsPackages(command: string): boolean {
  return command.split(/&&|\|\||;/).some((part) => PACKAGE_COMMAND.test(part.trim()));
}

export function installPreflight(policy: Pick<RepositoryPolicy, 'install' | 'installSource' | 'dependencies' | 'untested' | 'testCommand'>): string | null {
  if (policy.install || policy.installSource || policy.untested || !policy.dependencies || !needsPackages(policy.testCommand)) return null;
  return `The test command \`${policy.testCommand}\` needs installed packages, but dependency install is off: package.json lists dependencies and neither gitflare.json at the base revision nor the repository check settings set "install". Checks have no registry access, so installing inside the test command fails. An Owner can turn on dependency install in Settings → Branches → Checks or with gitflare_set_check_settings (install), then run checks again.`;
}

export function isProtectedPath(path: string, editable: string[] = DEFAULT_EDITABLE): boolean {
  if (LOCKFILES.test(path)) return false;
  const allowed = editable.some((entry) => entry.endsWith('/') ? path.startsWith(entry) : path === entry);
  return !allowed || ALWAYS_PROTECTED.test(path) || TEST_PATHS.test(path);
}

// Only these stay off-limits when a repository has nothing yet to protect; a starter base has no gitflare.json, so a root one may be added once
const STARTER_PROTECTED = /(^|\/)\.npmrc$|.\/gitflare\.json$|^\.(git|github)(\/|$)/;
const MANIFESTS = /(^|\/)package\.json$/;
const NPM_PLACEHOLDER_TEST = /no test specified/;

export function isStarterRepository(baseFiles: string[]): boolean {
  return !baseFiles.some((path) => path === POLICY_FILE || MANIFESTS.test(path) || TEST_PATHS.test(path));
}

export function protectionReason(path: string, policy: Pick<RepositoryPolicy, 'editable' | 'starter'>): string {
  if (/^\.(git|github)(\/|$)/.test(path)) return '.git and .github/ are always protected';
  if (/(^|\/)gitflare\.json$/.test(path)) return policy.starter ? `only a valid root ${POLICY_FILE} without deploy may be added` : `${POLICY_FILE} is protected; edit it outside Gitflare`;
  if (/(^|\/)(\.npmrc|\.yarnrc|\.yarnrc\.yml|pnpm-workspace\.yaml|\.pnpmfile\.c?js|\.pnp\.c?js|\.pnp\.loader\.mjs)$|(^|\/)\.yarn\//.test(path)) return 'package manager configuration is protected';
  if (MANIFESTS.test(path)) return policy.starter ? 'package.json is reviewed separately' : 'a new package.json is allowed only in a starter repository; an existing one may change only its dependency sections';
  if (TEST_PATHS.test(path)) return 'existing tests are protected; add a new test file instead';
  return `outside the editable paths ${policy.editable.join(', ')}; set "editable" in ${POLICY_FILE} to allow it`;
}

export function addsStarterPolicyFile(changes: PathChange[], policy: Pick<RepositoryPolicy, 'starter'>): boolean {
  return policy.starter && changes.some(({ path, status }) => status === 'A' && path === POLICY_FILE);
}

export function starterPolicyFileProblem(raw: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return `${POLICY_FILE} is not valid JSON`; }
  try {
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'deploy' in parsed) return `${POLICY_FILE} created by an agent may not set "deploy"; an Owner configures deployments`;
    parseRepositoryPolicy(raw, 'node --test --test-reporter=tap');
    return null;
  } catch (error) { return error instanceof Error ? error.message : `${POLICY_FILE} is invalid`; }
}

export function protectedChanges(changes: PathChange[], policy: Pick<RepositoryPolicy, 'editable' | 'starter'>): string[] {
  return changes.filter(({ path, status }) => status !== 'A' ? isProtectedPath(path, policy.editable) : policy.starter ? STARTER_PROTECTED.test(path) : ALWAYS_PROTECTED.test(path)).map(({ path }) => path);
}

export interface ManifestPaths { blocked: string[]; manifests: { path: string; added: boolean }[] }

export function dependencyManifestPaths(changes: PathChange[], policy: Pick<RepositoryPolicy, 'editable' | 'starter'>): ManifestPaths {
  const reviewable = ({ path, status }: PathChange) => MANIFESTS.test(path) && !TEST_PATHS.test(path) && !/^\.(git|github)(\/|$)|(^|\/)\.yarn\//.test(path) && (status === 'M' || status === 'A' && policy.starter);
  const manifests = changes.filter(reviewable);
  const reviewed = new Set(manifests.map(({ path }) => path));
  return { blocked: protectedChanges(changes, policy).filter((path) => !reviewed.has(path)), manifests: manifests.map(({ path, status }) => ({ path, added: status === 'A' })) };
}

export function parseNameStatus(output: string): PathChange[] {
  return output.split('\n').filter(Boolean).map((line) => {
    const [status, ...rest] = line.split('\t');
    return { status: status.charAt(0), path: rest.join('\t') };
  });
}

function packageTestCheck(files: string[], packageJson: string, lockHead?: string | null): StarterCheck | null {
  const script = testScript(packageJson);
  if (!script || NPM_PLACEHOLDER_TEST.test(script)) return null;
  const plan = detectPackageManager({ files, packageJson, lockHead });
  return { testCommand: `${runnerFor(plan)} test`, evidence: 'exit-code', install: hasInstallableDependencies(files, packageJson) ? plan : null };
}

export function starterCheck(files: string[], packageJson: string | null, lockHead?: string | null): StarterCheck | null {
  if (packageJson !== null) {
    try { JSON.parse(packageJson); } catch { return null; }
    const scripted = packageTestCheck(files, packageJson, lockHead);
    if (scripted) return scripted;
  }
  if (files.some((path) => /\.test\.(mjs|cjs|js)$/.test(path) && !path.includes('node_modules/'))) return { testCommand: 'node --test --test-reporter=tap', evidence: 'tap', install: null };
  return null;
}
