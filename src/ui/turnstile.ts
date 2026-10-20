import { useCallback, useEffect, useRef, useState } from "react";

type TurnstileApi = {
  render(element: HTMLElement, options: Record<string, unknown>): string | undefined;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
};

declare global { interface Window { turnstile?: TurnstileApi } }

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error("The human check could not start. Reload the page and try again."));
    script.onerror = () => { loading = null; script.remove(); reject(new Error("The human check could not load. Check your connection and reload the page.")); };
    document.head.appendChild(script);
  });
  return loading;
}

export interface Turnstile { required: boolean; container: (element: HTMLDivElement | null) => void; token: string; error: string; reset: () => void }

export function useTurnstile(siteKey: string | null): Turnstile {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const widget = useRef<string | null>(null);

  useEffect(() => {
    if (!siteKey || !element) return;
    let active = true;
    loadTurnstile().then(api => {
      if (!active) return;
      widget.current = api.render(element, {
        sitekey: siteKey, theme: "auto", size: "flexible",
        callback: (value: string) => { setToken(value); setError(""); },
        "expired-callback": () => setToken(""),
        "error-callback": () => setToken(""),
      }) ?? null;
    }, (failure: Error) => { if (active) setError(failure.message); });
    return () => {
      active = false;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
      setToken("");
    };
  }, [siteKey, element]);

  const reset = useCallback(() => {
    setToken("");
    if (widget.current) window.turnstile?.reset(widget.current);
  }, []);

  return { required: !!siteKey, container: setElement, token, error, reset };
}
