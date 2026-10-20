import { repositoryLabel } from "../shared/repository-names";
import { useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { CopyIcon, InfoIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import type { BranchList, Repository } from "../shared/types";
import { request } from "./api";
import InfoTip from "./InfoTip";
import { quoteGitArgument } from "./RepositoryImport";
import "./pull-requests.css";

export default function GitAccess({ repository, publicUrl, onNotify }: { repository: Repository; publicUrl?: string; onNotify: (message: string) => void }) {
  const [gitUrl, setGitUrl] = useState(`${location.origin}/git/${repositoryLabel(repository)}.git`);
  useEffect(() => {
    let active = true;
    request<BranchList>(`/api/repositories/${encodeURIComponent(repository.id)}/branches`).then(list => { if (active && list.gitUrl) setGitUrl(list.gitUrl); }).catch(() => {});
    return () => { active = false; };
  }, [repository.id]);
  const commands = publicUrl ? [`git clone ${quoteGitArgument(publicUrl)}`, `git remote set-url --push origin ${quoteGitArgument(gitUrl)}`, "git push origin my-branch"] : [`git clone ${quoteGitArgument(gitUrl)}`, "git push origin my-branch"];
  return (
    <section className="panel git-access">
      <div className="panel-header"><h2 className="field-label">Clone and push<InfoTip label="SSH">SSH isn't available. Clone and push over HTTPS with a personal token.</InfoTip></h2><a className="text-link" href={`/repository/${repository.id}/settings/branches`}><ShieldCheckIcon size={13} />Streams &amp; protection</a></div>
      <div className="panel-body">
        {publicUrl && <p className="git-access-public">Public — anyone can clone without signing in.</p>}
        {commands.map(command => (
          <div className="clipboard-row" key={command}>
            <code>{command}</code>
            <Button variant="ghost" size="base" shape="square" aria-label={`Copy ${command}`} icon={CopyIcon} onClick={() => void navigator.clipboard.writeText(command).then(() => onNotify("Command copied.")).catch(() => onNotify("Copy is unavailable in this browser."))} />
          </div>
        ))}
        <p className="git-access-note"><InfoIcon size={14} /><span>Password: a personal token from <a href="/account/clients">Account → AI clients</a>. Protected streams reject pushes; push a new stream and <a href={`/repository/${repository.id}/pulls/new`}>open a proposal</a>. Tags are managed by Checkpoints.</span></p>
      </div>
    </section>
  );
}
