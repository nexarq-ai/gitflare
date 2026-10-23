export const BOOT_OVERLAY_ID = "gitflare-boot";
export const SERVER_RENDERED_ID = "gitflare-ssr";
export const MAX_BOOT_MS = 6000;
const FADE_MS = 220;

let holds = 0;
let started = false;
let frame = 0;
let deadline: ReturnType<typeof setTimeout> | undefined;
let fallback: ReturnType<typeof setTimeout> | undefined;
const SETTLE_FALLBACK_MS = 120;

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function dismissBootLoader(): void {
  clearTimeout(deadline);
  clearTimeout(fallback);
  cancelAnimationFrame(frame);
  document.documentElement.removeAttribute("data-booting");
  document.getElementById(SERVER_RENDERED_ID)?.remove();
  const overlay = document.getElementById(BOOT_OVERLAY_ID);
  if (!overlay || overlay.dataset.leaving) return;
  overlay.dataset.leaving = "true";
  if (reducedMotion()) { overlay.remove(); return; }
  overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
  setTimeout(() => overlay.remove(), FADE_MS + 100);
}

function settle(): void {
  cancelAnimationFrame(frame);
  clearTimeout(fallback);
  if (!started || holds > 0) return;
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => { if (holds === 0) dismissBootLoader(); });
  });
  fallback = setTimeout(() => { if (holds === 0) dismissBootLoader(); }, SETTLE_FALLBACK_MS);
}

export function startBootHandoff(): void {
  if (started) return;
  started = true;
  deadline = setTimeout(dismissBootLoader, MAX_BOOT_MS);
  settle();
}

export function holdBootLoader(): () => void {
  holds += 1;
  cancelAnimationFrame(frame);
  clearTimeout(fallback);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    settle();
  };
}
