import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PREVIEW_SETUP_CODES, isPreviewSetupCode, previewSetupFix } from '../src/shared/preview-setup';
import { resumePreview } from '../src/shared/preview-progress';
import { PreviewFailedCard, PreviewReadyCard } from '../src/ui/PreviewPanel';
import { DependencyApprovalControl, dependencyAllowLine } from '../src/ui/DependencyChanges';
import { BaseSha } from '../src/ui/ProposalCreate';
import { describeSession, signInMethodLabel } from '../src/ui/account-data';
import type { AccountSnapshot, ManifestDependencyChanges } from '../src/shared/types';

const admin = { installationAdmin: true, owner: true };
const owner = { installationAdmin: false, owner: true };
const member = { installationAdmin: false, owner: false };

describe('preview setup fixes', () => {
  it('maps every code to one short line, a tip and a fix for the right person', () => {
    for (const code of PREVIEW_SETUP_CODES) {
      const fix = previewSetupFix(code, admin);
      expect(fix.line.length, code).toBeLessThanOrEqual(60);
      expect(fix.tip, code).toBeTruthy();
      expect(fix.action, code).toBeDefined();
    }
    expect(previewSetupFix('PREVIEW_NOT_CONFIGURED', admin).action).toEqual({ label: 'Open installation admin', href: '/admin' });
    expect(previewSetupFix('PREVIEW_NOT_CONFIGURED', owner)).toMatchObject({ ask: 'Ask an installation admin' });
    expect(previewSetupFix('PREVIEW_NOT_CONFIGURED', owner).action).toBeUndefined();
    expect(previewSetupFix('PREVIEWS_PERMISSION_MISSING', owner).action).toEqual({ label: 'Grant Previews', href: '/settings/cloudflare?grant=previews' });
    expect(previewSetupFix('PREVIEWS_ACCESS_PERMISSION_MISSING', owner).action).toEqual({ label: 'Grant Access', href: '/settings/cloudflare?grant=access' });
    expect(previewSetupFix('PREVIEWS_NOT_CONNECTED', member)).toMatchObject({ ask: 'Ask a workspace Owner' });
    expect(isPreviewSetupCode('PREVIEW_ORIGIN_INVALID')).toBe(true);
    expect(isPreviewSetupCode('CHECKS_REQUIRED')).toBe(false);
  });

  it('carries the setup code from a failed preview status', () => {
    expect(resumePreview({ status: 'failed', error: 'x', setup: 'PREVIEWS_PERMISSION_MISSING' })).toEqual({ kind: 'failed', error: 'x', setup: 'PREVIEWS_PERMISSION_MISSING' });
    expect(resumePreview({ status: 'failed', error: 'x', setup: 'SOMETHING_ELSE' })).toEqual({ kind: 'failed', error: 'x' });
  });

  it('replaces the failure sentence with a line and a one-click fix', () => {
    const message = 'Configure the isolated preview service before creating a preview.';
    const html = renderToStaticMarkup(createElement(PreviewFailedCard, { message, setup: 'PREVIEW_NOT_CONFIGURED', viewer: admin, canRetry: true, busy: '', onRetry: () => {} }));
    expect(html).toContain('Previews aren’t set up on this installation.');
    expect(html).toContain('href="/admin"');
    expect(html).toContain('Open installation admin');
    const asked = renderToStaticMarkup(createElement(PreviewFailedCard, { message, setup: 'PREVIEW_NOT_CONFIGURED', viewer: member, canRetry: true, busy: '', onRetry: () => {} }));
    expect(asked).toContain('Ask an installation admin');
    expect(asked).not.toContain('href="/admin"');
    const grant = renderToStaticMarkup(createElement(PreviewReadyCard, { preview: { previewUrl: 'https://p.example.test/open/x', candidateSha: 'a'.repeat(40), expiresAt: new Date(Date.now() + 60_000).toISOString(), extended: false, access: 'members', setup: 'PREVIEWS_PERMISSION_MISSING' }, viewer: owner, busy: '', canExtend: false, canStop: false, onExtend: () => {}, onStop: () => {} }));
    expect(grant).toContain('href="/settings/cloudflare?grant=previews"');
    expect(grant).toContain('Grant Previews');
  });
});

describe('dependency approval', () => {
  const manifests: ManifestDependencyChanges[] = [{ path: 'package.json', changes: [
    { section: 'dependencies', name: 'zod', change: 'added', to: '4.0.0' },
    { section: 'dependencies', name: 'react', change: 'changed', from: '18.0.0', to: '19.0.0' },
    { section: 'devDependencies', name: 'left-pad', change: 'removed', from: '1.0.0' },
    { section: 'devDependencies', name: 'vitest', change: 'added', to: '5.0.0' },
    { section: 'devDependencies', name: 'tsx', change: 'added', to: '4.0.0' },
  ] }];

  it('says which packages in one line', () => {
    expect(dependencyAllowLine(manifests)).toBe('Allow new packages: zod, react, vitest +1 more');
    expect(dependencyAllowLine([{ path: 'package.json', changes: [{ section: 'dependencies', name: 'left-pad', change: 'removed', from: '1.0.0' }] }])).toBe('Allow package removals: left-pad');
  });

  it('renders a checkbox with the line and an info tip', () => {
    const html = renderToStaticMarkup(createElement(DependencyApprovalControl, { isOwner: true, checked: false, onChange: () => {}, manifests }));
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('Allow new packages: zod, react, vitest +1 more');
    expect(html).not.toContain('I approve these dependency changes');
    expect(html).toContain('info-tip');
  });
});

describe('git base', () => {
  it('shows seven characters with the full hash in the title and a copy button', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const html = renderToStaticMarkup(createElement(BaseSha, { sha }));
    expect(html).toContain(`<code title="${sha}">0123456</code>`);
    expect(html).toContain('aria-label="Copy full commit"');
  });
});

describe('session rows', () => {
  type Session = AccountSnapshot['sessions'][number];
  const now = Date.parse('2026-10-19T12:00:00Z');
  const session = (patch: Partial<Session>): Session => ({ id: 'w.s', userId: 'u', workspaceId: 'w', expiresAt: now + 3_600_000, kind: 'browser', ...patch } as Session);

  it('shows the sign-in method and last activity', () => {
    expect(describeSession(session({ method: 'cloudflare', lastActiveAt: now - 10 * 60_000, authenticatedAt: now - 86_400_000 }), now)).toMatchObject({ method: 'Cloudflare', lastActive: 'Active 10 min ago' });
    expect(describeSession(session({ authenticatedAt: now - 2 * 3_600_000 }), now, 'cloudflare')).toMatchObject({ method: 'Cloudflare', lastActive: 'Active 2 h ago' });
    expect(describeSession(session({}), now).method).toBeUndefined();
    expect(signInMethodLabel('password')).toBe('Email');
    expect(signInMethodLabel('authenticator')).toBe('Email + authenticator');
  });
});
