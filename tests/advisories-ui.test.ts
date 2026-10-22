import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { INBOX_KINDS } from '../src/shared/notifications';
import { publicRepositoryPath } from '../src/shared/handles';
import { cweList, draftErrors, draftFrom, draftPayload, httpsUrl, publishBlockers, validCve, validCvss } from '../src/ui/advisory-data';
import { AdvisoryFacts, cveUrl, cweUrl, personName, SeverityPill } from '../src/ui/advisory-ui';
import { KIND_LABELS } from '../src/ui/inbox-data';
import { isKnownAppRoute, isSiteRoute, publicRepositoryLocation, routeFromLocation } from '../src/ui/router';

const valid = () => ({ ...draftFrom(), title: 'Path traversal', description: 'Archives escape the target directory.' });

describe('advisory routes', () => {
  it('knows the member security tab and advisory pages', () => {
    expect(isKnownAppRoute('repository/r1/security')).toBe(true);
    expect(isKnownAppRoute('repository/r1/security/new')).toBe(true);
    expect(isKnownAppRoute('repository/r1/security/9b2f6c1e-1d3a-4c55-9a0e-3f1f4e1a2b3c')).toBe(true);
    expect(isKnownAppRoute('repository/r1/security/a/b')).toBe(false);
  });

  it('parses the public security view and advisory pages', () => {
    expect(publicRepositoryLocation('acme/widgets/security')).toEqual({ handle: 'acme', repository: 'widgets', view: 'security', path: '' });
    expect(publicRepositoryLocation('acme/widgets/security/new')).toEqual({ handle: 'acme', repository: 'widgets', view: 'security', path: 'new' });
    const id = 'GFSA-cfgh-jmpq-rvwx';
    const url = publicRepositoryPath('acme', 'widgets', 'security', id);
    expect(url).toBe(`/acme/widgets/security/${id}`);
    expect(publicRepositoryLocation(routeFromLocation(url, ''))).toEqual({ handle: 'acme', repository: 'widgets', view: 'security', path: id });
    expect(isSiteRoute(routeFromLocation(url, ''))).toBe(true);
    for (const route of ['acme/widgets/security/a/b', 'acme/widgets/security/..', 'acme/widgets/security/a b', `acme/widgets/security/${'a'.repeat(101)}`]) expect(publicRepositoryLocation(route), route).toBe(null);
  });

  it('labels security reports in the inbox', () => {
    expect(INBOX_KINDS).toContain('security_report');
    expect(KIND_LABELS.security_report).toBe('Security report');
  });
});

describe('advisory fields', () => {
  it('validates identifiers', () => {
    expect(validCve('CVE-2026-12345')).toBe(true);
    expect(validCve('CVE-2026-123')).toBe(false);
    expect(validCve('cve-2026-12345')).toBe(false);
    expect(validCvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(true);
    expect(validCvss('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N')).toBe(true);
    expect(validCvss('CVSS:2.0/AV:N')).toBe(false);
    expect(validCvss('AV:N/AC:L')).toBe(false);
    expect(cweList('79, cwe-22\n352')).toEqual(['CWE-79', 'CWE-22', 'CWE-352']);
    expect(httpsUrl('https://example.com/advisory')).toBe(true);
    expect(httpsUrl('http://example.com')).toBe(false);
    expect(httpsUrl('javascript:alert(1)')).toBe(false);
  });

  it('reports field errors before sending', () => {
    expect(draftErrors(valid())).toEqual({});
    expect(Object.keys(draftErrors(draftFrom()))).toEqual(['title', 'description']);
    expect(draftErrors({ ...valid(), cveId: 'CVE-1' }).cveId).toBeTruthy();
    expect(draftErrors({ ...valid(), cweIds: 'XSS' }).cweIds).toBeTruthy();
    expect(draftErrors({ ...valid(), cvssVector: 'high' }).cvssVector).toBeTruthy();
    expect(draftErrors({ ...valid(), references: ['http://insecure.example'] }).references).toBeTruthy();
    expect(draftErrors({ ...valid(), references: Array.from({ length: 11 }, (_, i) => `https://e.example/${i}`) }).references).toBeTruthy();
    expect(draftErrors({ ...valid(), affected: [{ ecosystem: 'npm', package: '', vulnerableVersions: '< 2', patchedVersions: '' }] }).affected).toBeTruthy();
    expect(draftErrors({ ...valid(), affected: [{ ecosystem: '', package: '', vulnerableVersions: '', patchedVersions: '' }] }).affected).toBeUndefined();
  });

  it('builds a clean payload', () => {
    const payload = draftPayload({ ...valid(), severity: 'high', cveId: 'cve-2026-0001', cweIds: '22', cvssVector: '  ', references: [' https://e.example/a ', ''], credits: ['Ada', ' '], affected: [{ ecosystem: ' npm ', package: 'left-pad', vulnerableVersions: '< 1.3.1', patchedVersions: '1.3.1' }, { ecosystem: '', package: '', vulnerableVersions: '', patchedVersions: '' }] });
    expect(payload).toEqual({ title: 'Path traversal', description: 'Archives escape the target directory.', severity: 'high', cvssVector: null, cveId: 'CVE-2026-0001', cweIds: ['CWE-22'], affected: [{ ecosystem: 'npm', package: 'left-pad', vulnerableVersions: '< 1.3.1', patchedVersions: '1.3.1' }], references: ['https://e.example/a'], credits: ['Ada'], releaseId: null });
  });

  it('names what publishing still needs', () => {
    expect(publishBlockers({ title: 'x', description: 'y', severity: 'low' })).toEqual([]);
    expect(publishBlockers({ title: ' ', description: '', severity: null })).toEqual(['a title', 'a description', 'a severity']);
  });
});

describe('advisory presentation', () => {
  it('links only well-formed identifiers', () => {
    expect(cweUrl('CWE-79')).toBe('https://cwe.mitre.org/data/definitions/79.html');
    expect(cweUrl('CWE-79"><x')).toBe(null);
    expect(cveUrl('CVE-2026-12345')).toBe('https://www.cve.org/CVERecord?id=CVE-2026-12345');
    expect(cveUrl('CVE-x')).toBe(null);
    expect(personName('u1', { u1: { name: 'Ada', handle: 'ada' } })).toBe('@ada');
    expect(personName(null, {})).toBe('Someone');
  });

  it('renders severity and the affected table', () => {
    expect(renderToStaticMarkup(createElement(SeverityPill, { severity: 'critical' }))).toContain('Critical');
    expect(renderToStaticMarkup(createElement(SeverityPill, { severity: null }))).toContain('Unrated');
    const html = renderToStaticMarkup(createElement(AdvisoryFacts, { advisory: { severity: 'high', cvssVector: null, cveId: 'CVE-2026-1234', cweIds: ['CWE-22'], affected: [{ ecosystem: 'npm', package: 'tarx', vulnerableVersions: '< 2.0.1', patchedVersions: '2.0.1' }], references: ['https://e.example/a'], credits: ['Ada'] } }));
    expect(html).toContain('tarx');
    expect(html).toContain('&lt; 2.0.1');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('Credits');
  });
});
