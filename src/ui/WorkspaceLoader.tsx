import { createElement, useLayoutEffect } from "react";
import { holdBootLoader } from "./boot-handoff";
import { useRouteMotion } from "./OperationMotion";
import { currentRoute, isWorkspaceRoute } from "./router";
import "./auth-loading.css";

export function useBootHold(): void {
  useLayoutEffect(() => holdBootLoader(), []);
}

export function LoadingSignal({ className }: { className: string }) {
  return createElement("gitflare-loading-signal", { className, "aria-hidden": true },
    <svg viewBox="0 0 164 128" fill="none">
      <path className="workspace-signal-grid" d="M20 28H144M20 64H144M20 100H144M48 8V120M116 8V120"/>
      <circle className="workspace-signal-halo" cx="82" cy="64" r="53"/>
      <path className="workspace-signal-wire" d="M48 40V88M116 40V44C116 68 48 56 48 80V88"/>
      <path className="workspace-signal-flow" pathLength="100" d="M48 40V88"/>
      <path className="workspace-signal-flow workspace-signal-branch" pathLength="100" d="M116 40V44C116 68 48 56 48 80V88"/>
      <circle className="workspace-signal-node" cx="48" cy="28" r="10"/>
      <circle className="workspace-signal-node" cx="116" cy="28" r="10"/>
      <circle className="workspace-signal-node workspace-signal-destination" cx="48" cy="100" r="10"/>
      <circle className="workspace-signal-core" cx="48" cy="100" r="3"/>
    </svg>,
  );
}

export function PageLoading({ label = "Loading" }: { label?: string }) {
  useBootHold();
  return (
    <div className="page-loading" role="status">
      <LoadingSignal className="workspace-loading-signal page-loading-signal" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export default function WorkspaceLoader({ workspace = isWorkspaceRoute(currentRoute()) }: { workspace?: boolean }) {
  useBootHold();
  return (
    <main className="workspace-loading-screen" aria-busy="true">
      <svg className="workspace-loading-scaffold" viewBox="0 0 880 440" fill="none" aria-hidden="true">
        <rect x=".5" y=".5" width="879" height="439" rx="12"/>
        <path d="M0 44H880M164 44V440"/>
        <path className="workspace-scaffold-line" d="M24 23H92M24 79H112M24 111H95M24 143H107M24 175H83M24 396H100M200 79H324M200 108H398M726 23H746M768 23H788M810 23H830"/>
        <rect x="200" y="142" width="303" height="106" rx="7"/>
        <rect x="519" y="142" width="325" height="106" rx="7"/>
        <rect x="200" y="264" width="644" height="137" rx="7"/>
        <path className="workspace-scaffold-line" d="M220 166H294M220 190H349M539 166H619M539 190H695M220 290H320M220 318H404M220 346H370M220 374H392M766 290H818M766 318H818M766 346H818M766 374H818"/>
      </svg>
      <div className="workspace-loading-content">
        <div className="workspace-loading-status" role="status">
          <LoadingSignal className="workspace-loading-signal" />
          <div className="workspace-loading-brand" aria-hidden="true">gitflare</div>
          {workspace ? <><h1>Loading workspace</h1><p>Gathering your repositories and workspace.</p></> : <h1 className="sr-only">Loading Gitflare</h1>}
        </div>
      </div>
    </main>
  );
}

export function RouteProgress() {
  useBootHold();
  const ref = useRouteMotion();
  return <div ref={ref} className="route-progress operation-route" role="progressbar" aria-label="Loading page" aria-busy="true"><span /></div>;
}
