(() => {
  try {
    const root = document.documentElement;
    const site = document.querySelector?.('meta[name="gitflare-site-origin"]')?.content;
    const app = document.querySelector?.('meta[name="gitflare-app-origin"]')?.content;
    let theme = "light";
    try {
      const stored = localStorage.getItem("gitflare-theme");
      theme = stored === "dark" || stored === "light" ? stored : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch {
      theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    const followsTheme = document.querySelector?.('meta[name="gitflare-theme"]')?.content === "system";
    if (site && app && site !== app && location.origin === site && !followsTheme) theme = "dark";
    root.dataset.theme = theme;
    root.dataset.gfTheme = theme;
    root.dataset.mode = theme;
    root.classList?.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
    document.querySelector?.('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#08090b" : "#ffffff");
  } catch {}
})();

class GitflareLoadingSignal extends HTMLElement {
  connectedCallback() {
    this.dispose?.();
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const inertia = 1;
    const torque = 2.4;
    const friction = 1.2;
    const terminalVelocity = torque / friction;
    let angle = Math.PI / 2;
    let velocity = 0;
    let previous = 0;
    let frame = 0;
    const paint = () => {
      this.style.setProperty("--workspace-signal-phase", String(angle / (2 * Math.PI)));
      this.style.setProperty("--workspace-signal-energy", String((1 + Math.sin(angle)) / 2));
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      previous = 0;
    };
    const tick = now => {
      const seconds = previous ? Math.min((now - previous) / 1000, 1 / 30) : 0;
      previous = now;
      const decay = Math.exp(-friction * seconds / inertia);
      angle = (angle + terminalVelocity * seconds + (velocity - terminalVelocity) * inertia / friction * (1 - decay)) % (2 * Math.PI);
      velocity = terminalVelocity + (velocity - terminalVelocity) * decay;
      paint();
      frame = requestAnimationFrame(tick);
    };
    const synchronize = () => {
      stop();
      if (reduced.matches) {
        angle = Math.PI / 2;
        velocity = 0;
        paint();
      } else if (!document.hidden && this.isConnected) {
        frame = requestAnimationFrame(tick);
      }
    };
    this.dispose = () => {
      stop();
      document.removeEventListener("visibilitychange", synchronize);
      reduced.removeEventListener("change", synchronize);
    };
    document.addEventListener("visibilitychange", synchronize);
    reduced.addEventListener("change", synchronize);
    paint();
    synchronize();
  }

  disconnectedCallback() {
    this.dispose?.();
    this.dispose = undefined;
  }
}

if (!customElements.get("gitflare-loading-signal")) customElements.define("gitflare-loading-signal", GitflareLoadingSignal);

{
  let theme;
  try { theme = localStorage.getItem("gitflare-theme"); } catch {}
  document.documentElement.dataset.theme = location.pathname === "/" ? "dark" : theme === "light" || theme === "dark" ? theme : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const template = document.getElementById("boot-loader");
  if (template && document.body && !document.querySelector("#root[data-ssr]")) {
    const overlay = document.createElement("div");
    overlay.id = "gitflare-boot";
    overlay.append(template.content.cloneNode(true));
    const site = document.querySelector?.('meta[name="gitflare-site-origin"]')?.content;
    const app = document.querySelector?.('meta[name="gitflare-app-origin"]')?.content;
    const siteHost = site && app && site !== app && location.origin === site;
    const workspace = !siteHost && /^\/(?:overview|missions|activity|admin|inbox|settings|mission|repository|proposals|import|account)(?:\/|$)/.test(location.pathname);
    if (!workspace) {
      const heading = overlay.querySelector("h1");
      heading.textContent = "Loading Gitflare";
      heading.className = "sr-only";
      overlay.querySelector(".workspace-loading-status p").remove();
    }
    document.body.append(overlay);
    document.documentElement.setAttribute("data-booting", "");
  }
}

window.gitflareFontsReady = new Promise(resolve => {
  let settled = false;
  let timeout;
  const finish = ready => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    document.documentElement.dataset.criticalFonts = ready ? "ready" : "fallback";
    resolve();
  };
  timeout = setTimeout(() => finish(false), 2000);
  if (!document.fonts) {
    finish(false);
    return;
  }
  Promise.all([
    document.fonts.load('400 16px "Instrument Sans"'),
    document.fonts.load('italic 400 16px "Instrument Serif"'),
  ]).then(faces => finish(faces.every(loaded => loaded.length > 0)), () => finish(false));
});
