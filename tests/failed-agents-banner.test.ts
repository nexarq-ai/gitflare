import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import FailedAgentsBanner from '../src/ui/FailedAgentsBanner';
import type { AgentRun, Mission, MissionStatus } from '../src/shared/types';
import { missionSummary } from '../src/worker/mcp-results';

type ButtonProps = { children?: ReactNode; disabled?: boolean; title?: string; onClick?: () => void };
const buttons: ButtonProps[] = [];
vi.mock('@cloudflare/kumo/components/button', () => ({
  Button: (props: ButtonProps) => { buttons.push(props); return createElement('button', { disabled: props.disabled, title: props.title }, props.children); },
}));

const runs: AgentRun[] = [
  { id: 'vis', name: 'Visibility', role: 'Implementation', task: 'Show the player.', status: 'completed', changedFiles: ['src/player.ts'], commitSha: '1'.repeat(40) },
  { id: 'coord', name: 'Coordinator', role: 'Integration', task: 'Integrate.', status: 'failed', changedFiles: [], coordinator: true, error: 'Agent finished without changing any files', model: 'anthropic/claude-opus-5-5' },
];
const models = [{ id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5', source: 'gateway' as const, protocol: 'anthropic' as const }];
const render = (status: MissionStatus, options: { canRetry?: boolean; canDrop?: boolean; onRetry?: (runId: string) => void; onDrop?: () => void } = {}) => renderToStaticMarkup(createElement(FailedAgentsBanner, {
  mission: { status, runs }, canExecute: true, canRetry: options.canRetry ?? true, canDrop: options.canDrop ?? true, busy: '', models,
  onRetry: options.onRetry ?? (() => {}), onDrop: options.onDrop ?? (() => {}),
}));

describe('failed agents banner', () => {
  it('names each failed agent with its reason and offers retry, more time, another model and continuing without it', () => {
    const html = render('failed');
    expect(html).toContain('<strong>Coordinator failed, so this attempt has no combined candidate.</strong>');
    expect(html).toContain('<span class="failed-agents-name">Coordinator</span><span class="failed-agents-reason">Agent finished without changing any files</span>');
    expect(html).not.toContain('>Visibility<');
    expect(html).toContain('Retry with more time');
    expect(html).toContain('>Claude Sonnet 5.5<');
    expect(html).toContain('Continue without Coordinator');
  });

  it('wires Retry to the failed agent and Continue to dropping it', () => {
    const retried: string[] = [];
    let dropped = false;
    buttons.length = 0;
    render('failed', { onRetry: (runId) => retried.push(runId), onDrop: () => { dropped = true; } });
    buttons.find((button) => button.children === 'Retry')!.onClick!();
    buttons.find((button) => button.children === 'Continue without Coordinator')!.onClick!();
    expect(retried).toEqual(['coord']);
    expect(dropped).toBe(true);
  });

  it('shows reasons without actions when retrying is not possible, and nothing while the mission is not failed', () => {
    const html = render('failed', { canRetry: false, canDrop: false });
    expect(html).toContain('Agent finished without changing any files');
    expect(html).not.toContain('Retry');
    expect(html).not.toContain('Continue without');
    expect(render('running')).toBe('');
    expect(render('needs_review')).toBe('');
  });

  it('lists failed agents with reasons in the MCP mission summary', () => {
    const mission = { id: 'm', repositoryId: 'r', title: 'Visible player', prompt: 'Show the player.', status: 'failed', epoch: 3, baseSha: 'a'.repeat(40), candidateSha: null, runs, checks: [], changes: [], events: [], createdAt: '', updatedAt: '', error: 'An agent failed, so no combined candidate was made. Coordinator: Agent finished without changing any files' } as Mission;
    expect(missionSummary(mission)).toMatchObject({ error: mission.error, failedAgents: [{ runId: 'coord', name: 'Coordinator', reason: 'Agent finished without changing any files' }] });
  });
});
