import { describe, expect, it } from 'vitest';
import { effectiveAccount, type AccountsOverview } from '../src/ui/cloudflare-accounts-data';

const a = { id: 'a'.repeat(32), name: 'GitFlare' };
const b = { id: 'b'.repeat(32), name: 'nexarq AI' };
const c = { id: 'c'.repeat(32), name: 'NFR' };
const overview: AccountsOverview = {
  connected: true,
  defaultAccount: a,
  accounts: [{ ...a, grantId: null }, { ...b, grantId: null }, { ...c, grantId: 'g' }],
  repositories: { r1: { accountId: b.id, environments: { production: c.id } }, r2: {} },
};

describe('deploy account resolution shown on the Deploys page', () => {
  it('uses the environment account, then the repository account, then the workspace default', () => {
    expect(effectiveAccount(overview, 'r1', 'production')).toEqual({ ...c, grantId: 'g' });
    expect(effectiveAccount(overview, 'r1', 'staging')).toEqual({ ...b, grantId: null });
    expect(effectiveAccount(overview, 'r2', 'staging')).toEqual({ ...a, grantId: null });
    expect(effectiveAccount({ ...overview, defaultAccount: null }, 'r2')).toBeNull();
  });
});
