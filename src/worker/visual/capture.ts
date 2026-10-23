import captureScript from '../../../runner/visual/visual-capture.mjs?raw';
import type { VisualCapture, VisualConfig, VisualEvidence, VisualRoute, VisualTheme, VisualViewport } from '../../shared/types';
import type { SandboxRunner } from '../execution/environment';
import { previewPlan, PREVIEW_PORT, type PreviewPlan } from '../preview-plan';
import type { RepositoryPolicy } from '../repository-policy';
import { MAX_VISUAL_IMAGES } from './config';

export const VISUAL_DIR = '/tmp/gitflare-visual';
export const VISUAL_SCRIPT = `${VISUAL_DIR}/visual-capture.mjs`;
export const VISUAL_OUTPUT_CAP = 16 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 1_048_576;
const HEREDOC = 'GITFLARE_VISUAL_EOF';

export interface CaptureRequest { routes: VisualRoute[]; viewports: VisualViewport[]; themes: VisualTheme[]; outDir: string; compareDir?: string; axe?: string | null; emitImages?: boolean; port?: number }
export interface RawDiff { against: string | null; changedRatio: number; regions: { x: number; y: number; width: number; height: number }[]; image: string | null; missingBase?: boolean; sizeChanged?: { from: number[]; to: number[] } }
export interface AxeViolation { id: string; impact: string; help: string; nodes: number; targets: string[] }
export interface RawCapture { id: string; route: string; label: string; frame?: string; viewport: VisualViewport; theme: VisualTheme; width: number; height: number; format: 'png' | 'jpeg'; bytes: number; image: string | null; outline: string; consoleErrors: string[]; overflow: number; diff?: RawDiff; axe?: AxeViolation[] }
export interface CaptureOutput { mode: 'browser' | 'outline'; browser: string | null; captures: RawCapture[]; warnings: string[] }
export interface CaptureImage { id: string; format: 'png' | 'jpeg'; data: string }

export class VisualCaptureError extends Error {}

export function captureScriptInstall(): string {
  return `mkdir -p ${VISUAL_DIR} && cat > ${VISUAL_SCRIPT} <<'${HEREDOC}'\n${captureScript}\n${HEREDOC}\n`;
}

export function captureCommand(request: CaptureRequest): string {
  const config = { baseUrl: `http://localhost:${request.port ?? PREVIEW_PORT}`, routes: request.routes, viewports: request.viewports, themes: request.themes, outDir: request.outDir, ...(request.compareDir ? { compareDir: request.compareDir } : {}), ...(request.axe ? { axe: request.axe } : {}), emitImages: request.emitImages !== false, maxImageBytes: MAX_IMAGE_BYTES };
  const file = `${request.outDir}.json`;
  return `${captureScriptInstall()}mkdir -p ${request.outDir} && cat > ${file} <<'${HEREDOC}'\n${JSON.stringify(config)}\n${HEREDOC}\nexec node ${VISUAL_SCRIPT} ${file}`;
}

export function parseCaptureOutput(stdout: string): CaptureOutput {
  const start = stdout.indexOf('{');
  if (start < 0) throw new VisualCaptureError('The capture script produced no result');
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.slice(start)); } catch { throw new VisualCaptureError('The capture script produced an unreadable result'); }
  const raw = parsed as Partial<CaptureOutput>;
  if (!raw || (raw.mode !== 'browser' && raw.mode !== 'outline') || !Array.isArray(raw.captures)) throw new VisualCaptureError('The capture script produced an unexpected result');
  return { mode: raw.mode, browser: typeof raw.browser === 'string' ? raw.browser : null, captures: raw.captures.filter((item): item is RawCapture => !!item && typeof item === 'object' && typeof item.id === 'string').slice(0, MAX_VISUAL_IMAGES), warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((item): item is string => typeof item === 'string').slice(0, 50) : [] };
}

export async function runCapture(sandbox: SandboxRunner, request: CaptureRequest, timeoutMs: number): Promise<CaptureOutput> {
  const run = sandbox.collect ? sandbox.collect(captureCommand(request), timeoutMs, VISUAL_OUTPUT_CAP) : sandbox.command(['/bin/bash', '-lc', captureCommand(request)], '/workspace/repo', timeoutMs);
  const result = await run;
  if (result.exitCode !== 0) throw new VisualCaptureError(`Capture failed (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}): ${(result.stderr || result.stdout).replace(/\s+/g, ' ').trim().slice(-600)}`);
  return parseCaptureOutput(result.stdout);
}

export function previewPort(started: unknown): number {
  return typeof started === 'number' && started > 0 ? started : PREVIEW_PORT;
}

export interface VisualPreview { port: number; plan: PreviewPlan }

export async function startVisualPreview(sandbox: SandboxRunner, policy: Pick<RepositoryPolicy, 'previewCommand' | 'install'> | undefined, files: string[], packageJson: string | null, lockHead: string | null, timeoutMs: number): Promise<VisualPreview> {
  if (!sandbox.startPreview) throw new VisualCaptureError('This runner cannot start a preview');
  const plan = previewPlan(files, packageJson, { command: policy?.previewCommand, install: policy?.install ?? null }, lockHead);
  const started = await sandbox.startPreview(plan.argv, Math.min(plan.readinessMs, Math.max(10_000, timeoutMs)));
  return { port: previewPort(started), plan };
}

export async function stopVisualPreview(sandbox: SandboxRunner): Promise<void> {
  if (sandbox.stopPreview) await sandbox.stopPreview();
}

export interface EvidenceContext { id: string; side: 'base' | 'candidate'; candidateSha: string; baseSha: string; epoch: number; runId?: string }

export function captureIdFor(context: Pick<EvidenceContext, 'id' | 'side'>, raw: Pick<RawCapture, 'id'>): string {
  return `${context.id}.${context.side}.${raw.id}`;
}

export function toEvidence(output: CaptureOutput, context: EvidenceContext, baseIds?: Map<string, string>): { evidence: VisualEvidence; images: CaptureImage[] } {
  const images: CaptureImage[] = [];
  const captures: VisualCapture[] = output.captures.map((raw) => {
    const id = captureIdFor(context, raw);
    if (raw.image) images.push({ id, format: raw.format, data: raw.image });
    const capture: VisualCapture = { id, side: context.side, route: raw.route, label: raw.label, ...(raw.frame ? { frame: raw.frame } : {}), viewport: raw.viewport, theme: raw.theme, width: raw.width, height: raw.height, format: raw.format, bytes: raw.bytes, outline: raw.outline.slice(0, 4000), consoleErrors: raw.consoleErrors.slice(0, 20).map((line) => line.slice(0, 300)), overflow: raw.overflow };
    if (raw.diff) {
      const against = raw.diff.against ? baseIds?.get(raw.diff.against) ?? `${context.id}.base.${raw.diff.against}` : '';
      const diffId = raw.diff.image ? `${id}.diff` : undefined;
      if (raw.diff.image && diffId) images.push({ id: diffId, format: 'png', data: raw.diff.image });
      capture.diff = { against, changedRatio: raw.diff.changedRatio, regions: raw.diff.regions.slice(0, 20), ...(diffId ? { imageId: diffId } : {}) };
    }
    return capture;
  });
  return { evidence: { id: context.id, ...(context.runId ? { runId: context.runId } : {}), candidateSha: context.candidateSha, baseSha: context.baseSha, epoch: context.epoch, mode: output.mode, browser: output.browser, captures, warnings: output.warnings.map((line) => line.slice(0, 500)), capturedAt: new Date().toISOString() }, images };
}

export function captureRequestFor(config: VisualConfig, outDir: string, options: Partial<CaptureRequest> = {}): CaptureRequest {
  return { routes: config.routes, viewports: config.viewports, themes: config.themes, outDir, ...(config.checks.axe ? { axe: '/workspace/repo/node_modules/axe-core/axe.min.js' } : {}), ...options };
}
