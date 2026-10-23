export interface RasterImage { width: number; height: number; pixels: Uint8Array }
export interface DiffRegion { x: number; y: number; width: number; height: number }
export interface DiffResult { changedRatio: number; regions: DiffRegion[]; image: Buffer | null; sizeChanged?: { from: number[]; to: number[] } }
export interface KeyDescriptor { key: string; code: string; windowsVirtualKeyCode: number }
export interface Outline { title: string; landmarks: Record<string, number>; headings: string[]; controls: { buttons: number; links: number; inputs: number; sample: string[] }; images: { total: number; missingAlt: number }; canvas: number; video: number; bodyText: string; scripts?: number; overflow?: number; scrollHeight?: number; viewportMeta?: boolean; colorScheme?: string; background?: string }
export interface CaptureConfig { baseUrl: string; routes: { path: string; label?: string; steps?: Record<string, unknown>[] }[]; viewports?: string[]; themes?: string[]; outDir?: string; compareDir?: string; axe?: string | null; emitImages?: boolean; chromium?: string; settleMs?: number; navigationTimeoutMs?: number; maxImageBytes?: number; captureTimeoutMs?: number }
export interface ScriptCapture { id: string; route: string; label: string; frame?: string; viewport: string; theme: string; width: number; height: number; format: 'png' | 'jpeg'; bytes: number; image: string | null; outline: string; consoleErrors: string[]; overflow: number; diff?: Record<string, unknown>; axe?: unknown[] }
export interface ScriptResult { mode: 'browser' | 'outline'; browser: string | null; captures: ScriptCapture[]; warnings: string[] }
export const VIEWPORTS: Record<string, { width: number; height: number }>;
export function findChromium(env?: Record<string, string | undefined>): string | null;
export function keyDescriptor(name: string): KeyDescriptor;
export function outlineText(outline: Outline, viewport: { width: number; height: number }): string;
export function captureId(route: string, viewport: string, theme: string, frame?: string): string;
export function decodePng(buffer: Buffer): RasterImage;
export function encodePng(image: RasterImage): Buffer;
export function diffImages(base: RasterImage, candidate: RasterImage): DiffResult;
export function htmlOutline(html: string): Outline;
export function outlineOnly(config: CaptureConfig, reason: string): Promise<ScriptResult>;
export function capture(config: CaptureConfig): Promise<ScriptResult>;
