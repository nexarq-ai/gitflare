import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AgentRetry, { AgentLimitsDetails } from '../src/ui/AgentRetry';
import { RETRY_PERMISSION_TITLE, RETRY_WAIT_TITLE, agentRetryBlocked, describeLimits, moreTimeOverride, retryAgentBody } from '../src/ui/agent-limits';
import type { AgentRetryOverride, MissionStatus } from '../src/shared/types';

type ButtonProps = { children?: ReactNode; disabled?: boolean; title?: string; onClick?: () => void };
const buttons: ButtonProps[] = [];
vi.mock('@cloudflare/kumo/components/button', () => ({
  Button: (props: ButtonProps) => { buttons.push(props); return createElement('button', { disabled: props.disabled, title: props.title }, props.children); },
}));

const limits = { modelAnswerSeconds: null, modelRetries: 2, maxSteps: 32, runSeconds: 600, autoRetry: true };
const run = { id: 'run-1', name: 'Renderer', model: 'anthropic/claude-sonnet-5-5', limits };
const models = [
  { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5', source: 'gateway' as const, protocol: 'anthropic' as const },
  { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5', source: 'gateway' as const, protocol: 'anthropic' as const },
];
const render = (status: MissionStatus, canExecute = true, onRetry: (override?: AgentRetryOverride) => void = () => {}) => renderToStaticMarkup(createElement(AgentRetry, { run, status, canExecute, busy: false, loading: false, models, onRetry }));

describe('per-agent retry', () => {
  it('sends only the run id for a plain retry and adds overrides when asked', () => {
    expect(retryAgentBody('run-1')).toEqual({ runIds: ['run-1'] });
    expect(retryAgentBody('run-1', { model: 'anthropic/claude-opus-5-5' })).toEqual({ runIds: ['run-1'], overrides: { 'run-1': { model: 'anthropic/claude-opus-5-5' } } });
    expect(retryAgentBody('run-1', moreTimeOverride(run))).toEqual({ runIds: ['run-1'], overrides: { 'run-1': { runSeconds: 1200, modelAnswerSeconds: 600 } } });
  });

  it('the Retry button retries only this agent with its pinned settings', () => {
    const sent: unknown[] = [];
    buttons.length = 0;
    render('failed', true, override => sent.push(retryAgentBody(run.id, override)));
    buttons.at(-1)!.onClick!();
    expect(sent).toEqual([{ runIds: ['run-1'] }]);
  });

  it('doubles time within the bounds', () => {
    expect(moreTimeOverride(run)).toEqual({ runSeconds: 1200, modelAnswerSeconds: 600 });
    expect(moreTimeOverride({ limits: { ...limits, runSeconds: 1200, modelAnswerSeconds: 120 } })).toEqual({ runSeconds: 1800, modelAnswerSeconds: 240 });
    expect(moreTimeOverride({})).toEqual({ runSeconds: 1200, modelAnswerSeconds: 600 });
  });

  it('is enabled with a menu once the attempt has failed or been cancelled', () => {
    for (const status of ['failed', 'cancelled'] as const) {
      expect(agentRetryBlocked(status, true)).toBeNull();
      const html = render(status);
      expect(html).toMatch(/title="Retry Renderer with the same limits and model"/);
      expect(html).not.toContain('disabled=""');
      expect(html).toContain('Retry with more time');
      expect(html).toContain('20 min per run, 600 s per model answer');
      expect(html).toContain('>Claude Opus 5.5<');
      expect(html).not.toContain('>Claude Sonnet 5.5<');
    }
  });

  it('is disabled with an explanation while the attempt runs or without execute permission', () => {
    for (const status of ['running', 'queued', 'checking', 'needs_review'] as const) {
      expect(agentRetryBlocked(status, true)).toBe(RETRY_WAIT_TITLE);
      const html = render(status);
      expect(html).toContain(`<button disabled="" title="${RETRY_WAIT_TITLE}">`);
      expect(html).not.toContain('Retry with more time');
    }
    expect(agentRetryBlocked('failed', false)).toBe(RETRY_PERMISSION_TITLE);
    expect(render('failed', false)).toContain(`<button disabled="" title="${RETRY_PERMISSION_TITLE}">`);
  });

  it('shows the pinned limits and edit scope', () => {
    expect(describeLimits(limits)).toBe('10 min, 32 steps, model answer automatic, 2 retries');
    const html = renderToStaticMarkup(createElement('dl', null, createElement(AgentLimitsDetails, { run: { limits: { ...limits, modelAnswerSeconds: 300 }, editScope: ['public/render3d.mjs', 'public/pose*.mjs'] } })));
    expect(html).toContain('10 min, 32 steps, model answer 300 s, 2 retries');
    expect(html).toContain('May edit');
    expect(html).toContain('<code>public/pose*.mjs</code>');
  });
});
