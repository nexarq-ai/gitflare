import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FixQuote } from '../src/shared/types';
import { aiSetupPath, requestChangePath, requestedPersonalWorkspace, returnPathFrom, safeReturnPath } from '../src/shared/ai-setup';
import { askMaintainersHref, changeTitle, RequestChangeBody } from '../src/ui/FixRequests';

const API = '/api/public/repos/gitflare/gitflare';
const base: FixQuote = { signedIn: true, available: false, source: null, model: null, reason: '', waitsForMaintainer: false, remainingToday: null, setup: null };
const render = (quote: FixQuote | null, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(RequestChangeBody, { api: API, quote, error: '', done: '', goal: '', busy: false, onGoal: () => {}, onSubmit: () => {}, onClose: () => {}, ...extra }));

describe('request a change dialog', () => {
  it('shows the form with one line naming who pays when the request is funded', () => {
    const pool = { ...base, available: true, source: 'pool' as const, model: { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna' }, reason: 'Uses this project’s community AI pool.', remainingToday: 2 };
    expect(changeTitle(pool)).toBe('Request a change');
    const html = render(pool);
    expect(html).toContain('Paid by this project&#x27;s AI pool.');
    expect(html).toContain('<textarea');
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
    expect(html).toContain('Request change');
    const own = render({ ...pool, source: 'requester', remainingToday: null });
    expect(own).toContain('Paid by your AI key (GPT-6 Luna).');
  });

  it('replaces the form with a connect step when nothing can pay', () => {
    const url = `https://app.gitflare.io${aiSetupPath(requestChangePath('gitflare', 'gitflare'), false)}`;
    const quote = { ...base, reason: 'This project doesn’t pay for requests. Connect your own AI model to send one.', setup: { url, handleRequired: false } };
    expect(changeTitle(quote)).toBe('Connect an AI model to request changes');
    const html = render(quote);
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('Connect AI model');
    expect(html).toContain(`href="${url.replace(/&/g, '&amp;')}"`);
    expect(html).toContain('Ask maintainers instead');
    expect(html).toContain('href="/gitflare/gitflare/issues/new?body=');
  });

  it('offers only the issue route when the project cannot take requests at all', () => {
    const quote = { ...base, reason: 'This project has turned AI features off.' };
    expect(changeTitle(quote)).toBe('Requests aren\'t available here');
    const html = render(quote);
    expect(html).not.toContain('Connect AI model');
    expect(html).toContain('Ask maintainers instead');
  });

  it('asks a signed-out viewer to sign in', () => {
    const quote = { ...base, signedIn: false, reason: 'Sign in to request a change.' };
    expect(changeTitle(quote)).toBe('Sign in to request a change');
    const html = render(quote);
    expect(html).toContain('href="/signin"');
    expect(html).not.toContain('<textarea');
  });

  it('shows a loading state, then errors without a form', () => {
    expect(render(null)).toContain('aria-busy="true"');
    expect(render(null, { error: 'This project could not be checked.' })).toContain('This project could not be checked.');
  });

  it('prefills the issue body for maintainers', () => {
    const href = askMaintainersHref(API);
    expect(href.startsWith('/gitflare/gitflare/issues/new?')).toBe(true);
    expect(new URLSearchParams(href.split('?')[1]).get('body')).toContain('What should change');
  });
});

describe('connect and return', () => {
  it('sends people without a handle through their profile first, then AI models, then back to the dialog', () => {
    const back = requestChangePath('acme', 'widgets');
    expect(back).toBe('/acme/widgets?change=1');
    const models = aiSetupPath(back, false);
    expect(models.startsWith('/settings/models?')).toBe(true);
    expect(returnPathFrom(models.slice(models.indexOf('?')))).toBe(back);
    const profile = aiSetupPath(back, true);
    expect(profile.startsWith('/account/profile?')).toBe(true);
    expect(returnPathFrom(profile.slice(profile.indexOf('?')))).toBe(models);
  });

  it('opens the personal workspace only when asked and only if it exists', () => {
    const workspaces = [{ id: 'team' }, { id: 'personal-u1' }];
    expect(requestedPersonalWorkspace('?workspace=personal', 'u1', workspaces)).toBe('personal-u1');
    expect(requestedPersonalWorkspace('', 'u1', workspaces)).toBeNull();
    expect(requestedPersonalWorkspace('?workspace=personal', 'u2', workspaces)).toBeNull();
  });

  it('accepts only same-origin return paths', () => {
    expect(safeReturnPath('/acme/widgets?change=1')).toBe('/acme/widgets?change=1');
    for (const unsafe of ['https://evil.test/', '//evil.test/', '/\\evil.test', 'javascript:alert(1)', '/a b', '', null]) expect(safeReturnPath(unsafe)).toBeNull();
  });
});
