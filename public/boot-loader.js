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

if (location.pathname !== "/") {
  let theme;
  try { theme = localStorage.getItem("gitflare-theme"); } catch {}
  document.documentElement.dataset.theme = theme === "light" || theme === "dark" ? theme : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const template = document.getElementById("boot-loader");
  const root = document.getElementById("root");
  if (template && root) root.append(template.content.cloneNode(true));
}
