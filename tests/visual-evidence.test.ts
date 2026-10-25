import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRun, Check, VisualCapture, VisualEvidence } from '../src/shared/types';
import { blockingChecks, blockingChecksPassed, candidateVerified } from '../src/shared/checks';
import { captureCandidateEvidence, evidenceId, lighthouseCommand, pairCaptures, parseLighthouse, visualChecks } from '../src/worker/visual/evidence';
import { effectiveVisualConfig } from '../src/worker/visual/config';
import type { CaptureOutput } from '../src/worker/visual/capture';
import type { SandboxRunner } from '../src/worker/execution/environment';
import { visualView } from '../src/worker/mcp-results';
import { requiredAccess } from '../src/worker/mcp';
import VisualEvidencePanel, { changeLabel, evidenceFor } from '../src/ui/VisualEvidence';

vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} }, WorkerEntrypoint: class {}, WorkflowEntrypoint: class {} }));

const base = 'a'.repeat(40);
const sha = 'b'.repeat(40);

function capture(side: 'base' | 'candidate', overrides: Partial<VisualCapture> = {}): VisualCapture {
  const viewport = overrides.viewport ?? 'desktop';
  return { id: `v1-run.${side}.root_${viewport}_light`, side, route: '/', label: 'Home', viewport, theme: 'light', width: viewport === 'mobile' ? 390 : 1280, height: viewport === 'mobile' ? 844 : 800, format: 'png', bytes: 100, outline: 'Title: Demo', consoleErrors: [], overflow: 0, ...overrides };
}

function evidence(captures: VisualCapture[], mode: VisualEvidence['mode'] = 'browser'): VisualEvidence {
  return { id: 'v1-run', runId: 'run', candidateSha: sha, baseSha: base, epoch: 1, mode, browser: mode === 'browser' ? 'Chromium/140' : null, captures, warnings: mode === 'browser' ? [] : ['No Chromium in the runner image'], capturedAt: new Date().toISOString() };
}

describe('visual checks', () => {
  const config = effectiveVisualConfig({ checks: { regression: 0.01, axe: 'serious', lighthouse: { performance: 80, accessibility: 90 } } }, null);

  it('fails only on console errors and overflow the candidate introduced', () => {
    const item = evidence([
      capture('base', { consoleErrors: ['console.error legacy'] }), capture('candidate', { consoleErrors: ['console.error legacy', 'Uncaught TypeError: x is not a function'] }),
      capture('base', { viewport: 'mobile', overflow: 0 }), capture('candidate', { viewport: 'mobile', overflow: 64 }),
    ]);
    const checks = visualChecks(item, config, new Map(), null);
    const byName = Object.fromEntries(checks.map((check) => [check.name, check]));
    expect(byName['Visual: console errors']).toMatchObject({ status: 'failed', advisory: true, runId: 'run', candidateSha: sha, captureIds: ['v1-run.candidate.root_desktop_light'] });
    expect(byName['Visual: console errors']!.output).toContain('1 console error introduced by the candidate');
    expect(byName['Visual: console errors']!.output).toContain('1 error already present at the base were ignored');
    expect(byName['Visual: no overflow at 390px']).toMatchObject({ status: 'failed' });
    expect(byName['Visual: no overflow at 390px']!.output).toContain('Home (mobile, light): 64px');
    expect(checks.every((check) => check.advisory)).toBe(true);
  });

  it('passes inherited problems, applies the regression threshold and skips what could not run', () => {
    const item = evidence([
      capture('base', { consoleErrors: ['console.error legacy'], viewport: 'mobile', overflow: 20 }), capture('candidate', { consoleErrors: ['console.error legacy'], viewport: 'mobile', overflow: 20, diff: { against: 'x', changedRatio: 0.05, regions: [{ x: 0, y: 0, width: 16, height: 16 }] } }),
    ]);
    const byName = Object.fromEntries(visualChecks(item, config, new Map(), null).map((check) => [check.name, check]));
    expect(byName['Visual: console errors']!.status).toBe('passed');
    expect(byName['Visual: no overflow at 390px']!.status).toBe('passed');
    expect(byName['Visual: no overflow at 390px']!.output).toContain('already overflowed at the base');
    expect(byName['Visual: regression']).toMatchObject({ status: 'failed' });
    expect(byName['Visual: regression']!.output).toContain('5.00%');
    expect(byName['Accessibility (axe)']).toMatchObject({ status: 'skipped' });
    expect(byName['Lighthouse']).toMatchObject({ status: 'skipped' });
    const outline = visualChecks(evidence([capture('candidate')], 'outline'), config, new Map(), null);
    expect(outline.every((check) => check.status === 'skipped' && check.output?.includes('No browser ran'))).toBe(true);
  });

  it('reports new serious axe violations and Lighthouse scores under the thresholds', () => {
    const item = evidence([capture('base'), capture('candidate')]);
    const axe = new Map([[item.captures[0]!.id, [{ id: 'color-contrast', impact: 'serious', help: 'Contrast', nodes: 2, targets: ['p'] }]], [item.captures[1]!.id, [{ id: 'color-contrast', impact: 'serious', help: 'Contrast', nodes: 2, targets: ['p'] }, { id: 'button-name', impact: 'critical', help: 'Buttons need a name', nodes: 1, targets: ['#go'] }, { id: 'region', impact: 'moderate', help: 'Landmarks', nodes: 1, targets: ['body'] }]]]);
    const byName = Object.fromEntries(visualChecks(item, config, axe, { scores: { performance: 55, accessibility: 95 }, url: 'http://localhost:8080/' }).map((check) => [check.name, check]));
    expect(byName['Accessibility (axe)']).toMatchObject({ status: 'failed' });
    expect(byName['Accessibility (axe)']!.output).toContain('button-name (critical)');
    expect(byName['Accessibility (axe)']!.output).not.toContain('color-contrast');
    expect(byName['Lighthouse']).toMatchObject({ status: 'failed' });
    expect(byName['Lighthouse']!.output).toContain('Performance: 55 (minimum 80)');
    expect(byName['Lighthouse']!.output).toContain('Below the minimum: Performance.');
  });

  it('parses Lighthouse output and names the missing package', () => {
    expect(parseLighthouse('GITFLARE_LIGHTHOUSE_MISSING\n', 'u')).toEqual({ missing: true });
    expect(parseLighthouse('noise\n{"categories":{"performance":{"score":0.91},"best-practices":{"score":0.5}}}', 'u')).toEqual({ scores: { performance: 91, bestPractices: 50 }, url: 'u' });
    expect(parseLighthouse('{"runtimeError":{"message":"NO_FCP"}}', 'u')).toEqual({ error: 'NO_FCP' });
    expect(lighthouseCommand(8080, '/play')).toContain('"http://localhost:8080/play"');
    expect(evidenceId(2, undefined)).toBe('v2-integration');
    expect(pairCaptures(evidence([capture('base'), capture('candidate')]))[0]!.base?.side).toBe('base');
  });
});

describe('advisory checks and landing', () => {
  const checks: Check[] = [{ id: 'integration', name: 'Combined candidate tests', status: 'passed', candidateSha: sha }, { id: 'v-console', name: 'Visual: console errors', status: 'failed', candidateSha: sha, advisory: true }];

  it('ignores failed advisory checks unless they are the only evidence', () => {
    expect(blockingChecks(checks).map((check) => check.id)).toEqual(['integration']);
    expect(blockingChecksPassed(checks)).toBe(true);
    expect(candidateVerified(checks, sha)).toBe(true);
    expect(candidateVerified(checks.slice(1), sha)).toBe(false);
    expect(candidateVerified([{ ...checks[0]!, status: 'failed' }], sha)).toBe(false);
    expect(candidateVerified(checks, null)).toBe(false);
  });
});

describe('capturing base and candidate in one runner', () => {
  function output(side: string, extra: Partial<CaptureOutput> = {}): string {
    return JSON.stringify({ mode: 'browser', browser: 'Chromium/140', warnings: [], captures: [{ id: 'root_desktop_light', route: '/', label: 'Home', viewport: 'desktop', theme: 'light', width: 1280, height: 800, format: 'png', bytes: 3, image: side, outline: 'Title: Demo', consoleErrors: [], overflow: 0, ...(side === 'CAND' ? { diff: { against: 'root_desktop_light', changedRatio: 0.2, regions: [{ x: 0, y: 0, width: 16, height: 16 }], image: 'DIFF' } } : {}) }], ...extra } satisfies CaptureOutput);
  }

  it('installs, captures the base, checks out the candidate, captures with a diff and stores the images', async () => {
    const argvs: string[][] = [];
    const scripts: string[] = [];
    const runner = {
      prepare: vi.fn(), destroy: vi.fn(),
      command: vi.fn(async (argv: string[]) => { argvs.push(argv); if (argv[1] === 'ls-files') return { exitCode: 0, stdout: 'package.json\nsrc/App.tsx\n', stderr: '' }; if (argv[1] === 'rev-parse') return { exitCode: 0, stdout: base, stderr: '' }; if (argv[0] === 'cat') return { exitCode: 0, stdout: '{"scripts":{"dev":"vite"},"dependencies":{"react":"19.0.0"}}', stderr: '' }; return { exitCode: 0, stdout: '', stderr: '' }; }),
      install: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      startPreview: vi.fn(async () => 8080), stopPreview: vi.fn(async () => {}),
      collect: vi.fn(async (script: string) => { scripts.push(script); return { exitCode: 0, stdout: script.includes('"compareDir":') ? output('CAND') : output('BASE'), stderr: '' }; }),
    };
    const stored: { id: string; format: string }[] = [];
    const result = await captureCandidateEvidence({ SANDBOX: { getByName: () => runner as unknown as SandboxRunner } }, { key: 'gf-m-1-run', fork: { name: 'fork', remote: 'https://example/fork.git', defaultBranch: 'main' }, baseSha: base, candidateSha: sha, policy: { previewCommand: 'node src/preview.mjs', install: { installer: 'npm', lockfile: null, pinned: null, fallbackRange: null } } as never, config: effectiveVisualConfig({ themes: ['light'], viewports: ['desktop'], checks: { regression: 0.1 } }, null), changedFiles: ['src/App.tsx'], epoch: 1, runId: 'run', assertAuthority: async () => {}, isActive: async () => true, store: async (image) => { stored.push({ id: image.id, format: image.format }); } });
    expect(result).not.toBeNull();
    expect(runner.install).toHaveBeenCalledTimes(1);
    expect(runner.startPreview).toHaveBeenCalledTimes(2);
    expect(runner.stopPreview).toHaveBeenCalledTimes(2);
    expect(argvs.some((argv) => argv.join(' ') === `git checkout --detach ${sha}`)).toBe(true);
    expect(scripts[0]).toContain('/tmp/gitflare-visual/base');
    expect(scripts[1]).toContain('"compareDir":"/tmp/gitflare-visual/base"');
    expect(stored.map((image) => image.id)).toEqual(['v1-run.base.root_desktop_light', 'v1-run.candidate.root_desktop_light', 'v1-run.candidate.root_desktop_light.diff']);
    expect(result!.evidence.captures.map((capture) => capture.side)).toEqual(['base', 'candidate']);
    expect(result!.evidence.captures[1]!.diff).toEqual({ against: 'v1-run.base.root_desktop_light', changedRatio: 0.2, regions: [{ x: 0, y: 0, width: 16, height: 16 }], imageId: 'v1-run.candidate.root_desktop_light.diff' });
    expect(result!.checks.map((check) => [check.name, check.status])).toEqual([['Visual: console errors', 'passed'], ['Visual: no overflow at 390px', 'skipped'], ['Visual: regression', 'failed']]);
    expect(runner.destroy).toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('"BASE"');
  });

  it('skips candidates that change no UI file', async () => {
    const getByName = vi.fn();
    expect(await captureCandidateEvidence({ SANDBOX: { getByName } }, { key: 'k', fork: { name: 'f', remote: 'r', defaultBranch: 'main' }, baseSha: base, candidateSha: sha, policy: {} as never, config: effectiveVisualConfig(null, null), changedFiles: ['src/worker/index.ts', 'README.md'], epoch: 1, assertAuthority: async () => {}, isActive: async () => true, store: async () => {} })).toBeNull();
    expect(getByName).not.toHaveBeenCalled();
  });
});

describe('visual evidence on the mission page and over MCP', () => {
  const item = evidence([capture('base'), capture('candidate', { diff: { against: 'v1-run.base.root_desktop_light', changedRatio: 0.0127, regions: [{ x: 16, y: 0, width: 32, height: 32 }], imageId: 'v1-run.candidate.root_desktop_light.diff' }, consoleErrors: ['console.error boom'] })]);
  const runs = [{ id: 'run', name: 'Builder', role: 'Implementation', task: 't', status: 'completed', changedFiles: [] }] as AgentRun[];

  it('renders before and after with changed regions and the related checks', () => {
    const html = renderToStaticMarkup(createElement(VisualEvidencePanel, { missionId: 'm1', evidence: [item], runs, checks: [{ id: 'c', name: 'Visual: console errors', status: 'failed', candidateSha: sha, runId: 'run', advisory: true }] }));
    expect(html).toContain('Builder');
    expect(html).toContain('/api/missions/m1/visual/v1-run.base.root_desktop_light');
    expect(html).toContain('/api/missions/m1/visual/v1-run.candidate.root_desktop_light');
    expect(html).toContain('class="visual-region"');
    expect(html).toContain('1.3% changed');
    expect(html).toContain('Visual: console errors: failed');
    expect(html).toContain('console.error boom');
    expect(renderToStaticMarkup(createElement(VisualEvidencePanel, { missionId: 'm1', evidence: [], runs, checks: [] }))).toContain('No screenshots yet');
  });

  it('selects the evidence for the mode and the chosen candidate', () => {
    const integration = { ...item, id: 'v1-integration', runId: undefined };
    expect(evidenceFor([item, integration], undefined, false).map((entry) => entry.id)).toEqual(['v1-integration']);
    expect(evidenceFor([item], undefined, false).map((entry) => entry.id)).toEqual(['v1-run']);
    expect(evidenceFor([item, { ...item, id: 'v1-other', runId: 'other' }], 'other', true).map((entry) => entry.id)).toEqual(['v1-other']);
    expect(evidenceFor([item, { ...item, id: 'v1-other', runId: 'other' }], undefined, true)).toHaveLength(2);
    expect(changeLabel({ diff: undefined })).toBe('No base capture');
    expect(changeLabel({ diff: { against: '', changedRatio: 1, regions: [] } })).toBe('New route');
  });

  it('lists captures with image references for MCP clients and reads screenshots with read access', () => {
    const view = visualView({ id: 'm1', runs, visual: [item] } as never, (value) => ({ text: value, totalCharacters: value.length, offset: 0, nextOffset: null }));
    expect(view[0]).toMatchObject({ id: 'v1-run', runName: 'Builder', mode: 'browser' });
    expect((view[0]!.captures as Record<string, unknown>[])[1]).toMatchObject({ side: 'candidate', diff: { changedRatio: 0.0127 }, image: { tool: 'gitflare_mission_screenshot', mission_id: 'm1', capture_id: 'v1-run.candidate.root_desktop_light', path: '/api/missions/m1/visual/v1-run.candidate.root_desktop_light' } });
    expect(requiredAccess('gitflare_mission_screenshot', { readOnlyHint: true }, {})).toBe('read');
  });
});
