import { describe, expect, it } from 'vitest';
import { DRAFT_GOAL_MAX, draftGoalProblem, draftIsStale, fillBlank, mergeDraftAgents, modelOptionLabel, modelVerificationNote } from '../src/shared/mission-draft';
import { draftRequest } from '../src/worker/mission-draft';
import type { ModelConnection } from '../src/shared/types';

const drafted = [
  { name: 'Usage guide', role: 'Document demo usage', task: 'Write docs/usage.md describing the capacity demo.' },
  { name: 'Limits', role: 'Document limits', task: 'Describe the capacity limit in README.md.' },
];

describe('AI draft merge keeps user input (GIT-115)', () => {
  it('keeps a custom name and role when the assignment is blank and fills only blank fields', () => {
    const current = [{ id: 'a', name: 'QA Custom Name', role: 'QA Custom Role', task: '' }, { id: 'b', name: '', role: '', task: '' }];
    expect(mergeDraftAgents(current, drafted, ['a', 'b'])).toEqual([
      { id: 'a', name: 'QA Custom Name', role: 'QA Custom Role', task: drafted[0].task },
      { id: 'b', ...drafted[1] },
    ]);
  });

  it('keeps an entered assignment while filling a blank name and role', () => {
    const current = [{ id: 'a', name: ' ', role: '', task: 'My own assignment for this agent.' }];
    expect(mergeDraftAgents(current, drafted, ['a'])).toEqual([{ id: 'a', name: 'Usage guide', role: 'Document demo usage', task: 'My own assignment for this agent.' }]);
  });
});

describe('late AI draft responses (GIT-116)', () => {
  it('preserves title and criteria typed while the request was pending', () => {
    expect(fillBlank('QA title typed while draft is in flight', 'Document the capacity demo and its limit')).toBe('QA title typed while draft is in flight');
    expect(fillBlank('Typed criterion', 'Drafted criterion')).toBe('Typed criterion');
    expect(fillBlank('  ', 'Drafted title')).toBe('Drafted title');
  });

  it('applies tasks to the agents that existed at request time, even after reordering or removal', () => {
    const current = [{ id: 'new', name: '', role: '', task: '' }, { id: 'b', name: 'Edited during draft', role: '', task: '' }];
    expect(mergeDraftAgents(current, drafted, ['a', 'b'])).toEqual([
      { id: 'new', name: '', role: '', task: '' },
      { id: 'b', name: 'Edited during draft', role: drafted[1].role, task: drafted[1].task },
    ]);
  });

  it('treats a draft as stale when the repository or goal changed', () => {
    const requested = { repositoryId: 'r1', goal: 'Document the capacity demo.' };
    expect(draftIsStale(requested, { repositoryId: 'r1', goal: 'Document the capacity demo. ' })).toBe(false);
    expect(draftIsStale(requested, { repositoryId: 'r2', goal: requested.goal })).toBe(true);
    expect(draftIsStale(requested, { repositoryId: 'r1', goal: 'Something else entirely.' })).toBe(true);
  });
});

describe('drafting goal limit (GIT-118)', () => {
  it('allows 4000 characters and blocks 4001 and 8000 before sending', () => {
    expect(DRAFT_GOAL_MAX).toBe(4000);
    expect(draftGoalProblem('a'.repeat(4000))).toBeNull();
    expect(draftGoalProblem('a'.repeat(4001))).toContain('up to 4,000 characters (this one has 4,001)');
    expect(draftGoalProblem('a'.repeat(8000))).toContain('missions accept up to 8,000');
    expect(draftGoalProblem('short')).toContain('at least 10');
  });

  it('matches the API boundary exactly', () => {
    expect(draftRequest({ goal: 'a'.repeat(4000) }).goal).toHaveLength(4000);
    expect(() => draftRequest({ goal: 'a'.repeat(4001) })).toThrow('between 10 and 4000');
    expect(draftGoalProblem(`  ${'a'.repeat(4000)}  `)).toBeNull();
    expect(draftRequest({ goal: `  ${'a'.repeat(4000)}  ` }).goal).toHaveLength(4000);
  });
});

describe('model verification labels (GIT-120)', () => {
  const base: ModelConnection = { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', source: 'gateway', protocol: 'anthropic' };
  const failed: ModelConnection = { ...base, verification: { status: 'failed', checkedAt: '2026-10-14T10:00:00.000Z', detail: 'AI Gateway rejected anthropic/claude-sonnet-5 with status 403.' } };
  const verified: ModelConnection = { ...base, verification: { status: 'verified', checkedAt: '2026-10-14T10:00:00.000Z', detail: 'ok' } };

  it('gives failed, never-verified and verified models distinct labels', () => {
    const labels = [modelOptionLabel(failed), modelOptionLabel(base), modelOptionLabel(verified)];
    expect(labels).toEqual(['Claude Sonnet 5 · Verification failed', 'Claude Sonnet 5 · Not verified', 'Claude Sonnet 5 · Verified']);
    expect(labels.join()).not.toContain('Configured');
    expect(modelOptionLabel({ id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama 3.3 70B', source: 'workers-ai', protocol: 'workers-ai' })).toBe('Llama 3.3 70B · Workers AI · Not verified');
  });

  it('exposes the latest failure detail and check time', () => {
    const note = modelVerificationNote(failed);
    expect(note).toContain('The last verification failed');
    expect(note).toContain('status 403');
    expect(note).toContain(new Date(failed.verification!.checkedAt).toLocaleString());
    expect(modelVerificationNote(base)).toContain('has not been verified');
    expect(modelVerificationNote(verified)).toContain('verified');
  });
});
