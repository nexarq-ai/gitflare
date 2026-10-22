import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Release, ReleaseAsset, ReleaseAssetUsage } from '../src/shared/types';
import { assetProblem, byteLabel } from '../src/ui/advisory-data';
import ReleaseAssets, { assetUploadUrl, sha256Hex } from '../src/ui/ReleaseAssets';

const MB = 1024 * 1024;
const usage: ReleaseAssetUsage = { available: true, usedBytes: 90 * MB, limitBytes: 100 * MB, maxAssetBytes: 50 * MB, maxInlineBytes: MB, maxAssetsPerRelease: 3 };
const asset = (name: string): ReleaseAsset => ({ id: `a-${name}`, releaseId: 'r1', name, size: 10, contentType: 'application/gzip', sha256: 'ab'.repeat(32), uploadedBy: 'u1', uploadedAt: '2026-10-01T00:00:00Z', downloadUrl: `/api/repositories/p1/releases/r1/assets/a-${name}/download`, publicUrl: null });
const release = (extra: Partial<Release> = {}): Release => ({ id: 'r1', tag: 'v1.0.0', name: 'v1.0.0', notes: '', targetSha: 'a'.repeat(40), draft: false, prerelease: false, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', publishedAt: '2026-10-01T00:00:00Z', ...extra } as Release);

describe('release asset checks', () => {
  it('accepts a file that fits', () => {
    expect(assetProblem({ name: 'app.tar.gz', size: 5 * MB }, usage, [])).toBe(null);
  });

  it('refuses files before uploading', () => {
    expect(assetProblem({ name: 'big.bin', size: 60 * MB }, { ...usage, usedBytes: 0 }, [])).toContain('limit is 50.0 MB per file');
    expect(assetProblem({ name: 'app.bin', size: 20 * MB }, usage, [])).toContain('Not enough storage left');
    expect(assetProblem({ name: 'a.bin', size: 1 }, usage, [asset('a.bin')])).toContain('already attached');
    expect(assetProblem({ name: 'd.bin', size: 1 }, usage, [asset('a'), asset('b'), asset('c')])).toContain('at most 3 files');
    expect(assetProblem({ name: 'x/y.bin', size: 1 }, usage, [])).toContain('Rename');
    expect(assetProblem({ name: 'empty.txt', size: 0 }, usage, [])).toBe('The file is empty.');
    expect(assetProblem({ name: 'a.bin', size: 1 }, { ...usage, available: false }, [])).toContain('not available');
  });

  it('formats sizes and upload addresses', () => {
    expect(byteLabel(512)).toBe('512 B');
    expect(byteLabel(1536)).toBe('1.5 KB');
    expect(byteLabel(5 * MB)).toBe('5.0 MB');
    expect(byteLabel(2 * 1024 * MB)).toBe('2.00 GB');
    expect(assetUploadUrl('p1', 'r1', 'my app & co.tar.gz')).toBe('/api/repositories/p1/releases/r1/assets?name=my%20app%20%26%20co.tar.gz');
  });

  it('hashes the file for the server to verify', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc').buffer)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('release asset panel', () => {
  it('stays hidden for servers without assets', () => {
    expect(renderToStaticMarkup(createElement(ReleaseAssets, { repositoryId: 'p1', release: release(), canLand: true, onChanged: () => {} }))).toBe('');
  });

  it('lists files with download links and offers upload only to landers', () => {
    const props = { repositoryId: 'p1', release: release({ assets: [asset('app.tar.gz')] }), usage, onChanged: () => {} };
    const lander = renderToStaticMarkup(createElement(ReleaseAssets, { ...props, canLand: true }));
    expect(lander).toContain('href="/api/repositories/p1/releases/r1/assets/a-app.tar.gz/download"');
    expect(lander).toContain('download="app.tar.gz"');
    expect(lander).toContain('Upload');
    expect(lander).toContain('Delete app.tar.gz');
    const reader = renderToStaticMarkup(createElement(ReleaseAssets, { ...props, canLand: false }));
    expect(reader).not.toContain('Upload');
    expect(reader).not.toContain('Delete app.tar.gz');
  });

  it('explains when uploads are unavailable instead of failing', () => {
    const html = renderToStaticMarkup(createElement(ReleaseAssets, { repositoryId: 'p1', release: release({ assets: [] }), usage: { ...usage, available: false }, canLand: true, onChanged: () => {} }));
    expect(html).toContain('Uploads unavailable');
    expect(html).not.toContain('error-notice');
    expect(html).not.toContain('type="file"');
  });
});
