import { PackageIcon } from "@phosphor-icons/react";
import type { ManifestDependencyChanges, Mission } from "../shared/types";
import InfoTip from "./InfoTip";

export function DependencyChangesPanel({ mission }: { mission: Mission }) {
  const manifests = mission.dependencyChanges ?? [];
  if (!manifests.length) return null;
  const approval = mission.dependencyApproval;
  const current = approval && approval.candidateSha === mission.candidateSha && approval.baseSha === mission.baseSha && approval.epoch === mission.epoch;
  return (
    <section className="panel dependency-changes" aria-labelledby="dependency-changes-title">
      <div className="panel-header">
        <h2 id="dependency-changes-title">Dependency changes</h2>
        <PackageIcon size={16} color="#8b99ab" />
      </div>
      <div className="panel-body">
        <p className="dependency-note">
          {current
            ? <>Approved by Owner <strong>{approval.approvedBy}</strong> for revision <code>{approval.candidateSha.slice(0, 12)}</code>.</>
            : <>These package changes need a workspace Owner's explicit approval before this revision can land.</>}
        </p>
        {manifests.map((manifest) => (
          <div key={manifest.path} className="dependency-manifest">
            <h3><code>{manifest.path}</code></h3>
            <table>
              <thead>
                <tr><th>Package</th><th>Section</th><th>Change</th><th>Version</th></tr>
              </thead>
              <tbody>
                {manifest.changes.map((change) => (
                  <tr key={`${change.section}:${change.name}`}>
                    <td><code>{change.name}</code></td>
                    <td>{change.section}</td>
                    <td>{change.change}</td>
                    <td><code>{change.change === "added" ? change.to : change.change === "removed" ? change.from : `${change.from} → ${change.to}`}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </section>
  );
}

const LISTED = 3;

export function dependencyAllowLine(manifests: ManifestDependencyChanges[]): string {
  const changes = manifests.flatMap((manifest) => manifest.changes);
  const added = changes.some((change) => change.change !== "removed");
  const names = [...new Set(changes.filter((change) => !added || change.change !== "removed").map((change) => change.name))];
  const shown = names.slice(0, LISTED).join(", ");
  return `${added ? "Allow new packages" : "Allow package removals"}: ${names.length > LISTED ? `${shown} +${names.length - LISTED} more` : shown}`;
}

const ALLOW_TIP = "Agents added or changed dependencies. Landing needs a workspace Owner's OK. The full list is under Dependency changes.";

export function DependencyApprovalControl({ isOwner, checked, onChange, manifests }: { isOwner: boolean; checked: boolean; onChange: (value: boolean) => void; manifests: ManifestDependencyChanges[] }) {
  if (!isOwner) return <span className="dependency-ack muted">Package changes need an Owner's OK<InfoTip label="Package changes">{ALLOW_TIP}</InfoTip></span>;
  return (
    <span className="dependency-ack">
      <label>
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        {dependencyAllowLine(manifests)}
      </label>
      <InfoTip label="Allow packages">{ALLOW_TIP}</InfoTip>
    </span>
  );
}
