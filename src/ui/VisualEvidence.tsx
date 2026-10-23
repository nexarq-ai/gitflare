import { useState } from "react";
import { ImagesIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { AgentRun, Check, VisualCapture, VisualEvidence as Evidence } from "../shared/types";
import InfoTip from "./InfoTip";
import { EmptyState } from "./components";
import "./visual-evidence.css";

export type CompareMode = "slider" | "side" | "diff";

export function captureUrl(missionId: string, captureId: string): string {
  return `/api/missions/${encodeURIComponent(missionId)}/visual/${encodeURIComponent(captureId)}`;
}

export function pairs(evidence: Pick<Evidence, "captures">): { key: string; base?: VisualCapture; candidate: VisualCapture }[] {
  const bases = evidence.captures.filter((capture) => capture.side === "base");
  return evidence.captures.filter((capture) => capture.side === "candidate").map((candidate) => ({ key: candidate.id, candidate, base: bases.find((base) => base.route === candidate.route && base.frame === candidate.frame && base.viewport === candidate.viewport && base.theme === candidate.theme) }));
}

export function captureTitle(capture: Pick<VisualCapture, "label" | "route" | "frame">): string {
  return `${capture.label}${capture.label !== capture.route ? ` ${capture.route}` : ""}${capture.frame ? ` · after ${capture.frame}` : ""}`;
}

export function changeLabel(capture: Pick<VisualCapture, "diff">): string {
  if (!capture.diff) return "No base capture";
  if (!capture.diff.against) return "New route";
  if (capture.diff.changedRatio === 0) return "Identical";
  return `${(capture.diff.changedRatio * 100).toFixed(capture.diff.changedRatio < 0.01 ? 2 : 1)}% changed`;
}

export function evidenceFor(evidence: Evidence[] | undefined, runId: string | undefined, race: boolean): Evidence[] {
  const all = evidence ?? [];
  if (!race) return all.filter((item) => !item.runId).length ? all.filter((item) => !item.runId) : all;
  return runId ? all.filter((item) => item.runId === runId) : all.filter((item) => !!item.runId);
}

function Regions({ capture }: { capture: VisualCapture }) {
  if (!capture.diff?.regions.length) return null;
  return <>{capture.diff.regions.map((region, index) => <span key={index} className="visual-region" style={{ left: `${(region.x / capture.width) * 100}%`, top: `${(region.y / capture.height) * 100}%`, width: `${(region.width / capture.width) * 100}%`, height: `${(region.height / capture.height) * 100}%` }} />)}</>;
}

export function CapturePair({ missionId, base, candidate, mode }: { missionId: string; base?: VisualCapture; candidate: VisualCapture; mode: CompareMode }) {
  const [position, setPosition] = useState(50);
  const ratio = `${candidate.width} / ${candidate.height}`;
  const image = (capture: VisualCapture, alt: string) => capture.bytes ? <img src={captureUrl(missionId, capture.id)} alt={alt} width={capture.width} height={capture.height} loading="lazy" decoding="async" /> : <div className="visual-missing">No screenshot: {capture.outline.split("\n")[0]}</div>;
  if (mode === "diff" && candidate.diff?.imageId) return <figure className="visual-frame" style={{ aspectRatio: ratio }}><img src={captureUrl(missionId, candidate.diff.imageId)} alt={`Changed pixels of ${captureTitle(candidate)}`} width={candidate.width} height={candidate.height} loading="lazy" decoding="async" /></figure>;
  if (mode === "side" || !base) return <div className={`visual-side${base ? "" : " single"}`}>{base && <figure className="visual-frame" style={{ aspectRatio: ratio }}>{image(base, `Base: ${captureTitle(base)}`)}<figcaption>Before</figcaption></figure>}<figure className="visual-frame" style={{ aspectRatio: ratio }}>{image(candidate, `Candidate: ${captureTitle(candidate)}`)}<Regions capture={candidate} /><figcaption>{base ? "After" : "Candidate"}</figcaption></figure></div>;
  return (
    <div className="visual-slider" style={{ aspectRatio: ratio }}>
      <figure className="visual-frame">{image(base, `Base: ${captureTitle(base)}`)}</figure>
      <figure className="visual-frame visual-after" style={{ clipPath: `inset(0 0 0 ${position}%)` }}>{image(candidate, `Candidate: ${captureTitle(candidate)}`)}<Regions capture={candidate} /></figure>
      <span className="visual-handle" style={{ left: `${position}%` }} aria-hidden="true" />
      <input type="range" min={0} max={100} value={position} aria-label={`Compare before and after for ${captureTitle(candidate)}`} onChange={(event) => setPosition(Number(event.target.value))} />
    </div>
  );
}

export default function VisualEvidencePanel({ missionId, evidence, runs, checks, compact = false }: { missionId: string; evidence: Evidence[]; runs: AgentRun[]; checks: Check[]; compact?: boolean }) {
  const [mode, setMode] = useState<CompareMode>("slider");
  const [theme, setTheme] = useState<"all" | "light" | "dark">("all");
  if (!evidence.length) return <div className="panel"><EmptyState icon={<ImagesIcon size={25} />} title="No screenshots yet" description="Screenshots are captured when a passing candidate changes UI files." /></div>;
  return (
    <div className="visual-evidence">
      {!compact && <div className="visual-toolbar">
        <div className="visual-modes" role="radiogroup" aria-label="Comparison">
          {(["slider", "side", "diff"] as CompareMode[]).map((value) => <button key={value} type="button" role="radio" aria-checked={mode === value} className={mode === value ? "active" : undefined} onClick={() => setMode(value)}>{value === "slider" ? "Slider" : value === "side" ? "Side by side" : "Changes"}</button>)}
        </div>
        <div className="visual-modes" role="radiogroup" aria-label="Theme">
          {(["all", "light", "dark"] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={theme === value} className={theme === value ? "active" : undefined} onClick={() => setTheme(value)}>{value === "all" ? "Both themes" : value === "light" ? "Light" : "Dark"}</button>)}
        </div>
        <InfoTip label="visual evidence">Base and candidate are captured in the same runner, same route, same viewport and theme, after the same interaction steps. Pink boxes outline the changed regions.</InfoTip>
      </div>}
      {evidence.map((item) => {
        const run = item.runId ? runs.find((entry) => entry.id === item.runId) : undefined;
        const related = checks.filter((check) => check.advisory && (item.runId ? check.runId === item.runId : !check.runId) && check.candidateSha === item.candidateSha);
        const shown = pairs(item).filter(({ candidate }) => theme === "all" || candidate.theme === theme);
        return (
          <section key={item.id} className="visual-candidate" aria-label={run ? `${run.name} screenshots` : "Candidate screenshots"}>
            <header>
              <h3>{run ? run.name : "Combined candidate"} <code>{item.candidateSha.slice(0, 7)}</code> <span>vs base <code>{item.baseSha.slice(0, 7)}</code></span></h3>
              {related.length > 0 && <ul className="visual-checks">{related.map((check) => <li key={check.id} className={check.status}>{check.name}: {check.status}</li>)}</ul>}
            </header>
            {item.mode === "outline" && <p className="visual-note"><WarningCircleIcon size={15} />No browser ran in this runner, so only page outlines were recorded. {item.warnings[0]}</p>}
            {item.mode === "browser" && item.warnings.length > 0 && <p className="visual-note"><WarningCircleIcon size={15} />{item.warnings.slice(0, 3).join(" · ")}</p>}
            <div className={`visual-grid${compact ? " compact" : ""}`}>
              {shown.map(({ key, base, candidate }) => (
                <article key={key} className="visual-capture">
                  <h4>{captureTitle(candidate)} <small>{candidate.viewport === "mobile" ? "390px" : "1280px"} · {candidate.theme} · {changeLabel(candidate)}</small></h4>
                  <CapturePair missionId={missionId} base={base} candidate={candidate} mode={compact ? "side" : mode} />
                  {(candidate.consoleErrors.length > 0 || candidate.overflow > 0) && <p className="visual-issues">{candidate.overflow > 0 ? `Overflow ${candidate.overflow}px. ` : ""}{candidate.consoleErrors.slice(0, 2).join(" · ")}</p>}
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
