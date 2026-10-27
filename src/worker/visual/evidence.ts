import type { Check, VisualCapture, VisualConfig, VisualEvidence, VisualLighthouseThresholds } from '../../shared/types';
import { VISUAL_CHECK_NAMES } from '../../shared/checks';
import type { ArtifactInfo } from '../artifacts';
import { outputLimit } from '../check-evidence';
import type { AuthorityGuard, ExecutionEnv, SandboxRunner } from '../execution/environment';
import { installDependencies, workingTreeInstall } from '../execution/dependencies';
import { checked, cloneOnFreshRunner } from '../execution/sandbox-git';
import { DEPENDENCY_FILES } from '../package-manager';
import type { RepositoryPolicy } from '../repository-policy';
import { captureRequestFor, runCapture, startVisualPreview, stopVisualPreview, toEvidence, VISUAL_DIR, type AxeViolation, type CaptureImage, type CaptureOutput } from './capture';
import { boundedCaptures, touchesUi } from './config';

export const VISUAL_PREVIEW_MS = 180_000;
export const VISUAL_CAPTURE_MS = 240_000;
export const LIGHTHOUSE_MS = 180_000;

export interface EvidenceInput { key: string; fork: ArtifactInfo; baseSha: string; candidateSha: string; policy: RepositoryPolicy; config: VisualConfig; changedFiles: string[]; epoch: number; runId?: string; assertAuthority: AuthorityGuard; isActive: () => Promise<boolean>; store: (image: CaptureImage) => Promise<void>; onStep?: (message: string) => Promise<void> }
export interface LighthouseScores { performance?: number; accessibility?: number; bestPractices?: number; seo?: number }
export type LighthouseResult = { scores: LighthouseScores; url: string } | { missing: true } | { error: string };

export function evidenceId(epoch: number, runId: string | undefined): string {
  return `v${epoch}-${(runId ?? 'integration').replace(/[^A-Za-z0-9-]/g, '-')}`;
}

function sameCapture(a: Pick<VisualCapture, 'route' | 'frame' | 'viewport' | 'theme'>, b: Pick<VisualCapture, 'route' | 'frame' | 'viewport' | 'theme'>): boolean {
  return a.route === b.route && a.frame === b.frame && a.viewport === b.viewport && a.theme === b.theme;
}

export function pairCaptures(evidence: Pick<VisualEvidence, 'captures'>): { base?: VisualCapture; candidate: VisualCapture }[] {
  const bases = evidence.captures.filter((capture) => capture.side === 'base');
  return evidence.captures.filter((capture) => capture.side === 'candidate').map((candidate) => ({ candidate, base: bases.find((base) => sameCapture(base, candidate)) }));
}

const where = (capture: VisualCapture) => `${capture.label}${capture.frame ? ` after ${capture.frame}` : ''} (${capture.viewport}, ${capture.theme})`;

export function visualChecks(evidence: VisualEvidence, config: VisualConfig, axe: Map<string, AxeViolation[]>, lighthouse: LighthouseResult | null): Check[] {
  const base = { candidateSha: evidence.candidateSha, advisory: true as const, ...(evidence.runId ? { runId: evidence.runId } : {}) };
  const pairs = pairCaptures(evidence);
  const ids = (captures: VisualCapture[]) => ({ captureIds: captures.map((capture) => capture.id) });
  const checks: Check[] = [];
  const unavailable = evidence.mode !== 'browser' ? `No browser ran in this runner (${evidence.warnings[0] ?? 'Chromium unavailable'}), so this check could not run.` : null;
  const skipped = (id: string, name: string): Check => ({ ...base, id, name, status: 'skipped', output: unavailable ?? 'No candidate captures.' });
  if (config.checks.consoleErrors) {
    const id = `${evidence.id}-console`;
    if (unavailable || !pairs.length) checks.push(skipped(id, VISUAL_CHECK_NAMES.consoleErrors));
    else {
      const fresh = pairs.flatMap(({ base, candidate }) => candidate.consoleErrors.filter((line) => !base?.consoleErrors.includes(line)).map((line) => `${where(candidate)}: ${line}`));
      const inherited = pairs.flatMap(({ base, candidate }) => candidate.consoleErrors.filter((line) => base?.consoleErrors.includes(line)));
      checks.push({ ...base, id, name: VISUAL_CHECK_NAMES.consoleErrors, status: fresh.length ? 'failed' : 'passed', ...ids(pairs.filter(({ candidate }) => candidate.consoleErrors.length).map(({ candidate }) => candidate)), output: (fresh.length ? `${fresh.length} console error${fresh.length === 1 ? '' : 's'} introduced by the candidate:\n${fresh.join('\n')}` : `No console errors introduced by the candidate across ${pairs.length} capture${pairs.length === 1 ? '' : 's'}.`) + (inherited.length ? `\n${inherited.length} error${inherited.length === 1 ? '' : 's'} already present at the base were ignored.` : '') });
    }
  }
  if (config.checks.overflow) {
    const id = `${evidence.id}-overflow`;
    const mobile = pairs.filter(({ candidate }) => candidate.viewport === 'mobile');
    if (unavailable || !mobile.length) checks.push(skipped(id, VISUAL_CHECK_NAMES.overflow));
    else {
      const fresh = mobile.filter(({ base, candidate }) => candidate.overflow > 0 && !(base && base.overflow > 0));
      const inherited = mobile.filter(({ base, candidate }) => candidate.overflow > 0 && base && base.overflow > 0);
      checks.push({ ...base, id, name: VISUAL_CHECK_NAMES.overflow, status: fresh.length ? 'failed' : 'passed', ...ids(mobile.filter(({ candidate }) => candidate.overflow > 0).map(({ candidate }) => candidate)), output: (fresh.length ? `The candidate is wider than 390px on ${fresh.map(({ candidate }) => `${where(candidate)}: ${candidate.overflow}px`).join('; ')}.` : `No horizontal overflow at 390px across ${mobile.length} capture${mobile.length === 1 ? '' : 's'}.`) + (inherited.length ? `\n${inherited.length} capture${inherited.length === 1 ? '' : 's'} already overflowed at the base and were ignored.` : '') });
    }
  }
  if (typeof config.checks.regression === 'number') {
    const id = `${evidence.id}-regression`;
    const compared = pairs.filter(({ candidate }) => candidate.diff);
    if (unavailable || !compared.length) checks.push(skipped(id, VISUAL_CHECK_NAMES.regression));
    else {
      const over = compared.filter(({ candidate }) => candidate.diff!.changedRatio > (config.checks.regression as number));
      const percent = (ratio: number) => `${(ratio * 100).toFixed(2)}%`;
      checks.push({ ...base, id, name: VISUAL_CHECK_NAMES.regression, status: over.length ? 'failed' : 'passed', ...ids(over.map(({ candidate }) => candidate)), output: over.length ? `${over.length} capture${over.length === 1 ? '' : 's'} changed more than ${percent(config.checks.regression)} of pixels against the base:\n${over.map(({ candidate }) => `${where(candidate)}: ${percent(candidate.diff!.changedRatio)} in ${candidate.diff!.regions.length} region${candidate.diff!.regions.length === 1 ? '' : 's'}`).join('\n')}` : `Every capture changed at most ${percent(Math.max(0, ...compared.map(({ candidate }) => candidate.diff!.changedRatio)))} of pixels, under the ${percent(config.checks.regression)} threshold.` });
    }
  }
  if (config.checks.axe) {
    const id = `${evidence.id}-axe`;
    if (unavailable || !pairs.length) checks.push(skipped(id, VISUAL_CHECK_NAMES.axe));
    else if (!axe.size) checks.push({ ...base, id, name: VISUAL_CHECK_NAMES.axe, status: 'skipped', output: 'axe-core did not run: add axe-core as a devDependency so node_modules/axe-core/axe.min.js exists in the candidate.' });
    else {
      const serious = config.checks.axe === 'serious';
      const counts = (violations: AxeViolation[]) => violations.filter((violation) => !serious || violation.impact === 'serious' || violation.impact === 'critical');
      const failing = pairs.flatMap(({ base, candidate }) => counts(axe.get(candidate.id) ?? []).filter((violation) => !(base && (axe.get(base.id) ?? []).some((known) => known.id === violation.id))).map((violation) => ({ capture: candidate, violation })));
      checks.push({ ...base, id, name: VISUAL_CHECK_NAMES.axe, status: failing.length ? 'failed' : 'passed', ...ids([...new Set(failing.map(({ capture }) => capture))]), output: failing.length ? `${failing.length} ${serious ? 'serious or critical ' : ''}axe violation${failing.length === 1 ? '' : 's'} introduced by the candidate:\n${failing.map(({ capture, violation }) => `${where(capture)}: ${violation.id} (${violation.impact}) ${violation.help}; ${violation.nodes} node${violation.nodes === 1 ? '' : 's'}: ${violation.targets.join(', ')}`).join('\n')}` : `No ${serious ? 'serious or critical ' : ''}axe violations introduced by the candidate.` });
    }
  }
  if (config.checks.lighthouse) {
    const id = `${evidence.id}-lighthouse`;
    const thresholds = config.checks.lighthouse;
    if (unavailable) checks.push(skipped(id, VISUAL_CHECK_NAMES.lighthouse));
    else if (!lighthouse || 'missing' in lighthouse) checks.push({ ...base, id, name: VISUAL_CHECK_NAMES.lighthouse, status: 'skipped', output: 'Lighthouse did not run: add lighthouse as a devDependency so node_modules/lighthouse exists in the candidate.' });
    else if ('error' in lighthouse) checks.push({ ...base, id, name: VISUAL_CHECK_NAMES.lighthouse, status: 'failed', output: `Lighthouse failed: ${lighthouse.error}`.slice(0, outputLimit) });
    else {
      const labels: Record<keyof VisualLighthouseThresholds, string> = { performance: 'Performance', accessibility: 'Accessibility', bestPractices: 'Best practices', seo: 'SEO' };
      const lines = (Object.keys(labels) as (keyof VisualLighthouseThresholds)[]).filter((key) => lighthouse.scores[key] !== undefined).map((key) => `${labels[key]}: ${lighthouse.scores[key]}${thresholds[key] !== undefined ? ` (minimum ${thresholds[key]})` : ''}`);
      const below = (Object.keys(labels) as (keyof VisualLighthouseThresholds)[]).filter((key) => thresholds[key] !== undefined && (lighthouse.scores[key] === undefined || lighthouse.scores[key]! < thresholds[key]!));
      checks.push({ ...base, id, name: VISUAL_CHECK_NAMES.lighthouse, status: below.length ? 'failed' : 'passed', output: `${lighthouse.url}\n${lines.join('\n')}${below.length ? `\nBelow the minimum: ${below.map((key) => labels[key]).join(', ')}.` : ''}` });
    }
  }
  return checks;
}

export function lighthouseCommand(port: number, route: string): string {
  const categories = 'performance,accessibility,best-practices,seo';
  return `test -f node_modules/lighthouse/cli/index.js || { echo GITFLARE_LIGHTHOUSE_MISSING; exit 0; }; export CHROME_PATH="\${GITFLARE_CHROMIUM:-$(command -v chromium || command -v chromium-browser || true)}"; node node_modules/lighthouse/cli/index.js "http://localhost:${port}${route}" --output=json --output-path=stdout --quiet --preset=desktop --only-categories=${categories} --chrome-flags="--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage"`;
}

export function parseLighthouse(stdout: string, url: string): LighthouseResult {
  if (stdout.includes('GITFLARE_LIGHTHOUSE_MISSING')) return { missing: true };
  const start = stdout.indexOf('{');
  if (start < 0) return { error: 'no report was produced' };
  try {
    const report = JSON.parse(stdout.slice(start)) as { categories?: Record<string, { score: number | null }>; runtimeError?: { message?: string } };
    if (report.runtimeError?.message) return { error: report.runtimeError.message.slice(0, 500) };
    const score = (key: string) => { const value = report.categories?.[key]?.score; return typeof value === 'number' ? Math.round(value * 100) : undefined; };
    const scores: LighthouseScores = { ...(score('performance') !== undefined ? { performance: score('performance') } : {}), ...(score('accessibility') !== undefined ? { accessibility: score('accessibility') } : {}), ...(score('best-practices') !== undefined ? { bestPractices: score('best-practices') } : {}), ...(score('seo') !== undefined ? { seo: score('seo') } : {}) };
    return Object.keys(scores).length ? { scores, url } : { error: 'the report had no category scores' };
  } catch { return { error: 'the report was not valid JSON' }; }
}

export async function runLighthouse(sandbox: SandboxRunner, port: number, route: string): Promise<LighthouseResult> {
  const url = `http://localhost:${port}${route}`;
  try {
    const result = sandbox.collect ? await sandbox.collect(lighthouseCommand(port, route), LIGHTHOUSE_MS, 16 * 1024 * 1024) : await sandbox.command(['/bin/bash', '-lc', lighthouseCommand(port, route)], '/workspace/repo', LIGHTHOUSE_MS);
    if (result.exitCode !== 0) return { error: `exit ${result.exitCode}: ${(result.stderr || result.stdout).replace(/\s+/g, ' ').trim().slice(-400)}` };
    return parseLighthouse(result.stdout, url);
  } catch (error) { return { error: error instanceof Error ? error.message.slice(0, 500) : 'Lighthouse could not run' }; }
}

function axeByCapture(output: CaptureOutput, prefix: string): Map<string, AxeViolation[]> {
  return new Map(output.captures.filter((capture) => capture.axe).map((capture) => [`${prefix}.${capture.id}`, capture.axe!]));
}

export async function captureCandidateEvidence(env: Required<Pick<ExecutionEnv, 'SANDBOX'>>, input: EvidenceInput): Promise<{ evidence: VisualEvidence; checks: Check[] } | null> {
  if (!touchesUi(input.changedFiles)) return null;
  const config = boundedCaptures(input.config);
  const id = evidenceId(input.epoch, input.runId);
  const step = input.onStep ?? (async () => {});
  let sandbox = env.SANDBOX.getByName(`${input.key}-visual`);
  try {
    await input.assertAuthority();
    await step('Visual evidence: preparing a runner for the base revision');
    await sandbox.prepare([{ ...input.fork, write: false }]);
    sandbox = await cloneOnFreshRunner(sandbox, async () => {
      const fresh = env.SANDBOX.getByName(`${input.key}-visual-fresh`);
      await input.assertAuthority();
      await fresh.prepare([{ ...input.fork, write: false }]);
      return fresh;
    }, input.fork, input.baseSha);
    const files = (await checked(sandbox, ['git', 'ls-files'])).split('\n').filter(Boolean);
    const { plan, packageJson, lockHead } = await workingTreeInstall(sandbox, files);
    const install = input.policy.install ?? plan;
    if (install) {
      await step('Visual evidence: installing dependencies at the base revision');
      await installDependencies(sandbox, install, input.assertAuthority, input.isActive);
    }
    if (!await input.isActive()) throw new Error('Mission cancelled');
    await step('Visual evidence: capturing the base revision');
    const basePreview = await startVisualPreview(sandbox, input.policy, files, packageJson, lockHead, VISUAL_PREVIEW_MS);
    const baseOutput = await runCapture(sandbox, captureRequestFor(config, `${VISUAL_DIR}/base`, { port: basePreview.port }), VISUAL_CAPTURE_MS);
    await stopVisualPreview(sandbox);
    await checked(sandbox, ['git', 'checkout', '--detach', input.candidateSha]);
    const candidateFiles = (await checked(sandbox, ['git', 'ls-files'])).split('\n').filter(Boolean);
    const candidateTree = await workingTreeInstall(sandbox, candidateFiles);
    if (input.changedFiles.some((path) => DEPENDENCY_FILES.test(path)) && (input.policy.install ?? candidateTree.plan)) {
      await step('Visual evidence: installing the candidate dependencies');
      await installDependencies(sandbox, input.policy.install ?? candidateTree.plan!, input.assertAuthority, input.isActive);
    }
    if (!await input.isActive()) throw new Error('Mission cancelled');
    await step('Visual evidence: capturing the candidate');
    const candidatePreview = await startVisualPreview(sandbox, input.policy, candidateFiles, candidateTree.packageJson, candidateTree.lockHead, VISUAL_PREVIEW_MS);
    const candidateOutput = await runCapture(sandbox, captureRequestFor(config, `${VISUAL_DIR}/candidate`, { port: candidatePreview.port, compareDir: `${VISUAL_DIR}/base` }), VISUAL_CAPTURE_MS);
    const lighthouse = config.checks.lighthouse && candidateOutput.mode === 'browser' ? await runLighthouse(sandbox, candidatePreview.port, config.routes[0]?.path ?? '/') : null;
    await stopVisualPreview(sandbox).catch(() => {});
    const context = { id, candidateSha: input.candidateSha, baseSha: input.baseSha, epoch: input.epoch, runId: input.runId };
    const base = toEvidence(baseOutput, { ...context, side: 'base' });
    const candidate = toEvidence(candidateOutput, { ...context, side: 'candidate' });
    for (const image of [...base.images, ...candidate.images]) await input.store(image);
    const evidence: VisualEvidence = { ...candidate.evidence, mode: candidateOutput.mode, captures: [...base.evidence.captures, ...candidate.evidence.captures], warnings: [...new Set([...base.evidence.warnings, ...candidate.evidence.warnings])] };
    const axe = new Map([...axeByCapture(baseOutput, `${id}.base`), ...axeByCapture(candidateOutput, `${id}.candidate`)]);
    return { evidence, checks: visualChecks(evidence, config, axe, lighthouse) };
  } finally { await sandbox.destroy(); }
}
