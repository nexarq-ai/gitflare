import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../public/boot-loader.js', import.meta.url), 'utf8');

function deferredFonts() {
  let resolve!: (faces: object[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<object[]>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function boot(load?: (descriptor: string) => Promise<object[]>, pathname = '/') {
  vi.useFakeTimers();
  const heading = { textContent: 'Loading workspace' };
  const description = { textContent: 'Gathering your repositories and workspace.' };
  const root = { append: vi.fn(), querySelector: (selector: string) => selector === 'h1' ? heading : description };
  const document = {
    documentElement: { dataset: {} as Record<string, string> },
    getElementById: (id: string) => id === 'root' ? root : { content: { cloneNode: () => ({}) } },
    fonts: load ? { load } : undefined,
  };
  const window = {} as { gitflareFontsReady: Promise<void> };
  runInNewContext(source, {
    HTMLElement: class {}, customElements: { get: () => true },
    localStorage: { getItem: () => 'light' }, matchMedia: () => ({ matches: false }),
    location: { pathname }, document, window, setTimeout, clearTimeout,
  });
  return { ready: window.gitflareFontsReady, dataset: document.documentElement.dataset, heading, root };
}

afterEach(() => vi.useRealTimers());

it('keeps the homepage loader until both critical fonts load, then resolves without a minimum delay', async () => {
  const sans = deferredFonts();
  const serif = deferredFonts();
  const load = vi.fn((descriptor: string) => descriptor.includes('Serif') ? serif.promise : sans.promise);
  const page = boot(load);
  const revealed = vi.fn();
  void page.ready.then(revealed);
  expect(page.root.append).toHaveBeenCalledOnce();
  expect(page.heading.textContent).toBe('Loading Gitflare');
  expect(page.dataset.theme).toBe('dark');
  sans.resolve([{}]);
  await Promise.resolve();
  expect(revealed).not.toHaveBeenCalled();
  serif.resolve([{}]);
  await page.ready;
  expect(page.dataset.criticalFonts).toBe('ready');
  expect(vi.getTimerCount()).toBe(0);
});

it('reveals a stable fallback immediately when a font fails', async () => {
  const font = deferredFonts();
  const page = boot(() => font.promise);
  font.reject(new Error('Font unavailable'));
  await page.ready;
  expect(page.dataset.criticalFonts).toBe('fallback');
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds stalled font loading and retains fallback if fonts arrive later', async () => {
  const font = deferredFonts();
  const page = boot(() => font.promise);
  await vi.advanceTimersByTimeAsync(2000);
  await page.ready;
  expect(page.dataset.criticalFonts).toBe('fallback');
  font.resolve([{}]);
  await Promise.resolve();
  await Promise.resolve();
  expect(page.dataset.criticalFonts).toBe('fallback');
});

it('does not mistake an undeclared font face for a loaded font', async () => {
  const page = boot(() => Promise.resolve([]));
  await page.ready;
  expect(page.dataset.criticalFonts).toBe('fallback');
});

it('continues without the Font Loading API and preserves the workspace theme', async () => {
  const page = boot(undefined, '/overview');
  await page.ready;
  expect(page.dataset.criticalFonts).toBe('fallback');
  expect(page.dataset.theme).toBe('light');
  expect(page.heading.textContent).toBe('Loading workspace');
});
