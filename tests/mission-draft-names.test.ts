import { describe, expect, it } from 'vitest';
import { parseDraft } from '../src/worker/mission-draft';

const goal = 'Document the capacity demo and its limits.';
const plan = (names: string[]) => JSON.stringify({ title: 'T', acceptanceCriteria: ['A'], tasks: names.map(name => ({ name, role: 'R', task: 'Do this part of the work carefully.' })) });
const names = (input: string[]) => parseDraft(plan(input), { goal, mode: 'combine', agents: input.length }).tasks.map(task => task.name);
const assertUnique = (result: string[]) => {
  expect(new Set(result.map(name => name.toLowerCase())).size).toBe(result.length);
  for (const name of result) expect(name.length).toBeLessThanOrEqual(60);
};

describe('draft agent name deduplication (GIT-119)', () => {
  it('terminates on duplicate long names whose suffix equals the collision suffix', () => {
    const long = 'x'.repeat(56) + ' 2';
    const result = names([long, long]);
    assertUnique(result);
    expect(result[0]).toBe(long);
  });

  it('terminates on eight duplicate names at the 60-character cap', () => {
    assertUnique(names(Array(8).fill('y'.repeat(60))));
  });

  it('handles already-suffixed, case-only and repeated suffix collisions', () => {
    assertUnique(names(['Same', 'Same 2', 'same', 'SAME', 'Same 2', 'Same 3']));
    assertUnique(names(Array(8).fill('Agent')));
    expect(names(['Same', 'Same'])).toEqual(['Same', 'Same 2']);
    expect(names(['Same', 'same', 'Same 2'])).toEqual(['Same', 'same 2', 'Same 2 2']);
  });
});
