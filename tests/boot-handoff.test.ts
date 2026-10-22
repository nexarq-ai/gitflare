import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let overlay: { dataset: Record<string, string>; remove: ReturnType<typeof vi.fn>; addEventListener: ReturnType<typeof vi.fn> } | null;
let attributes: Set<string>;
let reduced = false;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  attributes = new Set(['data-booting']);
  overlay = { dataset: {}, remove: vi.fn(() => { overlay = null; }), addEventListener: vi.fn() };
  vi.stubGlobal('document', {
    documentElement: { removeAttribute: (name: string) => attributes.delete(name) },
    getElementById: () => overlay,
  });
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  reduced = false;
});

it('keeps the boot loader while a route is still loading and fades it once the route is ready', async () => {
  const handoff = await import('../src/ui/boot-handoff');
  const release = handoff.holdBootLoader();
  handoff.startBootHandoff();
  await vi.advanceTimersByTimeAsync(500);
  expect(overlay?.dataset.leaving).toBeUndefined();
  const element = overlay!;
  release();
  await vi.advanceTimersByTimeAsync(40);
  expect(element.dataset.leaving).toBe('true');
  expect(attributes.has('data-booting')).toBe(false);
  await vi.advanceTimersByTimeAsync(400);
  expect(element.remove).toHaveBeenCalled();
});

it('waits for a loader that replaces the previous one in the same commit', async () => {
  const handoff = await import('../src/ui/boot-handoff');
  const element = overlay!;
  const first = handoff.holdBootLoader();
  handoff.startBootHandoff();
  first();
  const second = handoff.holdBootLoader();
  await vi.advanceTimersByTimeAsync(100);
  expect(element.dataset.leaving).toBeUndefined();
  second();
  await vi.advanceTimersByTimeAsync(40);
  expect(element.dataset.leaving).toBe('true');
});

it('dismisses after the maximum wait even when a route never becomes ready', async () => {
  const handoff = await import('../src/ui/boot-handoff');
  handoff.holdBootLoader();
  handoff.startBootHandoff();
  const element = overlay!;
  await vi.advanceTimersByTimeAsync(handoff.MAX_BOOT_MS);
  expect(element.dataset.leaving).toBe('true');
});

it('removes the loader without a fade when reduced motion is requested', async () => {
  reduced = true;
  const handoff = await import('../src/ui/boot-handoff');
  const element = overlay!;
  handoff.startBootHandoff();
  await vi.advanceTimersByTimeAsync(40);
  expect(element.remove).toHaveBeenCalledOnce();
  expect(element.addEventListener).not.toHaveBeenCalled();
});
