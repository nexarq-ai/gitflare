import { forwardRef, useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { ArrowSquareOutIcon, CheckCircleIcon, RocketLaunchIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { request } from "./api";
import { OperationTrack } from "./OperationMotion";
import { currentStep, deploySnapshot, deployStages, dismissDeployment, dismissedDeployments, environmentLabel, formatElapsed, isActive, liveUrl, progressItems, publishDeployments, shortSha, subscribeDeployments, watchedDeployments, type DeploymentSummary, type ProgressItem } from "./deploy-progress";
import "./deploy-progress.css";

const ACTIVE_POLL_MS = 5000;
const IDLE_REFRESH_MS = 30000;
const PHASE_LABELS = { active: "Deploying", succeeded: "Live", failed: "Failed" } as const;

function useNow(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

export function useDeployProgress(repositoryId: string): ProgressItem[] {
  const [, setVersion] = useState(0);
  useEffect(() => subscribeDeployments(() => setVersion((value) => value + 1)), []);
  return progressItems(deploySnapshot(repositoryId)?.deployments ?? [], watchedDeployments(repositoryId), dismissedDeployments());
}

export function Sha({ sha }: { sha: string | null | undefined }) {
  return sha ? <code title={sha}>{shortSha(sha)}</code> : <>—</>;
}

export function DeployProgressCard({ item, now, onDismiss }: { item: ProgressItem; now: number; onDismiss?: () => void }) {
  const { deployment, phase } = item;
  const { stages, stage } = deployStages(deployment);
  const url = liveUrl(deployment);
  return <article className="deploy-progress-card" data-phase={phase} aria-label={`${environmentLabel(deployment.environment)} deployment`}>
    <header className="deploy-progress-heading">
      <div>
        <strong>{phase === "active" ? `Deploying to ${environmentLabel(deployment.environment)}` : phase === "succeeded" ? `${environmentLabel(deployment.environment)} is live` : `${environmentLabel(deployment.environment)} deploy failed`}</strong>
        <span><Sha sha={deployment.commitSha} /> · {currentStep(deployment)}{phase === "active" ? ` · ${formatElapsed(now - Date.parse(deployment.createdAt))}` : ""}</span>
      </div>
      {phase !== "active" && onDismiss && <Button variant="ghost" size="sm" shape="square" icon={XIcon} aria-label="Dismiss" onClick={onDismiss} />}
    </header>
    <OperationTrack kind="deploy" active={phase === "active"} step={stage ?? 0} steps={stages.length} failed={phase === "failed"} />
    <ol className="operation-deployment-steps" aria-label="Deployment stages">{stages.map((label, index) => <li key={label} aria-current={index === stage ? "step" : undefined}>{label}</li>)}</ol>
    {phase === "succeeded" && url && <p className="deploy-progress-outcome"><a href={url} target="_blank" rel="noreferrer">Open {url.replace(/^https:\/\//, "")}<ArrowSquareOutIcon size={13} aria-hidden="true" /></a></p>}
    {phase === "failed" && deployment.error && <p className="deploy-progress-outcome deploy-progress-error" role="alert">{deployment.error}</p>}
  </article>;
}

export const DeployProgressPanel = forwardRef<HTMLDivElement, { items: ProgressItem[]; starting?: string }>(function DeployProgressPanel({ items, starting }, ref) {
  const now = useNow(items.some((item) => item.phase === "active"));
  if (!items.length && !starting) return null;
  return <div ref={ref} className="deploy-progress-panel" aria-live="polite">
    {!items.length && starting && <DeployProgressCard now={now} item={{ phase: "active", deployment: { id: "starting", workerName: "", environment: starting, commitSha: null, trigger: "manual", status: "queued", createdAt: new Date(now).toISOString() } }} />}
    {items.map((item) => <DeployProgressCard key={item.deployment.id} item={item} now={now} onDismiss={() => dismissDeployment(item.deployment.id)} />)}
  </div>;
});

export function DeployPillView({ item, others = 0, now, href, onOpen, onDismiss }: { item: ProgressItem; others?: number; now: number; href: string; onOpen?: () => void; onDismiss?: () => void }) {
  const { deployment, phase } = item;
  const url = liveUrl(deployment);
  const { stages, stage } = deployStages(deployment);
  const Icon = phase === "active" ? RocketLaunchIcon : phase === "succeeded" ? CheckCircleIcon : WarningCircleIcon;
  const detail = phase === "active" ? `${currentStep(deployment)} · ${formatElapsed(now - Date.parse(deployment.createdAt))}` : phase === "failed" ? deployment.error ?? "The deployment failed." : null;
  return <div className="deploy-pill" data-phase={phase} role="status" aria-live="polite">
    <Icon size={18} weight={phase === "active" ? "regular" : "fill"} aria-hidden="true" className="deploy-pill-icon" />
    <div className="deploy-pill-body">
      <a href={href} onClick={(event) => { if (!onOpen || event.metaKey || event.ctrlKey) return; event.preventDefault(); onOpen(); }}>
        <strong>{environmentLabel(deployment.environment)} · {PHASE_LABELS[phase]}</strong>
        {deployment.commitSha && <code title={deployment.commitSha}>{shortSha(deployment.commitSha)}</code>}
        {others > 0 && <span className="deploy-pill-more">+{others} more</span>}
      </a>
      {detail && <span className="deploy-pill-detail" title={phase === "failed" ? detail : undefined}>{detail}</span>}
      {phase === "succeeded" && url && <a className="deploy-pill-detail" href={url} target="_blank" rel="noreferrer">Open {url.replace(/^https:\/\//, "")}<ArrowSquareOutIcon size={12} aria-hidden="true" /></a>}
      {phase === "active" && <span className="deploy-pill-bar" aria-hidden="true"><span style={{ width: `${Math.round((((stage ?? 0) + .5) / stages.length) * 100)}%` }} /></span>}
    </div>
    {phase !== "active" && onDismiss && <button type="button" className="deploy-pill-dismiss" aria-label="Dismiss deploy status" onClick={onDismiss}><XIcon size={14} /></button>}
  </div>;
}

export default function DeployStatusPill({ repositoryId, location, href, onOpen }: { repositoryId: string; location: string; href: string; onOpen: () => void }) {
  const items = useDeployProgress(repositoryId);
  const active = items.some((item) => item.phase === "active");
  const now = useNow(active);

  useEffect(() => {
    let disposed = false;
    let timer = 0;
    const path = `/api/repositories/${encodeURIComponent(repositoryId)}/deployments`;
    const stale = (age: number) => Date.now() - (deploySnapshot(repositoryId)?.at ?? 0) >= age;
    const running = () => deploySnapshot(repositoryId)?.deployments.some(isActive) ?? false;
    const schedule = () => { if (!disposed && !timer && running()) timer = window.setTimeout(tick, ACTIVE_POLL_MS); };
    async function tick() {
      timer = 0;
      if (document.hidden) return;
      if (stale(ACTIVE_POLL_MS - 500)) {
        try {
          const value = await request<{ deployments?: DeploymentSummary[] }>(path);
          if (!disposed && Array.isArray(value.deployments)) publishDeployments(repositoryId, value.deployments);
        } catch { }
      }
      schedule();
    }
    if (stale(IDLE_REFRESH_MS)) void tick(); else schedule();
    const unsubscribe = subscribeDeployments(schedule);
    const visible = () => { if (!document.hidden && !timer) void tick(); };
    document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; window.clearTimeout(timer); unsubscribe(); document.removeEventListener("visibilitychange", visible); };
  }, [repositoryId, location]);

  const item = items.find((entry) => entry.phase === "active") ?? items[0];
  if (!item) return null;
  return <DeployPillView item={item} others={items.length - 1} now={now} href={href} onOpen={onOpen} onDismiss={() => dismissDeployment(item.deployment.id)} />;
}
