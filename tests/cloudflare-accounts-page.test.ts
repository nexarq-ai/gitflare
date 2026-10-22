import { describe, expect, it } from 'vitest';
import type { Repository } from '../src/shared/types';
import { accountRows, accountUsage, removeRefusal, type AccountsOverview } from '../src/ui/cloudflare-accounts-data';
import { placeBubble } from '../src/ui/InfoTip';

const repositories = [{ id: 'r1', name: 'billing-api' }, { id: 'r2', name: 'web' }, { id: 'r3', name: 'docs' }] as Repository[];
const overview: AccountsOverview = {
  connected: true,
  defaultAccount: { id: 'a'.repeat(32), name: 'Production' },
  accounts: [{ id: 'a'.repeat(32), name: 'Production', grantId: null }, { id: 'b'.repeat(32), name: 'Staging', grantId: null }],
  repositories: { r1: { accountId: 'b'.repeat(32) }, r2: { environments: { staging: 'b'.repeat(32), production: 'a'.repeat(32) } }, r3: { own: true } },
};

describe('Cloudflare accounts page', () => {
  it('lists which repositories and environments use an account', () => {
    expect(accountUsage('b'.repeat(32), overview, repositories).map(item => [item.repository.name, item.where])).toEqual([['billing-api', 'Repository account'], ['web', 'staging']]);
    expect(accountUsage('c'.repeat(32), overview, repositories)).toEqual([]);
  });

  it('explains a refused removal with the repositories that still deploy there', () => {
    expect(removeRefusal('b'.repeat(32), overview, repositories)).toBe('billing-api and 1 other repository deploy to this account. Choose another account for them first.');
    expect(removeRefusal('a'.repeat(32), overview, repositories)).toBe('web deploys to this account. Choose another account for it first.');
  });

  it('lists accounts every login reaches, added ones first', () => {
    const rows = accountRows([{ id: 'a'.repeat(32), name: 'GitFlare', grantId: null }], [{ grantId: null, accounts: [{ id: 'a'.repeat(32), name: 'GitFlare' }, { id: 'b'.repeat(32), name: 'nexarq AI' }] }, { grantId: 'g1', accounts: [{ id: 'c'.repeat(32), name: 'Billing' }] }], null);
    expect(rows.map(row => [row.name, row.added, row.grantId])).toEqual([['GitFlare', true, null], ['Billing', false, 'g1'], ['nexarq AI', false, null]]);
    expect(accountRows([], [], { id: 'd'.repeat(32), name: 'Only' })).toEqual([{ id: 'd'.repeat(32), name: 'Only', grantId: null, added: true }]);
  });

  it('places the info bubble below the button, above near the bottom, and inside the window', () => {
    const viewport = { width: 1000, height: 800 };
    expect(placeBubble({ top: 100, bottom: 120, left: 200, right: 220 }, { width: 320, height: 80 }, viewport)).toEqual({ top: 126, left: 192 });
    expect(placeBubble({ top: 760, bottom: 780, left: 200, right: 220 }, { width: 320, height: 80 }, viewport)).toEqual({ top: 674, left: 192 });
    expect(placeBubble({ top: 100, bottom: 120, left: 900, right: 920 }, { width: 320, height: 80 }, viewport).left).toBe(668);
  });
});
