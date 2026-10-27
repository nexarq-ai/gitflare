import { describe, expect, it } from 'vitest';
import { checkIdentity, checkLabel, normalizeRequiredChecks, requiredCheckPassed } from '../src/shared/checks';
import { normalizeBranchRule, normalizeBranchRules } from '../src/worker/branch-protection';

const sha = 'a'.repeat(40);

describe('required check identity', () => {
  it('strips evidence notes that older checks recorded in their names', () => {
    expect(checkIdentity('Combined candidate tests (exit code only)')).toBe('Combined candidate tests');
    expect(checkIdentity('Combined candidate tests (single agent: reused the exact verified candidate checks)')).toBe('Combined candidate tests');
    expect(checkIdentity('bot: repository tests (exit code only) (tests added by the agent; the repository had none)')).toBe('bot: repository tests');
    expect(checkIdentity('Reverter: repository tests (exit code and Vitest summary) (tests of the restored revision 0123456789ab)')).toBe('Reverter: repository tests');
    expect(checkIdentity('Accessibility (axe)')).toBe('Accessibility (axe)');
    expect(checkLabel({ name: 'Combined candidate tests', detail: 'exit code only' })).toBe('Combined candidate tests (exit code only)');
  });

  it('matches a required check on the landing revision whatever its evidence note', () => {
    const recorded = [{ name: 'Combined candidate tests', detail: 'exit code only', status: 'passed', candidateSha: sha }];
    const legacy = [{ name: 'Combined candidate tests (exit code only)', status: 'passed', candidateSha: sha }];
    for (const required of ['Combined candidate tests', 'Combined candidate tests (exit code only)']) {
      expect(requiredCheckPassed(recorded, required, sha)).toBe(true);
      expect(requiredCheckPassed(legacy, required, sha)).toBe(true);
    }
    expect(requiredCheckPassed(recorded, 'Combined candidate tests', 'b'.repeat(40))).toBe(false);
    expect(requiredCheckPassed([{ ...recorded[0]!, status: 'failed' }], 'Combined candidate tests', sha)).toBe(false);
    expect(requiredCheckPassed([{ name: 'bot: repository tests', status: 'passed', candidateSha: sha }], 'Combined candidate tests', sha)).toBe(false);
  });

  it('accepts stable checks and names already saved, and refuses new per-agent names', () => {
    expect(normalizeRequiredChecks(['Combined candidate tests (exit code only)', 'Combined candidate tests', 'Lighthouse'], [])).toEqual({ names: ['Combined candidate tests', 'Lighthouse'], unknown: [] });
    expect(normalizeRequiredChecks(['bot: repository tests'], [])).toMatchObject({ unknown: ['bot: repository tests'] });
    expect(normalizeRequiredChecks(['bot: repository tests'], ['bot: repository tests (exit code only)'])).toEqual({ names: ['bot: repository tests'], unknown: [] });
  });

  it('applies the same rule to branch protection rules', () => {
    expect(normalizeBranchRule({ pattern: 'main', requiredCheckNames: ['Combined candidate tests (exit code only)'] }).requiredCheckNames).toEqual(['Combined candidate tests']);
    expect(() => normalizeBranchRules([{ pattern: 'main', requiredCheckNames: ['builder-a: repository tests'] }])).toThrow(/not a check that runs on every landing revision/);
    const saved = normalizeBranchRules([{ pattern: 'main', requiredCheckNames: ['Combined candidate tests'] }]);
    const legacy = [{ ...saved[0]!, requiredCheckNames: ['builder-a: repository tests (exit code only)'] }];
    expect(normalizeBranchRules([{ pattern: 'main', requiredCheckNames: ['builder-a: repository tests', 'Combined candidate tests'] }], legacy)[0]!.requiredCheckNames).toEqual(['builder-a: repository tests', 'Combined candidate tests']);
  });
});
