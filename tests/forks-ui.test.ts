import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ForkBanner, { storageLabel } from '../src/ui/ForkBanner';
import { forkTargets } from '../src/ui/ForkDialog';
import type { Mission, Repository } from '../src/shared/types';
import { PullRequestBadge, PullRequestPanel } from '../src/ui/PullRequests';
import { upstreamStateLabel } from '../src/ui/UpstreamProposals';

describe('fork UI', () => {
  it('offers only owned workspaces, the personal one first', () => {
    expect(forkTargets([
      { id: 'team', name: 'Team', role: 'Owner' },
      { id: 'other', name: 'Other', role: 'Maintainer' },
      { id: 'personal-u1', name: 'Personal', role: 'Owner' },
    ]).map(item => item.id)).toEqual(['personal-u1', 'team']);
  });

  it('labels fork storage', () => {
    expect(storageLabel(0)).toBe('0 KB');
    expect(storageLabel(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(storageLabel(300 * 1024 * 1024)).toBe('300 MB');
    expect(storageLabel(1024 ** 3)).toBe('1.00 GiB');
  });

  it('shows an outside proposal waiting for a maintainer, with its source and a Run checks gate', () => {
    expect(upstreamStateLabel({ state: 'open', waitingForMaintainer: true })).toEqual(['Waiting for a maintainer', 'review']);
    expect(upstreamStateLabel({ state: 'landed', waitingForMaintainer: false })).toEqual(['Landed', 'integrated']);
    const mission = { id: 'm', status: 'draft', epoch: 0, checks: [], changes: [], events: [], runs: [], branchChange: { branch: 'feature', headSha: 'a'.repeat(40), targetBranch: 'main', gate: 'first-time', source: { workspaceId: 'p', repositoryId: 'f', repositoryName: 'n', label: 'dana/widgets', authorId: 'u' } } } as unknown as Mission;
    expect(renderToStaticMarkup(createElement(PullRequestBadge, { mission }))).toContain('Waiting for a maintainer');
    const maintainer = renderToStaticMarkup(createElement(PullRequestPanel, { mission, permissions: ['read', 'contribute', 'execute', 'review', 'land'], onChange: () => {} }));
    expect(maintainer).toContain('From dana/widgets');
    expect(maintainer).toContain('Run checks');
    expect(maintainer).not.toContain('Update from stream');
    const contributor = renderToStaticMarkup(createElement(PullRequestPanel, { mission, permissions: ['read', 'contribute', 'execute'], onChange: () => {} }));
    expect(contributor).toMatch(/<button[^>]*disabled=""[^>]*>.*Run checks/);
  });

  it('names the upstream in one line before the status loads', () => {
    const repository = { id: 'f', name: 'widgets', description: '', defaultBranch: 'main', headSha: null, provider: 'artifacts', createdAt: '', updatedAt: '', fork: { upstream: { workspaceId: 'w', repositoryId: 'r', label: 'acme/widgets' }, forkedAt: '', forkedAtSha: null, forkedBy: 'u' } } as Repository;
    const html = renderToStaticMarkup(createElement(ForkBanner, { repository, onNotify: () => {}, onChanged: () => {} }));
    expect(html).toContain('Forked from <strong>acme/widgets</strong>');
    expect(html).toContain('About this fork');
  });
});
