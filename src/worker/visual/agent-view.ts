import type { VisualConfig, VisualRoute, VisualTheme, VisualViewport } from '../../shared/types';
import type { SandboxRunner } from '../execution/environment';
import { workingFiles, workingTreeInstall } from '../execution/dependencies';
import type { RepositoryPolicy } from '../repository-policy';
import { captureRequestFor, runCapture, startVisualPreview, stopVisualPreview, VISUAL_DIR, VisualCaptureError, type CaptureOutput, type RawCapture, type VisualPreview } from './capture';
import { boundedCaptures, VISUAL_THEMES, VISUAL_VIEWPORTS, visualRoutes } from './config';

export const MAX_VIEW_IMAGES = 8;
export const VIEW_TOOL = 'view_ui';
const PREVIEW_START_MS = 180_000;
const CAPTURE_MS = 150_000;
const MIN_VIEW_MS = 45_000;

export interface ViewRequest { routes?: string[] | null; viewports?: VisualViewport[] | null; themes?: VisualTheme[] | null; restart?: boolean | null }
export interface ToolImage { id: string; mimeType: 'image/png' | 'image/jpeg'; data: string; label: string }
export interface ToolOutput { text: string; images: ToolImage[] }

export function viewRequest(raw: string): ViewRequest | string {
  let fields: Record<string, unknown>;
  try { fields = JSON.parse(raw) as Record<string, unknown>; } catch { return 'Invalid view_ui input: provide a JSON object.'; }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return 'Invalid view_ui input: provide a JSON object.';
  const unknown = Object.keys(fields).find((key) => !['routes', 'viewports', 'themes', 'restart'].includes(key));
  if (unknown) return `Invalid view_ui input: "${unknown}" is not a parameter.`;
  const request: ViewRequest = {};
  if (fields.routes != null) {
    if (!Array.isArray(fields.routes) || fields.routes.length > 6 || fields.routes.some((route) => typeof route !== 'string' || !route.startsWith('/') || route.length > 300)) return 'Invalid view_ui input: routes must be up to 6 absolute paths such as "/" or "/play".';
    request.routes = fields.routes as string[];
  }
  if (fields.viewports != null) {
    if (!Array.isArray(fields.viewports) || !fields.viewports.length || fields.viewports.some((item) => !VISUAL_VIEWPORTS.includes(item as VisualViewport))) return 'Invalid view_ui input: viewports must list "desktop" and/or "mobile".';
    request.viewports = [...new Set(fields.viewports as VisualViewport[])];
  }
  if (fields.themes != null) {
    if (!Array.isArray(fields.themes) || !fields.themes.length || fields.themes.some((item) => !VISUAL_THEMES.includes(item as VisualTheme))) return 'Invalid view_ui input: themes must list "light" and/or "dark".';
    request.themes = [...new Set(fields.themes as VisualTheme[])];
  }
  if (fields.restart != null) {
    if (typeof fields.restart !== 'boolean') return 'Invalid view_ui input: restart must be true or false.';
    request.restart = fields.restart;
  }
  return request;
}

export function requestedConfig(config: VisualConfig, request: ViewRequest): VisualConfig {
  const routes: VisualRoute[] = request.routes?.length ? request.routes.map((path) => config.routes.find((route) => route.path === path) ?? { path }) : config.routes;
  try { visualRoutes(routes, 'routes'); } catch (error) { throw new VisualCaptureError(error instanceof Error ? error.message : 'invalid routes'); }
  return boundedCaptures({ ...config, routes, viewports: request.viewports?.length ? request.viewports : config.viewports, themes: request.themes?.length ? request.themes : config.themes }, MAX_VIEW_IMAGES);
}

export function captureHeading(capture: Pick<RawCapture, 'label' | 'route' | 'frame' | 'viewport' | 'theme' | 'width' | 'height'>): string {
  return `${capture.label}${capture.label !== capture.route ? ` (${capture.route})` : ''}${capture.frame ? ` after ${capture.frame}` : ''} · ${capture.viewport} ${capture.width}×${capture.height} · ${capture.theme}`;
}

export function viewOutput(output: CaptureOutput, preview: { description: string; port: number } | null, maxImages = MAX_VIEW_IMAGES): ToolOutput {
  const images: ToolImage[] = [];
  const lines: string[] = [];
  if (preview) lines.push(`Preview: ${preview.description} on port ${preview.port}.`);
  lines.push(output.mode === 'browser' ? `Captured with ${output.browser ?? 'Chromium'}. ${Math.min(maxImages, output.captures.filter((capture) => capture.image).length)} screenshot(s) follow this message as images; the text below describes each one.` : 'No browser is available in this runner, so there are no screenshots: the outline of the served HTML follows. Reason the layout out from the markup and styles.');
  for (const warning of output.warnings) lines.push(`Warning: ${warning}`);
  output.captures.forEach((capture, index) => {
    const attached = capture.image && images.length < maxImages;
    if (attached) images.push({ id: capture.id, mimeType: capture.format === 'jpeg' ? 'image/jpeg' : 'image/png', data: capture.image!, label: captureHeading(capture) });
    lines.push('', `## ${index + 1}. ${captureHeading(capture)}${attached ? ` [image ${images.length}]` : capture.image ? ' [image omitted: limit reached]' : ''}`);
    lines.push(capture.outline);
    if (capture.consoleErrors.length) lines.push(`Console errors (${capture.consoleErrors.length}): ${capture.consoleErrors.slice(0, 5).join(' | ')}`);
    if (capture.overflow > 0) lines.push(`Layout overflow: the page is ${capture.overflow}px wider than the ${capture.width}px viewport.`);
    if (capture.axe?.length) lines.push(`axe violations: ${capture.axe.slice(0, 8).map((violation) => `${violation.id} (${violation.impact}, ${violation.nodes} node${violation.nodes === 1 ? '' : 's'})`).join('; ')}`);
  });
  return { text: lines.join('\n').slice(0, 24_000), images };
}

export class AgentViewer {
  #preview: VisualPreview | null = null;
  #calls = 0;
  constructor(private readonly sandbox: SandboxRunner, private readonly policy: Pick<RepositoryPolicy, 'previewCommand' | 'install'>, readonly config: VisualConfig) {}

  get previewed(): boolean { return !!this.#preview; }

  async ensurePreview(restart: boolean, remainingMs: number): Promise<VisualPreview> {
    if (this.#preview && !restart) return this.#preview;
    if (this.#preview) { await stopVisualPreview(this.sandbox); this.#preview = null; }
    const files = await workingFiles(this.sandbox);
    const { packageJson, lockHead } = await workingTreeInstall(this.sandbox, files);
    this.#preview = await startVisualPreview(this.sandbox, this.policy, files, packageJson, lockHead, Math.min(PREVIEW_START_MS, remainingMs));
    return this.#preview;
  }

  async capture(config: VisualConfig, remainingMs: number, options: { restart?: boolean; compareDir?: string; emitImages?: boolean } = {}): Promise<{ output: CaptureOutput; preview: VisualPreview; outDir: string }> {
    const preview = await this.ensurePreview(!!options.restart, remainingMs);
    const outDir = `${VISUAL_DIR}/view-${++this.#calls}`;
    const output = await runCapture(this.sandbox, captureRequestFor(config, outDir, { port: preview.port, compareDir: options.compareDir, emitImages: options.emitImages }), Math.min(CAPTURE_MS, Math.max(10_000, remainingMs - 5_000)));
    return { output, preview, outDir };
  }

  async view(raw: string, remainingMs: number): Promise<ToolOutput> {
    const request = viewRequest(raw);
    if (typeof request === 'string') return { text: request, images: [] };
    if (remainingMs < MIN_VIEW_MS) return { text: 'Not enough agent time left to start the preview and capture screenshots. Finish now and say that the UI was not viewed.', images: [] };
    try {
      const config = requestedConfig(this.config, request);
      const { output, preview } = await this.capture(config, remainingMs, { restart: request.restart ?? false });
      return viewOutput(output, { description: preview.plan.description, port: preview.port });
    } catch (error) {
      if (this.#preview === null) return { text: `The preview could not start, so nothing was captured: ${error instanceof Error ? error.message : String(error)}\nFix the start command or the server, then call view_ui again (restart: true after you change build output).`, images: [] };
      return { text: `Screenshots could not be captured: ${error instanceof Error ? error.message : String(error)}`, images: [] };
    }
  }

  async close(): Promise<void> {
    if (!this.#preview) return;
    this.#preview = null;
    await stopVisualPreview(this.sandbox).catch(() => {});
  }
}
