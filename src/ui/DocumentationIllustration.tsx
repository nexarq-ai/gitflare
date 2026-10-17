import { useEffect, useState } from "react";
import "./documentation-diagrams.css";

const revisionSteps = [
  {
    "label": "1 \u00b7 Base",
    "description": "Artifacts provides the immutable starting revision. The Mission records the repository base before task work begins."
  },
  {
    "label": "2 \u00b7 Isolate",
    "description": "Each task works in its own stream and Container with fork-scoped credentials. Up to three tasks run concurrently."
  },
  {
    "label": "3 \u00b7 Combine",
    "description": "Combine mode brings task revisions into one candidate. Individually passing changes can still fail when tested together."
  },
  {
    "label": "4 \u00b7 Review",
    "description": "Review the checks for the exact candidate and base. Approval and landing are separate actions; neither is implied by this illustration."
  }
];
const mcpSteps = [
  {
    "label": "1 \u00b7 Consent",
    "description": "You approve the intended workspace and access level in the browser. The client receives a user-authorized grant; it does not gain a new Owner role."
  },
  {
    "label": "2 \u00b7 Authorize",
    "description": "The client calls the Worker's /mcp endpoint over HTTPS. Each request is checked against the consented scope and the user's current workspace role."
  },
  {
    "label": "3 \u00b7 Call tools",
    "description": "Allowed tools reach the same workspace operations and state checks as the interface. Approval and landing still require authorization and exact current evidence."
  }
];

export function DocumentationIllustration({ kind }: { kind: "revision" | "mcp" }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [tracing, setTracing] = useState(false);
  useEffect(() => {
    if (selected === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setTracing(false);
    const frame = requestAnimationFrame(() => setTracing(true));
    const timer = window.setTimeout(() => setTracing(false), 1400);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [selected]);
  const steps = kind === "revision" ? revisionSteps : mcpSteps;
  const controls = <div className="docs-trace-controls" role="group" aria-label={kind === "revision" ? "Explore the combine workflow" : "Explore MCP authorization"}>{steps.map((step, index) => <button type="button" className="button" key={step.label} aria-pressed={(selected ?? 0) === index} onClick={() => setSelected(index)}>{step.label}</button>)}</div>;
  return kind === "revision" ? (<figure className={`docs-artifact docs-revision-map${tracing ? " is-tracing" : ""}`} data-doc-diagram="revision" data-step={selected ?? 0} aria-label="Combine mode: an Artifacts repository base branches into isolated task streams, then combines into one candidate for checks and exact approval">
<figcaption className="docs-artifact-heading"><span className="docs-artifact-glyph" aria-hidden="true">⑂</span><div><strong>Many streams. One reviewed revision.</strong><span>The combine-mode architecture</span></div><span className="docs-artifact-tag">Illustration</span></figcaption>
<div className="docs-revision-canvas">
<div className="docs-map-node docs-map-source" data-diagram-stage="0"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 4h11l3 3v13H5V4Zm3 0v6h8V4M8 20v-6h8v6" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg><div><small>Cloudflare Artifacts</small><strong>Pinned repository base</strong></div><span className="docs-map-marker" aria-hidden="true"></span></div>
<svg className="docs-map-branches" viewBox="0 0 600 48" preserveAspectRatio="none" aria-hidden="true"><path className="docs-artifact-wire" d="M300 0V12Q300 22 290 22H106Q100 22 100 30V48M300 0V48M300 0V12Q300 22 310 22H494Q500 22 500 30V48"/></svg>
<div className="docs-map-streams" data-diagram-stage="1">
<div className="docs-map-stream"><span className="docs-stream-symbol" aria-hidden="true">⑂</span><small>Stream A</small><strong>Task A</strong><span>Isolated Container</span><div className="docs-stream-lines" aria-hidden="true"><i></i><i></i><i></i></div></div>
<div className="docs-map-stream"><span className="docs-stream-symbol" aria-hidden="true">⑂</span><small>Stream B</small><strong>Task B</strong><span>Isolated Container</span><div className="docs-stream-lines" aria-hidden="true"><i></i><i></i><i></i></div></div>
<div className="docs-map-stream"><span className="docs-stream-symbol" aria-hidden="true">⑂</span><small>Stream C</small><strong>Task C</strong><span>Isolated Container</span><div className="docs-stream-lines" aria-hidden="true"><i></i><i></i><i></i></div></div>
</div>
<svg className="docs-map-branches docs-map-converge" viewBox="0 0 600 48" preserveAspectRatio="none" aria-hidden="true"><path className="docs-artifact-wire" d="M100 0V16Q100 24 110 24H290Q300 24 300 34V48M300 0V48M500 0V16Q500 24 490 24H310Q300 24 300 34V48"/></svg>
<div className="docs-map-node docs-map-candidate" data-diagram-stage="2"><span className="docs-candidate-symbol" aria-hidden="true">◇</span><div><small>Combined work</small><strong>One candidate revision</strong></div></div>
<div className="docs-map-stem" aria-hidden="true"><span></span></div>
<div className="docs-map-review" data-diagram-stage="3"><div><span aria-hidden="true">✓</span><strong>Candidate checks</strong></div><span className="docs-review-arrow" aria-hidden="true">→</span><div><svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5V10Zm7 4v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg><strong>Exact approval</strong></div><span className="docs-review-arrow" aria-hidden="true">→</span><div><span aria-hidden="true">⑂</span><strong>Land separately</strong></div></div>
</div>
{controls}
<p className="docs-artifact-caption" aria-live="polite">{selected === null ? 'An immutable Artifacts base branches into isolated task streams, combines into a candidate, then passes through checks, exact approval, and a separate landing action.' : steps[selected].description}</p>
<div className="docs-artifact-footer"><span><span aria-hidden="true">◌</span> Coordination: Durable Objects + Workflows</span><span>Up to 3 concurrent tasks</span></div>
</figure>) : (<figure className={`docs-artifact docs-mcp-map${tracing ? " is-tracing" : ""}`} data-doc-diagram="mcp" data-step={selected ?? 0} aria-label="MCP authorization: a person chooses a workspace and access scope, an AI client sends its token to the Worker, and shared permission checks govern every tool call">
<figcaption className="docs-artifact-heading"><span className="docs-artifact-glyph" aria-hidden="true">⌘</span><div><strong>Your client follows your authority.</strong><span>The MCP authorization boundary</span></div><span className="docs-artifact-tag">Illustration</span></figcaption>
<div className="docs-mcp-canvas">
<div className="docs-consent-node" data-diagram-stage="0"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="7" r="4" stroke="currentColor" strokeWidth="1.4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg><div><strong>You authorize the connection</strong><span>Choose a workspace and access level</span></div><span className="docs-consent-badge">OAuth + PKCE</span></div>
<div className="docs-consent-stem" aria-hidden="true"><span></span><small>Consented scope ∩ workspace role</small></div>
<div className="docs-mcp-path">
<div className="docs-mcp-node" data-diagram-stage="0"><span className="docs-mcp-node-icon" aria-hidden="true">⌘</span><strong>AI client</strong><small>User-authorized token</small></div>
<div className="docs-mcp-wire" aria-hidden="true"><span></span><small>HTTPS</small></div>
<div className="docs-mcp-node docs-mcp-worker" data-diagram-stage="1"><svg width="26" height="22" viewBox="0 0 30 24" fill="none" aria-hidden="true"><path d="m4 4 9 8-9 8M15 4l10 8-10 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg><strong>Worker /mcp</strong><small>Official Agents SDK</small></div>
<div className="docs-mcp-wire" aria-hidden="true"><span></span><small>Shared checks</small></div>
<div className="docs-mcp-node" data-diagram-stage="2"><span className="docs-mcp-node-icon" aria-hidden="true">▤</span><strong>Workspace</strong><small>Allowed tools + state</small></div>
</div>
<div className="docs-mcp-task-boundary"><span className="docs-task-boundary-icon" aria-hidden="true">⑂</span><div><strong>Runtime coding tasks have separate credentials.</strong><span>Only fork-scoped capabilities enter their sandboxes. The client's grant stays outside.</span></div><svg width="17" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5V10Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg></div>
</div>
{controls}
<p className="docs-artifact-caption" aria-live="polite">{selected === null ? 'A person consents to a workspace and access level. The AI client sends its token to the Worker, where current role, scope, and state checks govern each tool call. Runtime tasks receive separate fork-scoped credentials.' : steps[selected].description}</p>
<div className="docs-artifact-footer"><span><span aria-hidden="true">◌</span> One authorization boundary for UI + MCP</span><span>No client credentials in task sandboxes</span></div>
</figure>);
}
