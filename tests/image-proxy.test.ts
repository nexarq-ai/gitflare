import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { describe, expect, it, vi } from 'vitest';
import { IMAGE_PROXY_MAX_BYTES, imageProxyResponse, isPrivateAddress, markdownImages, markdownImageSources, proxiedImagePath, signImageUrl, verifyImageSignature, type HostResolver } from '../src/worker/image-proxy';
import { DeployBadgeLink, isDeployBadgeLink, MarkdownImage, markdownImageSource, type MarkdownImageContext } from '../src/ui/MarkdownImage';
import { isDeployBadgeSource, rawImagePath, rawImageType } from '../src/shared/markdown-images';
import type { RateLimitBinding } from '../src/worker/rate-limits';

const SECRET = 'a'.repeat(64);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const publicDns: HostResolver = async () => ['104.16.0.1'];

function proxyEnv(extra: Record<string, unknown> = {}) {
  return { EDITION: 'hosted' as const, AUTH_ENCRYPTION_KEY: SECRET, SITE_ORIGIN: 'https://gitflare.test', APP_ORIGIN: 'https://app.gitflare.test', ...extra };
}

async function proxy(target: string, options: { fetch?: typeof fetch; resolve?: HostResolver; env?: Record<string, unknown>; signature?: string; method?: string } = {}) {
  const path = options.signature === undefined ? await proxiedImagePath(SECRET, target) : `/-/img?url=${encodeURIComponent(target)}&sig=${options.signature}`;
  const request = new Request(`https://gitflare.test${path}`, { method: options.method ?? 'GET', headers: { 'CF-Connecting-IP': '198.51.100.9', Cookie: 'gitflare_session=secret' } });
  return (await imageProxyResponse(request, proxyEnv(options.env), undefined, { fetch: options.fetch ?? (async () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } })), resolve: options.resolve ?? publicDns, cache: null }))!;
}

describe('image proxy signatures', () => {
  it('signs each URL with the installation key and rejects anything else', async () => {
    const signature = await signImageUrl(SECRET, 'https://img.shields.io/badge/a-b-blue');
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(await verifyImageSignature(SECRET, 'https://img.shields.io/badge/a-b-blue', signature)).toBe(true);
    expect(await verifyImageSignature(SECRET, 'https://img.shields.io/badge/a-b-red', signature)).toBe(false);
    expect(await verifyImageSignature('b'.repeat(64), 'https://img.shields.io/badge/a-b-blue', signature)).toBe(false);
    expect(await verifyImageSignature(SECRET, 'https://img.shields.io/badge/a-b-blue', signature.toUpperCase())).toBe(false);
  });

  it('refuses unsigned, missing and forged signatures before fetching', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const signature of ['', 'nope', '0'.repeat(64), await signImageUrl(SECRET, 'https://example.com/other.png')]) {
      const response = await proxy('https://example.com/logo.png', { signature, fetch: fetcher });
      expect(response.status, signature).toBe(403);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('is hosted-only and needs the encryption key', async () => {
    expect((await proxy('https://example.com/logo.png', { env: { EDITION: 'self-hosted' } })).status).toBe(404);
    expect((await proxy('https://example.com/logo.png', { env: { AUTH_ENCRYPTION_KEY: undefined } })).status).toBe(404);
    expect(await imageProxyResponse(new Request('https://gitflare.test/-/other'), proxyEnv())).toBeNull();
  });
});

describe('image proxy fetching', () => {
  it('returns the image with isolating headers and no forwarded cookies', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(PNG, { headers: { 'Content-Type': 'image/png; charset=binary', 'Set-Cookie': 'tracker=1', 'Access-Control-Allow-Origin': '*' } }));
    const response = await proxy('https://img.shields.io/badge/build-passing-green.png', { fetch: fetcher });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Content-Security-Policy')).toMatch(/^default-src 'none'/);
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cache-Control')).toContain('public');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://img.shields.io/badge/build-passing-green.png');
    const headers = new Headers(init!.headers);
    expect(headers.get('Cookie')).toBeNull();
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('Accept')).toBe('image/*');
    expect(init!.redirect).toBe('manual');
  });

  it('answers HEAD without a body', async () => {
    const response = await proxy('https://example.com/logo.png', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('accepts SVG badges and refuses non-image content', async () => {
    const svg = await proxy('https://img.shields.io/badge/a-b-blue', { fetch: async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'Content-Type': 'image/svg+xml' } }) });
    expect(svg.status).toBe(200);
    expect(svg.headers.get('Content-Type')).toBe('image/svg+xml');
    for (const type of ['text/html', 'application/javascript', 'application/octet-stream', '']) {
      const response = await proxy('https://example.com/page', { fetch: async () => new Response('<script>alert(1)</script>', { headers: type ? { 'Content-Type': type } : {} }) });
      expect(response.status, type).toBe(415);
      expect(await response.text()).not.toContain('<script>');
    }
  });

  it('caps the size by header and by streamed bytes', async () => {
    const declared = await proxy('https://example.com/big.png', { fetch: async () => new Response(PNG, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(IMAGE_PROXY_MAX_BYTES + 1) } }) });
    expect(declared.status).toBe(413);
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (sent++ > 6) controller.close(); else controller.enqueue(chunk); } });
    const streamed = await proxy('https://example.com/big.png', { fetch: async () => new Response(stream, { headers: { 'Content-Type': 'image/png' } }) });
    expect(streamed.status).toBe(413);
    expect(sent).toBeLessThanOrEqual(7);
  });

  it('reports upstream failures and timeouts without leaking the body', async () => {
    expect((await proxy('https://example.com/missing.png', { fetch: async () => new Response('secret page', { status: 404 }) })).status).toBe(502);
    const timeout = await proxy('https://example.com/slow.png', { fetch: async () => { throw new DOMException('timed out', 'TimeoutError'); } });
    expect(timeout.status).toBe(504);
  });

  it('is rate limited per client on cache misses', async () => {
    const limiter: RateLimitBinding = { limit: vi.fn(async () => ({ success: false })) };
    const response = await proxy('https://example.com/logo.png', { env: { IMAGE_PROXY_RATE_LIMIT: limiter } });
    expect(response.status).toBe(429);
    expect(limiter.limit).toHaveBeenCalledWith({ key: 'ip:198.51.100.9' });
  });
});

describe('image proxy SSRF protection', () => {
  it('refuses IP literals, local names, credentials, ports, plain HTTP and its own hosts', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const resolve = vi.fn<HostResolver>(publicDns);
    for (const target of [
      'https://127.0.0.1/a.png', 'https://10.0.0.8/a.png', 'https://169.254.169.254/latest/meta-data', 'https://8.8.8.8/a.png', 'https://0x7f.1/a.png', 'https://2130706433/a.png',
      'https://[::1]/a.png', 'https://[::ffff:127.0.0.1]/a.png', 'https://[fd00::1]/a.png',
      'https://localhost/a.png', 'https://images.localhost/a.png', 'https://metadata.google.internal/a.png', 'https://printer.local/a.png', 'https://intranet/a.png',
      'https://user:pass@example.com/a.png', 'https://example.com:8443/a.png', 'http://example.com/a.png', 'file:///etc/passwd',
      'https://gitflare.test/logo.svg', 'https://app.gitflare.test/logo.svg',
    ]) {
      const response = await proxy(target, { fetch: fetcher, resolve });
      expect(response.status, target).toBeGreaterThanOrEqual(400);
      expect(response.status, target).toBeLessThan(500);
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses hosts whose DNS answers include a private address, or that do not resolve', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const answers of [['10.1.2.3'], ['104.16.0.1', '192.168.0.10'], ['fe80::1'], ['::ffff:10.0.0.1'], ['64:ff9b::a00:1']]) {
      expect((await proxy('https://rebind.example/a.png', { fetch: fetcher, resolve: async () => answers })).status, answers.join()).toBe(403);
    }
    expect((await proxy('https://nxdomain.example/a.png', { fetch: fetcher, resolve: async () => [] })).status).toBe(502);
    expect((await proxy('https://broken.example/a.png', { fetch: fetcher, resolve: async () => { throw new Error('SERVFAIL'); } })).status).toBe(502);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('checks every redirect hop and refuses redirects into private ranges', async () => {
    const hops: string[] = [];
    const redirecting = (location: string): typeof fetch => async (input) => {
      hops.push(String(input));
      return String(input).includes('start') ? new Response(null, { status: 302, headers: { Location: location } }) : new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
    };
    const resolve: HostResolver = async host => host === 'internal.example' ? ['172.20.0.5'] : ['104.16.0.1'];
    for (const location of ['https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://internal.example/a.png', 'http://cdn.example/a.png', 'https://localhost/a.png']) {
      hops.length = 0;
      const response = await proxy('https://public.example/start.png', { fetch: redirecting(location), resolve });
      expect(response.status, location).toBe(403);
      expect(hops).toEqual(['https://public.example/start.png']);
    }
    hops.length = 0;
    const followed = await proxy('https://public.example/start.png', { fetch: redirecting('/final.png'), resolve });
    expect(followed.status).toBe(200);
    expect(hops).toEqual(['https://public.example/start.png', 'https://public.example/final.png']);
    const loop = await proxy('https://public.example/start.png', { fetch: async () => new Response(null, { status: 301, headers: { Location: 'https://public.example/start.png' } }), resolve });
    expect(loop.status).toBe(502);
  });

  it('classifies private and public addresses', () => {
    for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:192.168.0.1', '2001:db8::1', 'not-an-ip']) expect(isPrivateAddress(address), address).toBe(true);
    for (const address of ['1.1.1.1', '104.16.0.1', '172.32.0.1', '8.8.8.8', '2606:4700:4700::1111', '::ffff:1.1.1.1']) expect(isPrivateAddress(address), address).toBe(false);
  });
});

describe('Markdown image rewriting', () => {
  const readme = [
    '[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/acme/app)',
    '![build](https://img.shields.io/badge/build-passing-green) ![pipes](https://img.shields.io/badge/a|b-blue)',
    '![logo][logo] ![plain](http://insecure.example/x.png) ![local](docs/shot.png) ![self](https://gitflare.test/logo.svg)',
    '',
    '[logo]: https://cdn.example/logo.png',
    '[unused]: https://cdn.example/unused.png',
  ].join('\n');

  it('collects inline and reference images only', () => {
    expect(markdownImageSources(readme)).toEqual(['https://deploy.workers.cloudflare.com/button', 'https://img.shields.io/badge/build-passing-green', 'https://img.shields.io/badge/a|b-blue', 'https://cdn.example/logo.png', 'http://insecure.example/x.png', 'docs/shot.png', 'https://gitflare.test/logo.svg']);
  });

  it('maps HTTPS images to signed proxy paths keyed as the renderer sees them', async () => {
    const images = (await markdownImages(proxyEnv(), readme))!;
    expect(Object.keys(images).sort()).toEqual(['https://cdn.example/logo.png', 'https://img.shields.io/badge/a%7Cb-blue', 'https://img.shields.io/badge/build-passing-green']);
    for (const path of Object.values(images)) {
      const url = new URL(path, 'https://gitflare.test');
      expect(url.pathname).toBe('/-/img');
      expect(await verifyImageSignature(SECRET, url.searchParams.get('url')!, url.searchParams.get('sig')!)).toBe(true);
    }
    expect(await markdownImages(proxyEnv({ EDITION: 'self-hosted' }), readme)).toBeUndefined();
    expect(await markdownImages(proxyEnv(), '# No images')).toBeUndefined();
  });

  it('renders proxied, repository and fallback images, and the native deploy button', async () => {
    const context: MarkdownImageContext = { images: await markdownImages(proxyEnv(), readme), repository: { handle: 'acme', name: 'widgets', commitSha: '2'.repeat(40), path: 'README.md' } };
    const html = renderToStaticMarkup(createElement(Markdown, {
      remarkPlugins: [remarkGfm], skipHtml: true,
      components: {
        img: ({ src, alt }) => createElement(MarkdownImage, { src: typeof src === 'string' ? src : undefined, alt, context, fallbackClassName: 'repo-image-reference' }),
        a: ({ node, href, children }) => href && isDeployBadgeLink(node) ? createElement(DeployBadgeLink, { href }) : createElement('a', { href }, children),
      },
    }, readme));
    expect(html).toContain('class="cloudflare-deploy-button" href="https://deploy.workers.cloudflare.com/?url=https://github.com/acme/app"');
    expect(html).toContain('Deploy to Cloudflare</span>');
    expect(html).not.toContain('src="https://deploy.workers.cloudflare.com/button"');
    expect(html).toMatch(/<img class="markdown-image" src="\/-\/img\?url=https%3A%2F%2Fimg\.shields\.io%2Fbadge%2Fbuild-passing-green&amp;sig=[a-f0-9]{64}" alt="build"/);
    expect(html).toMatch(/src="\/-\/img\?url=https%3A%2F%2Fimg\.shields\.io%2Fbadge%2Fa%7Cb-blue&amp;sig=/);
    expect(html).toMatch(/src="\/-\/img\?url=https%3A%2F%2Fcdn\.example%2Flogo\.png&amp;sig=/);
    expect(html).toContain(`src="/acme/widgets/-/raw/${'2'.repeat(40)}/docs/shot.png"`);
    expect(html).toContain('<span class="repo-image-reference">plain</span>');
    expect(html).toContain('<span class="repo-image-reference">self</span>');
    expect(html).not.toMatch(/src="https?:\/\//);
  });

  it('resolves relative images only to image files inside the repository at a pinned commit', () => {
    const repository = { handle: 'acme', name: 'widgets', commitSha: 'a'.repeat(40), path: 'docs/guide.md' };
    expect(markdownImageSource('img/diagram.svg', { repository })).toBe(`/acme/widgets/-/raw/${'a'.repeat(40)}/docs/img/diagram.svg`);
    expect(markdownImageSource('../logo%20dark.png?raw=1', { repository })).toBe(`/acme/widgets/-/raw/${'a'.repeat(40)}/logo%20dark.png`);
    expect(markdownImageSource('../../../../etc/passwd.png', { repository })).toBe(`/acme/widgets/-/raw/${'a'.repeat(40)}/etc/passwd.png`);
    for (const src of ['notes.txt', '//evil.example/a.png', 'javascript:alert(1)', 'https://cdn.example/a.png', '#top']) expect(markdownImageSource(src, { repository }), src).toBeNull();
    expect(markdownImageSource('img/a.png', { repository: { ...repository, commitSha: undefined } })).toBeNull();
    expect(markdownImageSource('https://cdn.example/a.png', { images: { 'https://cdn.example/a.png': 'https://evil.example/a.png' } })).toBeNull();
  });

  it('recognises the Cloudflare deploy badge and image types', () => {
    expect(isDeployBadgeSource('https://deploy.workers.cloudflare.com/button')).toBe(true);
    expect(isDeployBadgeSource('https://deploy.workers.cloudflare.com/button?paid=true')).toBe(true);
    expect(isDeployBadgeSource('http://deploy.workers.cloudflare.com/button')).toBe(false);
    expect(isDeployBadgeSource('https://deploy.workers.cloudflare.com.evil.example/button')).toBe(false);
    expect(rawImageType('a/b.SVG')).toBe('image/svg+xml');
    expect(rawImageType('a/b.html')).toBeUndefined();
    expect(rawImagePath('acme', 'my app', 'c'.repeat(40), 'a b/c#d.png')).toBe(`/acme/my%20app/-/raw/${'c'.repeat(40)}/a%20b/c%23d.png`);
  });
});
