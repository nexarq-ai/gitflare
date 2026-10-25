import { useEffect, useRef, useState } from "react";
import InfoTip from "./InfoTip";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import type { RepositoryVisualSettings, VisualRoute, VisualSettings as StoredVisualSettings, VisualTheme, VisualViewport } from "../shared/types";
import { request } from "./api";
import { ErrorNotice } from "./components";
import "./check-settings.css";

type Snapshot = RepositoryVisualSettings & { policyProblem?: string };

export function routesText(routes: VisualRoute[] | undefined): string {
  return (routes ?? []).map((route) => `${route.path}${route.label ? `  ${route.label}` : ""}`).join("\n");
}

export function parseRoutesText(text: string, previous: VisualRoute[] | undefined): VisualRoute[] | null {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  return lines.map((line) => {
    const [path, ...rest] = line.split(/\s+/);
    const label = rest.join(" ").trim();
    const steps = previous?.find((route) => route.path === path)?.steps;
    return { path: path!, ...(label ? { label } : {}), ...(steps ? { steps } : {}) };
  });
}

export function stepsText(routes: VisualRoute[] | undefined): string {
  const scripted = (routes ?? []).filter((route) => route.steps?.length);
  return scripted.length ? JSON.stringify(Object.fromEntries(scripted.map((route) => [route.path, route.steps])), null, 2) : "";
}

export function applyStepsText(routes: VisualRoute[], text: string): VisualRoute[] | string {
  if (!text.trim()) return routes.map(({ steps: _steps, ...route }) => route);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return "Interaction scripts must be JSON: an object of route path to a list of steps."; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "Interaction scripts must be an object of route path to a list of steps.";
  const scripts = parsed as Record<string, unknown>;
  const unknown = Object.keys(scripts).find((path) => !routes.some((route) => route.path === path));
  if (unknown) return `${unknown} is not one of the routes above.`;
  return routes.map(({ steps: _steps, ...route }) => Array.isArray(scripts[route.path]) && (scripts[route.path] as unknown[]).length ? { ...route, steps: scripts[route.path] as VisualRoute["steps"] } : route);
}

const number = (value: string) => value.trim() ? Number(value) : undefined;

export default function VisualSettings({ repositoryId, canChange, onNotify }: { repositoryId: string; canChange: boolean; onNotify: (message: string) => void }) {
  const path = `/api/repositories/${encodeURIComponent(repositoryId)}/visual-settings`;
  const [settings, setSettings] = useState<Snapshot | null>(null);
  const [routes, setRoutes] = useState("");
  const [steps, setSteps] = useState("");
  const [viewports, setViewports] = useState<VisualViewport[]>(["desktop", "mobile"]);
  const [themes, setThemes] = useState<VisualTheme[]>(["light", "dark"]);
  const [consoleErrors, setConsoleErrors] = useState(true);
  const [overflow, setOverflow] = useState(true);
  const [regression, setRegression] = useState("");
  const [axe, setAxe] = useState<"off" | "serious" | "all">("off");
  const [lighthouse, setLighthouse] = useState({ performance: "", accessibility: "", bestPractices: "", seo: "" });
  const [rounds, setRounds] = useState("0");
  const [passScore, setPassScore] = useState("8");
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mutation = useRef<{ signature: string; key: string } | null>(null);

  function show(current: Snapshot) {
    setSettings(current);
    setRoutes(routesText(current.routes));
    setSteps(stepsText(current.routes));
    setViewports(current.viewports ?? ["desktop", "mobile"]);
    setThemes(current.themes ?? ["light", "dark"]);
    setConsoleErrors(current.checks?.consoleErrors ?? true);
    setOverflow(current.checks?.overflow ?? true);
    setRegression(typeof current.checks?.regression === "number" ? String(current.checks.regression) : "");
    setAxe(current.checks?.axe === "serious" ? "serious" : current.checks?.axe ? "all" : "off");
    const thresholds = current.checks?.lighthouse || {};
    setLighthouse({ performance: thresholds.performance?.toString() ?? "", accessibility: thresholds.accessibility?.toString() ?? "", bestPractices: thresholds.bestPractices?.toString() ?? "", seo: thresholds.seo?.toString() ?? "" });
    setRounds(String(current.quality?.rounds ?? 0));
    setPassScore(String(current.quality?.passScore ?? 8));
  }

  useEffect(() => {
    let active = true;
    setLoadError("");
    request<Snapshot>(path)
      .then((current) => { if (active) show(current); })
      .catch((failure) => { if (active) setLoadError(failure instanceof Error ? failure.message : "Visual settings could not be loaded."); });
    return () => { active = false; };
  }, [path, attempt]);

  function body(): StoredVisualSettings | string {
    const parsedRoutes = parseRoutesText(routes, settings?.routes);
    const withSteps = parsedRoutes ? applyStepsText(parsedRoutes, steps) : null;
    if (typeof withSteps === "string") return withSteps;
    const thresholds = Object.fromEntries(Object.entries(lighthouse).filter(([, value]) => value.trim()).map(([key, value]) => [key, Number(value)]));
    return {
      ...(withSteps ? { routes: withSteps } : {}),
      viewports,
      themes,
      checks: { consoleErrors, overflow, regression: regression.trim() ? Number(regression) : false, axe: axe === "off" ? false : axe === "serious" ? "serious" : true, lighthouse: Object.keys(thresholds).length ? thresholds : false },
      quality: { rounds: number(rounds) ?? 0, passScore: number(passScore) ?? 8 },
    };
  }

  async function save() {
    if (busy || !settings) return;
    const input = body();
    if (typeof input === "string") { setError(input); return; }
    const signature = JSON.stringify(input);
    if (mutation.current?.signature !== signature) mutation.current = { signature, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const saved = await request<Snapshot>(path, input, mutation.current.key);
      mutation.current = null;
      show(saved);
      onNotify("Visual settings saved. New attempts use them.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Visual settings could not be saved.");
    } finally { setBusy(false); }
  }

  if (loadError) return <ErrorNotice message={loadError} onRetry={() => setAttempt((value) => value + 1)} />;
  if (!settings) return null;
  const toggle = <T extends string>(list: T[], value: T, on: boolean, set: (next: T[]) => void) => set(on ? [...new Set([...list, value])] : list.filter((item) => item !== value));
  const ratioInvalid = regression.trim() !== "" && !(Number(regression) >= 0 && Number(regression) <= 1);
  const scoreInvalid = Object.values(lighthouse).some((value) => value.trim() && !(Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 100));
  const roundsInvalid = !(Number.isInteger(Number(rounds)) && Number(rounds) >= 0 && Number(rounds) <= settings.limits.maxRounds);
  const passInvalid = !(Number.isInteger(Number(passScore)) && Number(passScore) >= 1 && Number(passScore) <= 10);
  const invalid = ratioInvalid || scoreInvalid || roundsInvalid || passInvalid || !viewports.length || !themes.length;
  const fromFile = settings.effective.source === "gitflare.json";
  return (
    <section className="panel check-settings visual-settings">
      <div className="panel-header"><h2>Visual</h2></div>
      <div className="panel-body">
        <p className="branch-rule-note">Screenshots of these routes are captured for base and candidate when a candidate changes UI files.<InfoTip label="visual checks">Gitflare runs the repository preview in the candidate's sandbox, captures each route at 1280px and 390px in light and dark, and shows before and after on the mission page. "visual" in gitflare.json at the base revision wins over these settings. Routes are capped at {settings.limits.maxRoutes}.</InfoTip></p>
        {fromFile && <p className="branch-rule-note">gitflare.json sets visual settings for this repository; they take precedence.</p>}
        {settings.policyProblem && <p className="branch-rule-note">{settings.policyProblem}</p>}
        {!canChange && <p className="branch-rule-note">Only Owners and Maintainers can change visual settings.</p>}
        <fieldset className="check-settings-fields" disabled={!canChange || busy}>
          <div className="form-field"><span className="field-label"><label htmlFor="visual-routes">Routes</label><InfoTip label="Routes">One per line: the path, then an optional label, for example "/play Fight". Up to {settings.limits.maxRoutes}.</InfoTip></span><textarea id="visual-routes" rows={4} value={routes} placeholder="/" onChange={(event) => setRoutes(event.target.value)} /></div>
          <div className="form-field"><span className="field-label"><label htmlFor="visual-steps">Interaction scripts</label><InfoTip label="Interaction scripts">JSON of route path to steps, run before capturing so games and apps are exercised past the first screen. Steps: {"{"}"click": "#start"{"}"}, {"{"}"press": "ArrowRight", "hold": 300{"}"}, {"{"}"type": "hello"{"}"}, {"{"}"wait": 500{"}"}, {"{"}"scroll": 600{"}"}, {"{"}"capture": "punch"{"}"} records an extra frame. Up to {settings.limits.maxSteps} steps per route.</InfoTip></span><textarea id="visual-steps" rows={4} value={steps} placeholder={'{ "/play": [{ "click": "#start" }, { "press": "KeyX" }, { "capture": "punch" }] }'} spellCheck={false} onChange={(event) => setSteps(event.target.value)} /></div>
          <div className="form-field"><span className="field-label">Viewports<InfoTip label="Viewports">Desktop is 1280×800; mobile is 390×844 with touch.</InfoTip></span>{(["desktop", "mobile"] as VisualViewport[]).map((value) => <label key={value} className="check-settings-toggle"><input type="checkbox" checked={viewports.includes(value)} onChange={(event) => toggle(viewports, value, event.target.checked, setViewports)} />{value === "desktop" ? "Desktop (1280px)" : "Mobile (390px)"}</label>)}</div>
          <div className="form-field"><span className="field-label">Themes<InfoTip label="Themes">Captured with prefers-color-scheme set to each theme.</InfoTip></span>{(["light", "dark"] as VisualTheme[]).map((value) => <label key={value} className="check-settings-toggle"><input type="checkbox" checked={themes.includes(value)} onChange={(event) => toggle(themes, value, event.target.checked, setThemes)} />{value === "light" ? "Light" : "Dark"}</label>)}</div>
        </fieldset>
        <fieldset className="check-settings-fields" disabled={!canChange || busy}>
          <legend>Checks</legend>
          <p className="branch-rule-note">Advisory unless a stream rule requires them by name.<InfoTip label="advisory checks">Visual checks appear with the other checks and show their evidence. They block landing only when a rule under Streams lists the check name.</InfoTip></p>
          <label className="check-settings-toggle"><input type="checkbox" checked={consoleErrors} onChange={(event) => setConsoleErrors(event.target.checked)} />Visual: console errors<InfoTip label="Console errors">Fails when a captured route logs an uncaught exception, console.error or a failed resource.</InfoTip></label>
          <label className="check-settings-toggle"><input type="checkbox" checked={overflow} onChange={(event) => setOverflow(event.target.checked)} />Visual: no overflow at 390px<InfoTip label="Overflow">Fails when the page is wider than the phone viewport.</InfoTip></label>
          <div className="form-field"><span className="field-label"><label htmlFor="visual-regression">Visual: regression threshold</label><InfoTip label="Regression threshold">Fails when more than this share of pixels changed against the base, for example 0.02 for 2%. Empty turns it off.</InfoTip></span><Input id="visual-regression" inputMode="decimal" value={regression} placeholder="Off" aria-invalid={ratioInvalid} onChange={(event) => setRegression(event.target.value.replace(/[^0-9.]/g, ""))} /></div>
          <div className="form-field"><span className="field-label"><label htmlFor="visual-axe">Accessibility (axe)</label><InfoTip label="axe">Runs axe-core from the repository's node_modules on each route. Add axe-core as a devDependency to enable it.</InfoTip></span><select id="visual-axe" value={axe} onChange={(event) => setAxe(event.target.value as "off" | "serious" | "all")}><option value="off">Off</option><option value="serious">Serious and critical violations</option><option value="all">Any violation</option></select></div>
          <div className="form-field"><span className="field-label">Lighthouse minimum scores<InfoTip label="Lighthouse">Runs lighthouse from the repository's node_modules on the desktop capture of each route. Empty categories are not checked.</InfoTip></span><div className="visual-scores">{(["performance", "accessibility", "bestPractices", "seo"] as const).map((key) => <label key={key}><span>{{ performance: "Performance", accessibility: "Accessibility", bestPractices: "Best practices", seo: "SEO" }[key]}</span><Input inputMode="numeric" value={lighthouse[key]} placeholder="Off" aria-invalid={!!lighthouse[key].trim() && scoreInvalid} onChange={(event) => setLighthouse({ ...lighthouse, [key]: event.target.value.replace(/[^0-9]/g, "") })} /></label>)}</div></div>
        </fieldset>
        <fieldset className="check-settings-fields" disabled={!canChange || busy}>
          <legend>Quality rounds</legend>
          <p className="branch-rule-note">A critic scores each agent's screens and sends fixes back before the candidate is verified.<InfoTip label="quality rounds">After an agent's first result, Gitflare captures the routes in its sandbox, a vision model scores them out of 10 against the design guide and the mission's quality bar, and the agent iterates on the critique. Rounds run inside the agent's time budget and use the mission's model.</InfoTip></p>
          <div className="form-field"><span className="field-label"><label htmlFor="visual-rounds">Rounds</label></span><Input id="visual-rounds" inputMode="numeric" value={rounds} aria-invalid={roundsInvalid} onChange={(event) => setRounds(event.target.value.replace(/[^0-9]/g, ""))} /><small>0 to {settings.limits.maxRounds}. 0 runs no critic.</small></div>
          <div className="form-field"><span className="field-label"><label htmlFor="visual-pass">Pass score</label></span><Input id="visual-pass" inputMode="numeric" value={passScore} aria-invalid={passInvalid} onChange={(event) => setPassScore(event.target.value.replace(/[^0-9]/g, ""))} /><small>1 to 10. A score at or above it ends the rounds early.</small></div>
        </fieldset>
        {error && <div className="error-notice" role="alert">{error}</div>}
        {canChange && <div className="branch-rule-actions">{settings.updatedAt && <small>Last saved {new Date(settings.updatedAt).toLocaleString()}{settings.updatedBy ? ` by ${settings.updatedBy}` : ""}</small>}<Button variant="primary" size="base" loading={busy} disabled={busy || invalid} onClick={() => void save()}>Save visual settings</Button></div>}
      </div>
    </section>
  );
}
