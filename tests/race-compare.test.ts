import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentRun } from '../src/shared/types';

type ButtonProps = { children?: ReactNode; disabled?: boolean; title?: string; href?: string; onClick?: () => void };
const buttons: ButtonProps[] = [];
vi.mock('@cloudflare/kumo/components/button', () => ({
  Button: (props: ButtonProps) => { buttons.push(props); return createElement('button', { disabled: props.disabled, title: props.title }, props.children); },
  LinkButton: (props: ButtonProps) => { buttons.push(props); return createElement('a', { href: props.href }, props.children); },
}));

const { RaceCompareView, candidatePreview, embeddable, normalizePath, previewAt, shouldAutoStart, summaryPreview } = await import('../src/ui/RaceCompare');
type View = Parameters<typeof RaceCompareView>[0];

const procedural: AgentRun = { id: 'run-a', name: 'Procedural humanoid', role: 'Attempt', task: 'x', status: 'completed', commitSha: 'a6ea340'.padEnd(40, '0'), forkName: 'fork-a', changedFiles: ['src/player.ts'], model: 'openai/gpt-6-luna', summary: 'Builds the body from capsules.\nAdds a walk cycle.\nShades skin.\nTunes the camera.' };
const rigged: AgentRun = { id: 'run-b', name: 'Rigged-style character', role: 'Attempt', task: 'x', status: 'completed', commitSha: '92b5a25'.padEnd(40, '0'), forkName: 'fork-b', changedFiles: ['src/rig.ts'], modelConfig: { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5', source: 'gateway', protocol: 'anthropic' }, summary: 'Adds a skeleton.' };
const candidates = [
  { run: procedural, check: { id: 'c-a', runId: 'run-a', name: 'tests', status: 'passed' as const, candidateSha: procedural.commitSha!, durationMs: 4200 }, files: 3, additions: 120, deletions: 4, eligible: true },
  { run: rigged, check: { id: 'c-b', runId: 'run-b', name: 'tests', status: 'passed' as const, candidateSha: rigged.commitSha! }, files: 2, additions: 80, deletions: 1, eligible: true },
];

function render(overrides: Partial<View> = {}) {
  buttons.length = 0;
  const props: View = {
    mission: { status: 'needs_review', selectedRunId: undefined }, candidates, previews: {}, errors: {}, pending: {}, path: '/', draftPath: '/', canSelect: true, canStop: true, busy: '', now: Date.parse('2026-10-23T10:00:00Z'), allBusy: false,
    onDraftPath: () => {}, onApplyPath: () => {}, onPreviewAll: () => {}, onPreview: () => {}, onStop: () => {}, onFreeSlot: () => {}, onSelect: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(createElement(RaceCompareView, props));
}

describe('race compare view', () => {
  it('shows both candidates side by side with model, revision, files, checks and a short summary', () => {
    const html = render();
    expect(html).toContain('Compare candidates');
    expect(html).toContain('Each candidate gets its own live preview.');
    expect(html).toContain('Procedural humanoid');
    expect(html).toContain('openai/gpt-6-luna');
    expect(html).toContain('Claude Opus 5.5');
    expect(html).toContain('a6ea340');
    expect(html).toContain('passed · 4.2s');
    expect(html).toContain('+120');
    expect(html).toContain('<details class="race-compare-summary"><summary>Builds the body from capsules.\nAdds a walk cycle.\nShades skin.</summary>');
    expect(html).toContain('<p class="race-compare-summary">Adds a skeleton.</p>');
    expect(html).toContain('Preview all 2');
  });

  it('embeds each ready Worker Preview at its own URL on the shared path, with time left, Open preview and Stop', () => {
    const html = render({
      path: '/play',
      previews: {
        'run-a': { status: 'ready', kind: 'worker', access: 'link', url: 'https://pr-mission-runa-previews.acct.workers.dev', expiresAt: '2026-10-23T10:12:30Z' },
        'run-b': { status: 'ready', kind: 'worker', access: 'link', url: 'https://pr-mission-runb-previews.acct.workers.dev', expiresAt: '2026-10-23T10:05:00Z' },
      },
    });
    expect(html).toContain('<iframe class="race-compare-frame" src="https://pr-mission-runa-previews.acct.workers.dev/play" title="Preview of Procedural humanoid" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-pointer-lock"');
    expect(html).toContain('src="https://pr-mission-runb-previews.acct.workers.dev/play"');
    expect(html).toContain('12:30 left');
    expect(html).toContain('5:00 left');
    expect(buttons.filter((button) => button.children === 'Open preview').map((button) => button.href)).toEqual(['https://pr-mission-runa-previews.acct.workers.dev/play', 'https://pr-mission-runb-previews.acct.workers.dev/play']);
    expect(buttons.filter((button) => button.children === 'Stop')).toHaveLength(2);
    expect(html).toContain('All previews running');
  });

  it('opens members-only previews in a new tab instead of embedding them', () => {
    const html = render({ previews: { 'run-a': { status: 'ready', kind: 'container', access: 'members', url: 'https://preview.gitflare.test/open/token' } } });
    expect(html).toContain('Members-only previews open in a new tab.');
    expect(html.match(/<iframe/g)).toBeNull();
  });

  it('shows progress while a preview starts and a retry after a failure', () => {
    const html = render({ previews: { 'run-a': { status: 'starting', progress: { step: 'building' } }, 'run-b': { status: 'failed', error: 'Build failed.\nlog' } } });
    expect(html).toContain('Building');
    expect(html).toContain('Build failed.');
    expect(html).toContain('Try again');
  });

  it('chooses a candidate from the compare view and starts or stops its preview', () => {
    const selected: string[] = [];
    const previewed: string[] = [];
    let all = 0;
    render({ onSelect: (runId) => selected.push(runId), onPreview: (runId) => previewed.push(runId), onPreviewAll: () => { all += 1; } });
    buttons.filter((button) => button.children === 'Choose this one')[1].onClick!();
    buttons.filter((button) => button.children === 'Preview')[0].onClick!();
    buttons.find((button) => button.children === 'Preview all 2')!.onClick!();
    expect(selected).toEqual(['run-b']);
    expect(previewed).toEqual(['run-a']);
    expect(all).toBe(1);
  });

  it('marks the chosen candidate and needs review permission to choose', () => {
    const chosen = render({ mission: { status: 'needs_review', selectedRunId: 'run-a' } });
    expect(chosen).toContain('Chosen for review');
    expect(buttons.find((button) => button.children === 'Chosen for review')?.disabled).toBe(true);
    render({ canSelect: false });
    expect(buttons.filter((button) => button.children === 'Choose this one').every((button) => button.disabled && button.title === 'Choosing a candidate needs review permission.')).toBe(true);
    expect(render({ mission: { status: 'approved', selectedRunId: 'run-a' } })).not.toContain('Choose this one');
  });

  it('says when other missions hold every preview slot and offers to free one', () => {
    const freed: string[] = [];
    const html = render({ slotNotice: { limit: 2, holders: [{ id: 'mission-x', title: 'Dark mode' }] }, onFreeSlot: (id) => freed.push(id) });
    expect(html).toContain('Other missions are using all 2 preview slots of this workspace');
    buttons.find((button) => button.children?.toString().includes('Dark mode'))!.onClick!();
    expect(freed).toEqual(['mission-x']);
  });
});

describe('race compare helpers', () => {
  it('keeps the shared path on the preview origin', () => {
    expect(normalizePath(' play ')).toBe('/play');
    expect(normalizePath('')).toBe('/');
    expect(previewAt('https://a.workers.dev', '/play?x=1')).toBe('https://a.workers.dev/play?x=1');
    expect(previewAt('https://a.workers.dev', '//evil.example/x')).toBe('https://a.workers.dev/');
  });

  it('embeds only public workers.dev previews', () => {
    expect(embeddable({ status: 'ready', kind: 'worker', access: 'link', url: 'https://a.workers.dev' })).toBe(true);
    expect(embeddable({ status: 'ready', kind: 'worker', access: 'cloudflare-access', url: 'https://a.workers.dev' })).toBe(false);
    expect(embeddable({ status: 'ready', kind: 'worker', access: 'link', url: 'https://app.example.com' })).toBe(false);
    expect(embeddable({ status: 'ready', kind: 'container', access: 'members', url: 'https://preview.example/open/t' })).toBe(false);
  });

  it('reads replies into candidate previews and asks for a link when a container preview has none', () => {
    expect(candidatePreview({ status: 'ready', kind: 'worker', worker: { previewUrl: 'https://a.workers.dev', deploymentUrl: null }, access: 'link', expiresAt: 'x' })).toEqual({ status: 'ready', kind: 'worker', access: 'link', url: 'https://a.workers.dev', expiresAt: 'x' });
    expect(candidatePreview({ status: 'ready', kind: 'container', access: 'members' })).toBeNull();
    expect(candidatePreview({ status: 'starting', step: 'cloning' })).toEqual({ status: 'starting', progress: { step: 'cloning' } });
    expect(candidatePreview({ status: 'none' })).toEqual({ status: 'none' });
  });

  it('starts every preview automatically only for a fresh race awaiting a choice', () => {
    const none = [{ runId: 'a', status: 'none' }, { runId: 'b', status: 'none' }];
    expect(shouldAutoStart('needs_review', 2, none)).toBe(true);
    expect(shouldAutoStart('approved', 2, none)).toBe(false);
    expect(shouldAutoStart('needs_review', 2, [none[0], { runId: 'b', status: 'none', last: { reason: 'expired' } }])).toBe(false);
    expect(shouldAutoStart('needs_review', 2, [none[0], { runId: 'b', status: 'ready' }])).toBe(false);
    expect(shouldAutoStart('needs_review', 1, [none[0]])).toBe(false);
  });

  it('shortens long summaries to their first lines', () => {
    expect(summaryPreview('one\ntwo')).toEqual({ head: 'one\ntwo', more: false });
    expect(summaryPreview('1\n2\n3\n4')).toEqual({ head: '1\n2\n3', more: true });
  });
});
