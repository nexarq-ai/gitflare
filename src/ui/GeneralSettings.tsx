import { ArrowUpRightIcon, CubeIcon, GitBranchIcon, InfoIcon, LockKeyIcon, RobotIcon } from "@phosphor-icons/react";
import type { Workspace } from "../shared/types";
import AiSettingsPanel from "./AiSettingsPanel";
import { Status } from "./components";
import { InstallationCredentialPrompt } from "./InstallationCredential";

export default function GeneralSettings({ workspace, canManage, selfHosted, onChanged, onOpenCloudflare }: { workspace: Workspace; canManage: boolean; selfHosted: boolean; onChanged: () => Promise<void>; onOpenCloudflare: () => void }) {
  const connected = workspace.integrations.filter(item => item.ready).length;
  return <>
    <div className="page-heading"><div><h1>Workspace</h1><p>Name, defaults and ownership for {workspace.name}.</p></div></div>
    {selfHosted && canManage && <InstallationCredentialPrompt onOpen={onOpenCloudflare} />}
    <AiSettingsPanel settings={workspace.ai} canManage={canManage} onChanged={onChanged} />
    <section className="panel">
      <div className="panel-header"><h2>Workspace connections</h2><span className="number-tag">{connected} of {workspace.integrations.length} configured</span></div>
      {workspace.integrations.map(item => <div className="readiness-row" key={item.id}>
        <div className="service-icon">{item.id === "artifacts" ? <GitBranchIcon size={19} /> : item.id === "sandbox" ? <CubeIcon size={19} /> : item.id === "model" ? <RobotIcon size={19} /> : <LockKeyIcon size={19} />}</div>
        <div><h3>{item.name}</h3><p>{item.detail}</p></div>
        <Status status={item.ready ? "ready" : "blocked"} />
      </div>)}
      <div className="notice-inline">Connections are configured in your deployment. Refresh this page after changing them.</div>
    </section>
    <div className="info-card" style={{ maxWidth: 650 }}>
      <h3><InfoIcon size={16} />About this workspace</h3>
      <p>{workspace.mode === "local" ? "This is a local development workspace. Repository records and mission drafts are saved locally. Git hosting and agent execution require connected services." : "Your account permissions determine what you can access and change. Agent execution is limited to authorized repositories and the services configured for this deployment."}</p>
      <a href="https://developers.cloudflare.com/artifacts/get-started/" target="_blank" rel="noreferrer">Artifacts setup guide<ArrowUpRightIcon size={12} /></a>
    </div>
  </>;
}
