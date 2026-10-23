import type { VisualChecks, VisualConfig, VisualLighthouseThresholds, VisualQuality, VisualRoute, VisualSettings, VisualStep, VisualTheme, VisualViewport } from '../../shared/types';

export const MAX_VISUAL_ROUTES = 6;
export const MAX_VISUAL_STEPS = 12;
export const MAX_VISUAL_ROUNDS = 4;
export const MAX_VISUAL_IMAGES = 32;
export const VISUAL_VIEWPORTS: readonly VisualViewport[] = ['desktop', 'mobile'];
export const VISUAL_THEMES: readonly VisualTheme[] = ['light', 'dark'];
export const VIEWPORT_SIZES: Record<VisualViewport, { width: number; height: number }> = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } };
export const DEFAULT_VISUAL_CHECKS: VisualChecks = { consoleErrors: true, overflow: true, regression: false, axe: false, lighthouse: false };
export const DEFAULT_VISUAL_QUALITY: VisualQuality = { rounds: 0, passScore: 8 };
export const DEFAULT_VISUAL_ROUTES: VisualRoute[] = [{ path: '/', label: 'Home' }];

const UI_EXTENSIONS = /\.(html?|css|scss|sass|less|tsx|jsx|vue|svelte|astro|mdx|svg|png|jpe?g|webp|gif|woff2?)$/i;
const UI_DIRECTORIES = /^(?:src\/(?:ui|components?|pages|views|app|routes|styles?|client|frontend|layouts?)\/|app\/|pages\/|components?\/|public\/|assets\/|static\/|styles?\/|www\/|site\/|client\/|frontend\/)/;
const SCRIPT_EXTENSIONS = /\.(ts|js|mjs|cjs)$/i;
const TEST_FILE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[^.\/]+$/;

export function isUiPath(path: string): boolean {
  if (TEST_FILE.test(path)) return false;
  if (UI_EXTENSIONS.test(path)) return true;
  return SCRIPT_EXTENSIONS.test(path) && UI_DIRECTORIES.test(path);
}

export function touchesUi(changedFiles: string[]): boolean {
  return changedFiles.some(isUiPath);
}

class VisualConfigError extends Error {}

function fail(message: string): never {
  throw new VisualConfigError(message);
}

function routePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 300 || /[\s\u0000-\u001f\u007f]/.test(value) || value.includes('//') || /^\/\/|^\/\\/.test(value)) fail(`${field} must be an absolute path such as "/" or "/play?level=2"`);
  return value;
}

function selector(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) fail(`${field} must be a CSS selector of at most 200 characters`);
  return value.trim();
}

const KEY_NAME = /^(?:[A-Za-z0-9]|Key[A-Z]|Digit[0-9]|Arrow(?:Up|Down|Left|Right)|Enter|Escape|Space|Tab|Backspace|Delete|Shift(?:Left|Right)?|Control(?:Left|Right)?|Alt(?:Left|Right)?|Home|End|PageUp|PageDown|F(?:[1-9]|1[0-2]))$/;

function milliseconds(value: unknown, field: string, max: number): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > max) fail(`${field} must be a whole number of milliseconds up to ${max}`);
  return value as number;
}

function step(value: unknown, field: string): VisualStep {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object with one action`);
  const fields = value as Record<string, unknown>;
  const actions = Object.keys(fields).filter((key) => key !== 'hold');
  const unknown = Object.keys(fields).find((key) => !['click', 'press', 'hold', 'type', 'wait', 'scroll', 'capture'].includes(key));
  if (unknown) fail(`${field}.${unknown} is not a step action`);
  if (actions.length !== 1) fail(`${field} must have exactly one of click, press, type, wait, scroll or capture`);
  const result: VisualStep = {};
  if (fields.click !== undefined) result.click = selector(fields.click, `${field}.click`);
  if (fields.press !== undefined) {
    if (typeof fields.press !== 'string' || !KEY_NAME.test(fields.press)) fail(`${field}.press must be a key such as "ArrowLeft", "KeyX", "Space" or "Enter"`);
    result.press = fields.press;
    if (fields.hold !== undefined) result.hold = milliseconds(fields.hold, `${field}.hold`, 5000);
  } else if (fields.hold !== undefined) fail(`${field}.hold applies only with press`);
  if (fields.type !== undefined) {
    if (typeof fields.type !== 'string' || !fields.type || fields.type.length > 200 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(fields.type)) fail(`${field}.type must be text of at most 200 characters`);
    result.type = fields.type;
  }
  if (fields.wait !== undefined) result.wait = milliseconds(fields.wait, `${field}.wait`, 10_000);
  if (fields.scroll !== undefined) {
    if (!Number.isInteger(fields.scroll) || Math.abs(fields.scroll as number) > 20_000) fail(`${field}.scroll must be a whole number of pixels`);
    result.scroll = fields.scroll as number;
  }
  if (fields.capture !== undefined) {
    if (typeof fields.capture !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/.test(fields.capture)) fail(`${field}.capture must be a short label (letters, numbers, spaces, - or _)`);
    result.capture = fields.capture;
  }
  return result;
}

export function visualRoutes(value: unknown, field = 'visual.routes'): VisualRoute[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_VISUAL_ROUTES) fail(`${field} must list between 1 and ${MAX_VISUAL_ROUTES} routes`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const name = `${field}[${index}]`;
    const raw = typeof entry === 'string' ? { path: entry } : entry;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${name} must be a path or an object with path, label and steps`);
    const fields = raw as Record<string, unknown>;
    const unknown = Object.keys(fields).find((key) => !['path', 'label', 'steps'].includes(key));
    if (unknown) fail(`${name}.${unknown} is not a route field`);
    const route: VisualRoute = { path: routePath(fields.path, `${name}.path`) };
    if (fields.label !== undefined) {
      if (typeof fields.label !== 'string' || !fields.label.trim() || fields.label.length > 60 || /[\u0000-\u001f\u007f]/.test(fields.label)) fail(`${name}.label must be at most 60 characters`);
      route.label = fields.label.trim();
    }
    if (fields.steps !== undefined) {
      if (!Array.isArray(fields.steps) || fields.steps.length > MAX_VISUAL_STEPS) fail(`${name}.steps must list at most ${MAX_VISUAL_STEPS} steps`);
      route.steps = fields.steps.map((item, position) => step(item, `${name}.steps[${position}]`));
      if (!route.steps.length) delete route.steps;
    }
    const key = `${route.path}|${(route.steps ?? []).map((item) => JSON.stringify(item)).join(',')}`;
    if (seen.has(key)) fail(`${name} repeats ${route.path}`);
    seen.add(key);
    return route;
  });
}

function list<T extends string>(value: unknown, allowed: readonly T[], field: string): T[] {
  if (!Array.isArray(value) || !value.length || value.some((item) => !allowed.includes(item as T))) fail(`${field} must list one or more of ${allowed.map((item) => `"${item}"`).join(', ')}`);
  return [...new Set(value as T[])];
}

function threshold(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail(`${field} must be a ratio between 0 and 1`);
  return value;
}

function score(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 100) fail(`${field} must be a whole number between 0 and 100`);
  return value as number;
}

export function visualChecks(value: unknown, field = 'visual.checks'): Partial<VisualChecks> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  const fields = value as Record<string, unknown>;
  const unknown = Object.keys(fields).find((key) => !['consoleErrors', 'overflow', 'regression', 'axe', 'lighthouse'].includes(key));
  if (unknown) fail(`${field}.${unknown} is not a visual check`);
  const result: Partial<VisualChecks> = {};
  for (const key of ['consoleErrors', 'overflow'] as const) if (fields[key] !== undefined) {
    if (typeof fields[key] !== 'boolean') fail(`${field}.${key} must be true or false`);
    result[key] = fields[key] as boolean;
  }
  if (fields.regression !== undefined) result.regression = fields.regression === false ? false : threshold(fields.regression, `${field}.regression`);
  if (fields.axe !== undefined) {
    if (typeof fields.axe !== 'boolean' && fields.axe !== 'serious') fail(`${field}.axe must be true, false or "serious"`);
    result.axe = fields.axe as boolean | 'serious';
  }
  if (fields.lighthouse !== undefined) {
    if (fields.lighthouse === false) result.lighthouse = false;
    else {
      if (!fields.lighthouse || typeof fields.lighthouse !== 'object' || Array.isArray(fields.lighthouse)) fail(`${field}.lighthouse must be false or an object of category thresholds`);
      const categories = fields.lighthouse as Record<string, unknown>;
      const bad = Object.keys(categories).find((key) => !['performance', 'accessibility', 'bestPractices', 'seo'].includes(key));
      if (bad) fail(`${field}.lighthouse.${bad} is not a Lighthouse category`);
      const thresholds: VisualLighthouseThresholds = {};
      for (const key of ['performance', 'accessibility', 'bestPractices', 'seo'] as const) if (categories[key] !== undefined) thresholds[key] = score(categories[key], `${field}.lighthouse.${key}`);
      if (!Object.keys(thresholds).length) fail(`${field}.lighthouse needs at least one category threshold`);
      result.lighthouse = thresholds;
    }
  }
  return result;
}

export function visualQuality(value: unknown, field = 'visual.quality'): Partial<VisualQuality> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  const fields = value as Record<string, unknown>;
  const unknown = Object.keys(fields).find((key) => !['rounds', 'passScore'].includes(key));
  if (unknown) fail(`${field}.${unknown} is not a quality setting`);
  const result: Partial<VisualQuality> = {};
  if (fields.rounds !== undefined) {
    if (!Number.isInteger(fields.rounds) || (fields.rounds as number) < 0 || (fields.rounds as number) > MAX_VISUAL_ROUNDS) fail(`${field}.rounds must be a whole number between 0 and ${MAX_VISUAL_ROUNDS}`);
    result.rounds = fields.rounds as number;
  }
  if (fields.passScore !== undefined) {
    if (!Number.isInteger(fields.passScore) || (fields.passScore as number) < 1 || (fields.passScore as number) > 10) fail(`${field}.passScore must be a whole number between 1 and 10`);
    result.passScore = fields.passScore as number;
  }
  return result;
}

export function parseVisualSettings(value: unknown, field = 'visual'): VisualSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  const fields = value as Record<string, unknown>;
  const unknown = Object.keys(fields).find((key) => !['routes', 'viewports', 'themes', 'checks', 'quality'].includes(key));
  if (unknown) fail(`${field}.${unknown} is not a visual setting`);
  const settings: VisualSettings = {};
  if (fields.routes !== undefined) settings.routes = visualRoutes(fields.routes, `${field}.routes`);
  if (fields.viewports !== undefined) settings.viewports = list(fields.viewports, VISUAL_VIEWPORTS, `${field}.viewports`);
  if (fields.themes !== undefined) settings.themes = list(fields.themes, VISUAL_THEMES, `${field}.themes`);
  if (fields.checks !== undefined) settings.checks = visualChecks(fields.checks, `${field}.checks`);
  if (fields.quality !== undefined) settings.quality = visualQuality(fields.quality, `${field}.quality`);
  return settings;
}

export function visualSettingsProblem(value: unknown, field = 'visual'): string | null {
  try { parseVisualSettings(value, field); return null; }
  catch (error) { return error instanceof VisualConfigError ? error.message : 'invalid visual settings'; }
}

function layer(base: VisualConfig, settings: VisualSettings | null | undefined, source: VisualConfig['source']): VisualConfig {
  if (!settings) return base;
  const touched = !!(settings.routes || settings.viewports || settings.themes || settings.checks || settings.quality);
  return {
    routes: settings.routes ?? base.routes,
    viewports: settings.viewports ?? base.viewports,
    themes: settings.themes ?? base.themes,
    checks: { ...base.checks, ...(settings.checks ?? {}) },
    quality: { ...base.quality, ...(settings.quality ?? {}) },
    source: touched ? source : base.source,
  };
}

export function effectiveVisualConfig(policy: VisualSettings | null | undefined, settings: VisualSettings | null | undefined): VisualConfig {
  const defaults: VisualConfig = { routes: DEFAULT_VISUAL_ROUTES, viewports: [...VISUAL_VIEWPORTS], themes: [...VISUAL_THEMES], checks: { ...DEFAULT_VISUAL_CHECKS }, quality: { ...DEFAULT_VISUAL_QUALITY }, source: 'default' };
  return layer(layer(defaults, settings, 'settings'), policy, 'gitflare.json');
}

export function captureCount(config: Pick<VisualConfig, 'routes' | 'viewports' | 'themes'>): number {
  const frames = config.routes.reduce((total, route) => total + 1 + (route.steps ?? []).filter((item) => item.capture).length, 0);
  return frames * config.viewports.length * config.themes.length;
}

export function boundedCaptures(config: VisualConfig, limit = MAX_VISUAL_IMAGES): VisualConfig {
  let bounded = config;
  while (captureCount(bounded) > limit && bounded.themes.length > 1) bounded = { ...bounded, themes: [bounded.themes[0]!] };
  while (captureCount(bounded) > limit && bounded.routes.length > 1) bounded = { ...bounded, routes: bounded.routes.slice(0, -1) };
  while (captureCount(bounded) > limit && bounded.viewports.length > 1) bounded = { ...bounded, viewports: [bounded.viewports[0]!] };
  return bounded;
}
