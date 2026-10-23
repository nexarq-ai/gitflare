import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} },
  WorkerEntrypoint: class {},
  WorkflowEntrypoint: class {},
}));
import { boundedCaptures, captureCount, DEFAULT_VISUAL_CHECKS, effectiveVisualConfig, isUiPath, MAX_VISUAL_IMAGES, parseVisualSettings, touchesUi, visualSettingsProblem } from '../src/worker/visual/config';
import { visualSettingsInput, visualSettingsSnapshot } from '../src/worker/visual/settings';
import { parseRepositoryPolicy } from '../src/worker/repository-policy';
import { requiredAccess } from '../src/worker/mcp';

describe('visual settings parsing', () => {
  it('accepts routes with labels and interaction steps', () => {
    const settings = parseVisualSettings({ routes: ['/', { path: '/play', label: 'Fight', steps: [{ click: '#start' }, { wait: 500 }, { press: 'ArrowRight', hold: 300 }, { press: 'KeyX' }, { capture: 'punch' }] }], viewports: ['mobile'], themes: ['dark', 'dark'], checks: { regression: 0.02, axe: 'serious', lighthouse: { performance: 70 } }, quality: { rounds: 2 } });
    expect(settings.routes).toEqual([{ path: '/' }, { path: '/play', label: 'Fight', steps: [{ click: '#start' }, { wait: 500 }, { press: 'ArrowRight', hold: 300 }, { press: 'KeyX' }, { capture: 'punch' }] }]);
    expect(settings.viewports).toEqual(['mobile']);
    expect(settings.themes).toEqual(['dark']);
    expect(settings.checks).toEqual({ regression: 0.02, axe: 'serious', lighthouse: { performance: 70 } });
    expect(settings.quality).toEqual({ rounds: 2 });
  });

  it.each([
    [{ routes: [] }, 'visual.routes must list between 1 and 6 routes'],
    [{ routes: ['play'] }, 'visual.routes[0].path must be an absolute path'],
    [{ routes: ['/', '/'] }, 'visual.routes[1] repeats /'],
    [{ routes: [{ path: '/', steps: [{ click: '#a', press: 'KeyX' }] }] }, 'exactly one of click, press, type, wait, scroll or capture'],
    [{ routes: [{ path: '/', steps: [{ press: 'Meta' }] }] }, 'visual.routes[0].steps[0].press must be a key'],
    [{ routes: [{ path: '/', steps: [{ click: '#a', hold: 10 }] }] }, 'hold applies only with press'],
    [{ viewports: ['tablet'] }, 'visual.viewports must list one or more of "desktop", "mobile"'],
    [{ checks: { regression: 2 } }, 'visual.checks.regression must be a ratio between 0 and 1'],
    [{ checks: { lighthouse: {} } }, 'visual.checks.lighthouse needs at least one category threshold'],
    [{ checks: { lighthouse: { pwa: 50 } } }, 'visual.checks.lighthouse.pwa is not a Lighthouse category'],
    [{ quality: { rounds: 9 } }, 'visual.quality.rounds must be a whole number between 0 and 4'],
    [{ network: true }, 'visual.network is not a visual setting'],
  ])('rejects %j', (value, message) => {
    expect(visualSettingsProblem(value)).toContain(message);
  });

  it('reads the visual key of gitflare.json and rejects a broken one with the file name', () => {
    const policy = parseRepositoryPolicy(JSON.stringify({ test: 'npm test', visual: { routes: ['/dashboard'], themes: ['light'] } }), 'node --test');
    expect(policy.visual).toEqual({ routes: [{ path: '/dashboard' }], themes: ['light'] });
    expect(() => parseRepositoryPolicy(JSON.stringify({ visual: { routes: 'x' } }), 'node --test')).toThrow('gitflare.json: visual.routes must list between 1 and 6 routes');
    expect(parseRepositoryPolicy(JSON.stringify({ test: 'npm test' }), 'node --test').visual).toBeUndefined();
  });

  it('layers gitflare.json over the repository settings over the defaults', () => {
    const defaults = effectiveVisualConfig(null, null);
    expect(defaults).toMatchObject({ routes: [{ path: '/', label: 'Home' }], viewports: ['desktop', 'mobile'], themes: ['light', 'dark'], checks: DEFAULT_VISUAL_CHECKS, quality: { rounds: 0, passScore: 8 }, source: 'default' });
    const stored = effectiveVisualConfig(null, { routes: [{ path: '/app' }], checks: { regression: 0.05 } });
    expect(stored).toMatchObject({ routes: [{ path: '/app' }], checks: { ...DEFAULT_VISUAL_CHECKS, regression: 0.05 }, source: 'settings' });
    const file = effectiveVisualConfig({ themes: ['dark'], quality: { rounds: 1 } }, { routes: [{ path: '/app' }], checks: { regression: 0.05 } });
    expect(file).toMatchObject({ routes: [{ path: '/app' }], themes: ['dark'], checks: { regression: 0.05 }, quality: { rounds: 1, passScore: 8 }, source: 'gitflare.json' });
  });

  it('caps the number of images by dropping themes, then routes, then viewports', () => {
    const routes = Array.from({ length: 6 }, (_, index) => ({ path: `/${index}`, steps: [{ capture: 'a' }, { capture: 'b' }] }));
    const config = effectiveVisualConfig({ routes }, null);
    expect(captureCount(config)).toBe(72);
    const bounded = boundedCaptures(config);
    expect(captureCount(bounded)).toBeLessThanOrEqual(MAX_VISUAL_IMAGES);
    expect(bounded.themes).toEqual(['light']);
    expect(bounded.viewports).toEqual(['desktop', 'mobile']);
    expect(bounded.routes.length).toBe(5);
  });

  it('detects UI files by extension and front-end directories, never tests', () => {
    for (const path of ['src/ui/App.tsx', 'styles.css', 'public/index.html', 'src/components/Button.ts', 'app/page.js', 'assets/logo.svg', 'src/pages/home.vue']) expect(isUiPath(path), path).toBe(true);
    for (const path of ['src/worker/index.ts', 'tests/ui.test.ts', 'src/ui/App.test.tsx', 'package.json', 'README.md', 'lib/util.mjs']) expect(isUiPath(path), path).toBe(false);
    expect(touchesUi(['src/worker/index.ts', 'src/ui/styles.css'])).toBe(true);
    expect(touchesUi(['src/worker/index.ts'])).toBe(false);
  });
});

describe('visual settings API shape', () => {
  it('normalizes the request body and rejects unknown fields', () => {
    expect(visualSettingsInput({ routes: ['/x'], viewports: ['desktop'], checks: null })).toEqual({ routes: [{ path: '/x' }], viewports: ['desktop'] });
    expect(() => visualSettingsInput({ routes: ['x'] })).toThrow('settings.routes[0].path');
    expect(() => visualSettingsInput({ preview: true })).toThrow('preview is not a visual setting');
  });

  it('reports the effective configuration, its source and the limits', () => {
    const snapshot = visualSettingsSnapshot('repo', { routes: [{ path: '/app' }], updatedBy: 'owner' }, { themes: ['dark'] }, undefined);
    expect(snapshot).toMatchObject({ repositoryId: 'repo', routes: [{ path: '/app' }], updatedBy: 'owner', effective: { routes: [{ path: '/app' }], themes: ['dark'], source: 'gitflare.json' }, limits: { maxRoutes: 6, maxSteps: 12, maxRounds: 4 } });
    expect(visualSettingsSnapshot('repo', undefined, null, 'gitflare.json: bad').policyProblem).toBe('gitflare.json: bad');
  });

  it('exposes the settings over MCP with read and land access', () => {
    expect(requiredAccess('gitflare_visual_settings', { readOnlyHint: true }, {})).toBe('read');
    expect(requiredAccess('gitflare_set_visual_settings', { readOnlyHint: false }, {})).toBe('land');
  });
});
