import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { agentSettingsBody, agentSettingsForm, agentSettingsProblems } from '../src/ui/AgentSettings';
import { LimitFieldsEditor } from '../src/ui/ProposalCreate';
import { limitFieldsProblem, limitOverrides, parseDuration, parseEditScope, taskLimits } from '../src/ui/agent-limits';
import { REPOSITORY_SETTINGS_PAGES, isKnownAppRoute } from '../src/ui/router';
import type { RepositoryAgentSettings } from '../src/shared/types';

const bounds = { modelAnswerSeconds: { min: 30, max: 600 }, modelRetries: { min: 0, max: 3 }, maxSteps: { min: 1, max: 32 }, runSeconds: { min: 120, max: 1800 }, editScope: { maxEntries: 20, maxLength: 200 } };
const defaults = { modelAnswerSeconds: null, modelRetries: 2, maxSteps: 32, runSeconds: 600, autoRetry: true };
const snapshot: RepositoryAgentSettings = { repositoryId: 'r', settings: {}, effective: defaults, defaults, bounds };

describe('repository Agents settings page', () => {
  it('is a repository settings route', () => {
    expect(REPOSITORY_SETTINGS_PAGES.some(page => page.path === 'agents' && page.label === 'Agents')).toBe(true);
    expect(isKnownAppRoute('repository/abc/settings/agents')).toBe(true);
  });

  it('shows defaults with automatic model answer time and saves the API body', () => {
    const form = agentSettingsForm(snapshot);
    expect(form).toEqual({ modelAnswer: '', modelRetries: '2', maxSteps: '32', runTime: '10', autoRetry: true });
    expect(agentSettingsProblems(form, bounds)).toEqual({});
    expect(agentSettingsBody(form)).toEqual({ modelAnswerSeconds: null, modelRetries: 2, maxSteps: 32, runSeconds: 600, autoRetry: true });
    expect(agentSettingsBody({ modelAnswer: '240', modelRetries: '0', maxSteps: '12', runTime: '900s', autoRetry: false })).toEqual({ modelAnswerSeconds: 240, modelRetries: 0, maxSteps: 12, runSeconds: 900, autoRetry: false });
  });

  it('rejects values outside the bounds', () => {
    expect(Object.keys(agentSettingsProblems({ modelAnswer: '5', modelRetries: '4', maxSteps: '33', runTime: '31', autoRetry: true }, bounds)).sort()).toEqual(['maxSteps', 'modelAnswer', 'modelRetries', 'runTime']);
    expect(agentSettingsProblems({ modelAnswer: '', modelRetries: '3', maxSteps: '1', runTime: '30', autoRetry: true }, bounds)).toEqual({});
  });
});

describe('mission form agent limits', () => {
  it('parses minutes and seconds', () => {
    expect(parseDuration('15')).toBe(900);
    expect(parseDuration('900s')).toBe(900);
    expect(parseDuration('20 min')).toBe(1200);
    expect(parseDuration('')).toBeUndefined();
    expect(parseDuration('soon')).toBeNull();
  });

  it('serialises edit scope and overrides per agent and omits empty fields', () => {
    expect(parseEditScope('public/render3d.mjs, public/pose*.mjs\npublic/pose*.mjs\n')).toEqual(['public/render3d.mjs', 'public/pose*.mjs']);
    expect(taskLimits({ editScope: 'public/render3d.mjs,public/pose*.mjs', runTime: '20', maxSteps: '16' })).toEqual({ editScope: ['public/render3d.mjs', 'public/pose*.mjs'], overrides: { runSeconds: 1200, maxSteps: 16 } });
    expect(taskLimits({ editScope: ' ', runTime: '', maxSteps: '' })).toEqual({});
    expect(taskLimits(undefined)).toEqual({});
    expect(taskLimits({ editScope: '', runTime: '', maxSteps: '8' })).toEqual({ overrides: { maxSteps: 8 } });
  });

  it('builds Auto mode agentOverrides with the same fields', () => {
    expect(limitOverrides({ editScope: 'src/**', runTime: '1800s', maxSteps: '' })).toEqual({ editScope: ['src/**'], runSeconds: 1800 });
    expect(limitOverrides({ editScope: '', runTime: '', maxSteps: '' })).toBeUndefined();
  });

  it('flags invalid limits before submit', () => {
    expect(limitFieldsProblem({ editScope: Array.from({ length: 21 }, (_, index) => `f${index}`).join(','), runTime: '', maxSteps: '' })?.field).toBe('editScope');
    expect(limitFieldsProblem({ editScope: '../secret', runTime: '', maxSteps: '' })?.field).toBe('editScope');
    expect(limitFieldsProblem({ editScope: '', runTime: '1', maxSteps: '' })?.field).toBe('runTime');
    expect(limitFieldsProblem({ editScope: '', runTime: '', maxSteps: '40' })?.field).toBe('maxSteps');
    expect(limitFieldsProblem({ editScope: 'a.mjs', runTime: '10', maxSteps: '4' })).toBeNull();
  });

  it('renders the three limit fields', () => {
    const html = renderToStaticMarkup(createElement(LimitFieldsEditor, { id: 'x', value: { editScope: '', runTime: '1', maxSteps: '' }, disabled: false, onChange: () => {} }));
    expect(html).toContain('Files this agent may edit');
    expect(html).toContain('Time limit');
    expect(html).toContain('Max steps');
    expect(html).toContain('between 2 and 30 minutes');
  });
});
