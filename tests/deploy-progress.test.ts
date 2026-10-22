import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConfirmActions, ConfirmFacts } from '../src/ui/ConfirmDialog';
import { DeployPillView, DeployProgressCard } from '../src/ui/DeployProgress';
import { currentStep, deploySnapshot, dismissDeployment, dismissedDeployments, formatElapsed, productionPrompt, progressItems, publishDeployments, shortSha, watchedDeployments, type DeploymentSummary } from '../src/ui/deploy-progress';

const sha = '80496add9508c0ffee1234567890abcdef123456';
const started = '2026-10-18T10:00:00.000Z';
const at = (offsetSeconds: number) => Date.parse(started) + offsetSeconds * 1000;
const deployment = (patch: Partial<DeploymentSummary> = {}): DeploymentSummary => ({ id: 'd1', workerName: 'web', environment: 'production', commitSha: sha, trigger: 'manual', status: 'building', createdAt: started, ...patch });

describe('production deploy confirmation', () => {
  it('names the commit, Workers, account and the live traffic change', () => {
    const prompt = productionPrompt({ action: 'deploy', commitSha: sha, commitMessage: 'Fix checkout retries\n\nLonger body', workers: ['web', 'api'], account: 'nexarq AI (1bad89ff)' });
    expect(prompt.title).toBe('Deploy to production?');
    expect(prompt.confirmLabel).toBe('Deploy to production');
    expect(prompt.description).toMatch(/live traffic/);
    expect(prompt.facts).toEqual([
      { label: 'Commit', value: '80496ad Fix checkout retries', title: sha },
      { label: 'Workers', value: 'web, api', code: true },
      { label: 'Cloudflare account', value: 'nexarq AI (1bad89ff)' },
    ]);
  });

  it('uses specific verbs for promote and rollback and marks rollback as dangerous', () => {
    const promote = productionPrompt({ action: 'promote', commitSha: sha, workers: ['web'], account: null, from: 'staging' });
    expect(promote.confirmLabel).toBe('Promote to production');
    expect(promote.facts?.map((fact) => fact.label)).toEqual(['Commit', 'From', 'Worker', 'Cloudflare account']);
    expect(promote.facts?.at(-1)?.value).toBe("The repository's deploy account");
    const rollback = productionPrompt({ action: 'rollback', workers: ['web'], account: 'acct' });
    expect(rollback).toMatchObject({ confirmLabel: 'Roll back production', tone: 'danger' });
  });

  it('renders the facts and a danger confirm button next to Cancel', () => {
    const facts = renderToStaticMarkup(createElement(ConfirmFacts, { facts: productionPrompt({ action: 'deploy', commitSha: sha, workers: ['web'], account: 'acct' }).facts! }));
    expect(facts).toContain(`title="${sha}"`);
    expect(facts).toContain('>80496ad</dd>');
    expect(facts).toContain('<code>web</code>');
    const actions = renderToStaticMarkup(createElement(ConfirmActions, { prompt: { title: 'Remove?', description: '', confirmLabel: 'Remove protection', tone: 'danger' }, onCancel: () => {}, onConfirm: () => {} }));
    expect(actions.indexOf('Cancel')).toBeLessThan(actions.indexOf('Remove protection'));
  });
});

describe('deploy progress', () => {
  it('formats elapsed time and the current step', () => {
    expect(formatElapsed(9_400)).toBe('9s');
    expect(formatElapsed(125_000)).toBe('2m 05s');
    expect(formatElapsed(3_900_000)).toBe('1h 5m');
    expect(formatElapsed(-5)).toBe('0s');
    expect(currentStep({ status: 'rolling_out' })).toBe('Rollout');
    expect(currentStep({ status: 'uploaded', mode: 'upload-only' })).toBe('Uploaded');
    expect(currentStep({ status: 'failed' })).toBe('Failed');
    expect(shortSha(sha)).toBe('80496ad');
  });

  it('keeps finished deployments only when they were watched and not dismissed', () => {
    const running = deployment({ id: 'a', environment: 'staging', status: 'deploying' });
    const done = deployment({ id: 'b', status: 'succeeded' });
    const broken = deployment({ id: 'c', status: 'failed', error: 'D1 migration 0004 failed' });
    const old = deployment({ id: 'd', status: 'succeeded' });
    expect(progressItems([running, done, broken, old], new Set(['b', 'c']), new Set()).map((item) => [item.deployment.id, item.phase])).toEqual([['a', 'active'], ['b', 'succeeded'], ['c', 'failed']]);
    expect(progressItems([running, done, broken], new Set(['b', 'c']), new Set(['b'])).map((item) => item.deployment.id)).toEqual(['a', 'c']);
  });

  it('remembers deployments seen running so their outcome stays visible until dismissed', () => {
    publishDeployments('repo-1', [deployment({ id: 'x', status: 'queued' })]);
    publishDeployments('repo-1', [deployment({ id: 'x', status: 'succeeded' })]);
    expect(deploySnapshot('repo-1')?.deployments[0].status).toBe('succeeded');
    expect(watchedDeployments('repo-1').has('x')).toBe(true);
    expect(watchedDeployments('repo-2').size).toBe(0);
    dismissDeployment('x');
    expect(progressItems(deploySnapshot('repo-1')!.deployments, watchedDeployments('repo-1'), dismissedDeployments())).toEqual([]);
  });
});

describe('deploy status pill', () => {
  const render = (props: Parameters<typeof DeployPillView>[0]) => renderToStaticMarkup(createElement(DeployPillView, props));

  it('shows environment, step, elapsed time and links to the Deploys page while running', () => {
    const html = render({ item: { deployment: deployment({ status: 'deploying' }), phase: 'active' }, others: 1, now: at(75), href: '/repository/r1/settings/deploys', onDismiss: () => {} });
    expect(html).toContain('Production · Deploying');
    expect(html).toContain('Deploy · 1m 15s');
    expect(html).toContain('href="/repository/r1/settings/deploys"');
    expect(html).toContain(`title="${sha}"`);
    expect(html).toContain('+1 more');
    expect(html).not.toContain('Dismiss deploy status');
  });

  it('switches to Live with the URL, and to the failure reason, both dismissable', () => {
    const live = render({ item: { deployment: deployment({ status: 'succeeded', targets: [{ workerName: 'web', urls: ['https://web.example.workers.dev'] }] }), phase: 'succeeded' }, now: at(300), href: '/d', onDismiss: () => {} });
    expect(live).toContain('Production · Live');
    expect(live).toContain('href="https://web.example.workers.dev"');
    expect(live).toContain('Dismiss deploy status');
    const failed = render({ item: { deployment: deployment({ status: 'failed', error: 'Build failed: npm ci exited 1' }), phase: 'failed' }, now: at(300), href: '/d', onDismiss: () => {} });
    expect(failed).toContain('Production · Failed');
    expect(failed).toContain('Build failed: npm ci exited 1');
    expect(failed).toContain('Dismiss deploy status');
  });

  it('renders the full-width progress card with stages and the current step marked', () => {
    const html = renderToStaticMarkup(createElement(DeployProgressCard, { item: { deployment: deployment({ status: 'rolling_out' }), phase: 'active' }, now: at(10) }));
    expect(html).toContain('Deploying to Production');
    expect(html).toContain('aria-current="step">Rollout');
    expect(html).toContain('10s');
  });
});
