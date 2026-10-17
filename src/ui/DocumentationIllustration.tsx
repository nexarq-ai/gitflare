import { useEffect, useId, useState } from "react";
import { ArrowBendDownRightIcon, ArrowUpRightIcon, CheckIcon, CodeIcon, DiamondIcon, GitBranchIcon, LightningIcon, ShieldCheckIcon, SquaresFourIcon, XIcon } from "@phosphor-icons/react";
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


type SystemDiagram = {
  heading: string;
  subtitle: string;
  layers: { label: string; nodes: { title: string; detail: string; symbol: string; accent?: boolean }[] }[];
  note: string;
  boundary: string;
};

const systemDiagrams: Record<string, SystemDiagram> = {
  architecture: {
    heading: "One workspace. Connected by design.",
    subtitle: "The Gitflare control plane",
    layers: [
      { label: "Shared entry point", nodes: [
        { title: "Browser + AI clients", detail: "Workspace UI · SDK MCP", symbol: "⌘" },
        { title: "Worker", detail: "API + shared authorization", symbol: "»", accent: true },
        { title: "Security DO", detail: "Identity, roles + scope", symbol: "♙" },
      ] },
      { label: "Coordinated state", nodes: [
        { title: "Artifacts", detail: "Repository + task Streams", symbol: "⑂" },
        { title: "Coordinator DO", detail: "Mission state + checks", symbol: "◇", accent: true },
        { title: "Workflows", detail: "Durable task dispatch", symbol: "↳" },
      ] },
      { label: "Isolated execution", nodes: [
        { title: "Task forks", detail: "Scoped repository access", symbol: "⑂" },
        { title: "Containers", detail: "Task forks + bounded tools", symbol: "▣" },
        { title: "AI Gateway", detail: "gitflare · pinned model", symbol: "✳", accent: true },
      ] },
    ],
    note: "Worker requests pass shared access checks. The coordinator manages state; Workflows dispatch isolated Containers, which use scoped Artifacts forks and the gitflare AI Gateway.",
    boundary: "Owner and canonical credentials stay outside task sandboxes.",
  },
  trust: {
    heading: "Separate work. Separate authority.", subtitle: "Execution and landing boundaries",
    layers: [
      { label: "Authorized requests", nodes: [
        { title: "Workspace owner", detail: "Current role + resource scope", symbol: "♙" },
        { title: "AI client", detail: "User-authorized MCP grant", symbol: "⌘" },
      ] },
      { label: "Worker authorization boundary", nodes: [
        { title: "Task sandbox", detail: "Scoped forks + AI Gateway", symbol: "▣" },
        { title: "Trusted landing", detail: "Exact approval + canonical write", symbol: "◇", accent: true },
      ] },
      { label: "Separate preview origin", nodes: [
        { title: "Candidate preview", detail: "Expiring, revocable capability", symbol: "↗" },
      ] },
    ], note: "Execution and trusted landing are separate paths through the Worker. Task credentials cannot approve changes, write the canonical branch, or access deployment credentials.",
    boundary: "A task sandbox never inherits its owner's authority.",
  },
  "user-journey": {
    heading: "From intent to a reviewed change.", subtitle: "The workspace review journey",
    layers: [
      { label: "Prepare", nodes: [
        { title: "Choose a repository", detail: "Sign in + pin a base revision", symbol: "⑂" },
        { title: "Describe the work", detail: "Outcome, criteria + tasks", symbol: "≡" },
      ] },
      { label: "Execute and inspect", nodes: [
        { title: "Isolated tasks", detail: "Separate Streams + Containers", symbol: "▣" },
        { title: "Review evidence", detail: "Candidate diff + recorded checks", symbol: "✓", accent: true },
      ] },
      { label: "Authorize separately", nodes: [
        { title: "Approve revision", detail: "Exact candidate + current base", symbol: "◇", accent: true },
        { title: "Land changes", detail: "Separate authorized action", symbol: "⑂" },
      ] },
    ], note: "Read the recorded evidence before approving the exact revision. Landing is a separate action and still checks the current base, candidate and authorization.",
    boundary: "This illustrates the workflow; it is not evidence of a live successful run.",
  },
  "agent-loop": {
    heading: "Your AI client. Its own task agents.", subtitle: "Two distinct kinds of authority",
    layers: [
      { label: "User-authorized AI client", nodes: [
        { title: "Read", detail: "Pin source + inspect evidence", symbol: "≡" },
        { title: "Plan", detail: "Define outcome + scoped tasks", symbol: "◇" },
        { title: "Request actions", detail: "MCP checks current role + scope", symbol: "⌘", accent: true },
      ] },
      { label: "Authorized execution start", nodes: [
        { title: "Runtime task agents", detail: "Independent task credentials", symbol: "▣", accent: true },
      ] },
      { label: "Bounded capabilities", nodes: [
        { title: "Task forks", detail: "Scoped repository access", symbol: "⑂" },
        { title: "Tools + inference", detail: "Bounded shell + AI Gateway", symbol: "✳" },
      ] },
    ], note: "An AI client requests operations with the user's current authority. Runtime coding agents receive separate capabilities for their assigned forks and bounded tools.",
    boundary: "No owner token, approval tools or canonical credentials enter task agents.",
  },
  "execution-lifecycle": {
    heading: "Parallel work. Combined evidence.", subtitle: "The execution lifecycle",
    layers: [
      { label: "Isolate and verify", nodes: [
        { title: "Task A", detail: "Own fork + individual checks", symbol: "⑂" },
        { title: "Task B", detail: "Own fork + individual checks", symbol: "⑂" },
      ] },
      { label: "Combine", nodes: [
        { title: "Candidate revision", detail: "Merge task results + run checks", symbol: "◇", accent: true },
      ] },
      { label: "Review or retain evidence", nodes: [
        { title: "Passing candidate", detail: "Exact approval → separate land", symbol: "✓", accent: true },
        { title: "Failure or cancellation", detail: "Keep evidence; never pass", symbol: "×" },
      ] },
    ], note: "Individual success does not guarantee combined success. Only the exact passing candidate can proceed to authorized approval and a separate landing action.",
    boundary: "Failures and cancellation remain recorded outcomes.",
  },
  "deployment-flow": {
    heading: "Check the source. Guard the target.", subtitle: "Development deployment",
    layers: [
      { label: "Before deployment", nodes: [
        { title: "Source checks", detail: "Tests + typecheck", symbol: "✓" },
        { title: "Development build", detail: "Validate account + environment", symbol: "◇", accent: true },
      ] },
      { label: "Separate deployments", nodes: [
        { title: "Application Worker", detail: "Workspace API + MCP", symbol: "»", accent: true },
        { title: "Preview Worker", detail: "Isolated preview origin", symbol: "↗" },
      ] },
      { label: "Observe the result", nodes: [
        { title: "API + MCP", detail: "Verify authentication + responses", symbol: "⌘" },
        { title: "Browser", detail: "Verify actual interface behavior", symbol: "▣" },
      ] },
    ], note: "The guarded development deployment checks the dedicated nexarq AI account and target. Application and preview Workers are deployed and verified separately.",
    boundary: "Deployment checks do not prove a model-backed workflow succeeded.",
  },
  roadmap: {
    heading: "Implementation is one part of proof.", subtitle: "Read the evidence with the roadmap",
    layers: [
      { label: "Implemented source", nodes: [
        { title: "Workspaces + access", detail: "Authentication + scoped actions", symbol: "♙" },
        { title: "Execution control", detail: "UI + MCP operations", symbol: "⌘" },
      ] },
      { label: "Verify each workflow", nodes: [
        { title: "Live evidence", detail: "Model calls, checks + preview", symbol: "✓", accent: true },
        { title: "Exact landing", detail: "Approval + canonical revision", symbol: "◇", accent: true },
      ] },
      { label: "Track remaining work", nodes: [
        { title: "Platform roadmap", detail: "Builds, hosting + migrations", symbol: "↗" },
        { title: "Production readiness", detail: "Separate scope + verification", symbol: "▣" },
      ] },
    ], note: "Implemented source, observed live workflows and planned capabilities are different kinds of evidence. Consult the current guide for the status of each integration.",
    boundary: "A passing build is not a claim of end-to-end product completion.",
  },
  "access-control": {
    heading: "One request. Every boundary checked.", subtitle: "Shared authorization for UI + MCP",
    layers: [
      { label: "Resolve an active principal", nodes: [
        { title: "UI or MCP request", detail: "Session or scoped credential", symbol: "⌘", accent: true },
      ] },
      { label: "All checks must pass", nodes: [
        { title: "Role + grants", detail: "Membership + action permission", symbol: "♙" },
        { title: "Resource scope", detail: "Repository, Stream + grants", symbol: "⑂" },
        { title: "Credential limits", detail: "Expiry, revocation + budgets", symbol: "▣" },
      ] },
      { label: "Validate the operation", nodes: [
        { title: "State guards", detail: "Checks, approval + exact revision", symbol: "◇", accent: true },
        { title: "Allow or deny", detail: "Permitted state or useful error", symbol: "✓" },
      ] },
    ], note: "A role alone is insufficient. Current membership, resource scope, credential limits and operation state must permit the requested action.",
    boundary: "The same authorization and state checks govern UI and MCP actions.",
  },
  "workers-builds": {
    heading: "A reviewed revision. A planned build path.", subtitle: "Workers Builds integration plan",
    layers: [
      { label: "Gitflare review workflow", nodes: [
        { title: "Exact approval", detail: "Review the tested candidate", symbol: "✓" },
        { title: "Canonical landing", detail: "Separate trusted write", symbol: "⑂", accent: true },
      ] },
      { label: "Planned native Builds integration", nodes: [
        { title: "Artifacts repository", detail: "Cloudflare supports native Builds", symbol: "⑂" },
        { title: "Configured build", detail: "Trigger from canonical revision", symbol: "»" },
      ] },
      { label: "Planned result ingestion", nodes: [
        { title: "Commit-bound result", detail: "Tie build evidence to revision", symbol: "◇", accent: true },
      ] },
    ], note: "Cloudflare supports Artifacts repositories in Workers Builds. This diagram describes the planned Gitflare configuration and result-ingestion path, not a verified integration.",
    boundary: "Task forks cannot deploy the canonical Worker.",
  },
};

const systemGlyphs = {
  "⌘": CodeIcon, "»": LightningIcon, "♙": ShieldCheckIcon, "⑂": GitBranchIcon,
  "◇": DiamondIcon, "↳": ArrowBendDownRightIcon, "▣": SquaresFourIcon,
  "✳": LightningIcon, "↗": ArrowUpRightIcon, "≡": CodeIcon, "✓": CheckIcon, "×": XIcon,
};

function SystemNode({ node }: { node: SystemDiagram["layers"][number]["nodes"][number] }) {
  const Icon = systemGlyphs[node.symbol as keyof typeof systemGlyphs] ?? DiamondIcon;
  return <div className={`docs-system-node${node.accent ? " docs-system-node-accent" : ""}`}><Icon size={21} aria-hidden="true" /><div><strong>{node.title}</strong><small>{node.detail}</small></div></div>;
}

export function DocumentationSystemDiagram({ id, expanded = false }: { id: string; expanded?: boolean }) {
  const arrowId = useId();
  const diagram = systemDiagrams[id];
  if (!diagram) return null;
  const architecture = id === "architecture";
  return <figure className={`docs-artifact docs-system-map${architecture ? " docs-architecture-map" : ""}${expanded ? " docs-system-expanded" : ""}`} data-doc-diagram={id} aria-label={diagram.subtitle}>
    <figcaption className="docs-artifact-heading"><span className="docs-artifact-glyph" aria-hidden="true"><DiamondIcon size={21} /></span><div><strong>{diagram.heading}</strong><span>{diagram.subtitle}</span></div><span className="docs-artifact-tag">{id === "workers-builds" ? "Planned" : "Illustration"}</span></figcaption>
    {architecture ? <div className="docs-system-canvas"><div className="docs-architecture-services">
      {[{ mode: "desktop", height: 314, path: "M183 37H208M392 37H417M300 74V120M208 157H183M392 157H417M509 194V211Q509 217 503 217H306Q300 217 300 223V240M208 277H183M392 277H417" }, { mode: "compact", height: 238, path: "M183 31H208M392 31H417M300 62V88M208 119H183M392 119H417M509 150V157Q509 163 503 163H306Q300 163 300 169V176M208 207H183M392 207H417" }, { mode: "mobile", height: 386, path: "M183 53H208M392 53H417M300 106V140M208 193H183M392 193H417M509 246V257Q509 263 503 263H306Q300 263 300 269V280M208 333H183M392 333H417" }].map(wires => <svg key={wires.mode} className={`docs-architecture-wires docs-architecture-wires-${wires.mode}`} viewBox={`0 0 600 ${wires.height}`} preserveAspectRatio="none" role="img" aria-label="Clients call the Worker, which checks Security and calls the coordinator. The coordinator accesses Artifacts and dispatches Workflows. Workflows start Containers; Containers use scoped task forks and AI Gateway.">
        <defs><marker id={`${arrowId}-${wires.mode}`} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="m1 1 4 2-4 2" /></marker></defs>
        <path markerEnd={`url(#${arrowId}-${wires.mode})`} d={wires.path} />
      </svg>)}
      {diagram.layers.flatMap(layer => layer.nodes).map(node => <SystemNode key={node.title} node={node} />)}
    </div><div className="docs-architecture-preview"><ArrowUpRightIcon size={20} aria-hidden="true" /><div><strong>Preview Worker</strong><span>Candidate preview · separate origin · expiring capability</span></div><span className="docs-architecture-boundary">Separate boundary</span></div></div> :
    <div className="docs-system-canvas">{diagram.layers.map((layer, index) => <div className="docs-system-layer" key={layer.label}>
      {index > 0 && !(id === "trust" && index === 2) && <div className="docs-system-connector" aria-hidden="true"><span /><span>↓</span><span /></div>}
      <p className="docs-system-layer-label">{layer.label}</p>
      <div className="docs-system-nodes" data-columns={layer.nodes.length}>{layer.nodes.map(node => <SystemNode key={node.title} node={node} />)}</div>
    </div>)}</div>}
    <p className="docs-system-caption">{diagram.note}</p>
    <div className="docs-artifact-footer"><span><ShieldCheckIcon size={14} aria-hidden="true" />{diagram.boundary}</span></div>
  </figure>;
}
