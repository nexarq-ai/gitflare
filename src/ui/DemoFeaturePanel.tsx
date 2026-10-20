import { Badge } from "@cloudflare/kumo/components/badge";
import { LinkButton } from "@cloudflare/kumo/components/button";
import { ArrowSquareOutIcon, BookOpenIcon, LockSimpleIcon } from "@phosphor-icons/react";
import { DEMO_INSTALL_URL, demoDisabled, type DemoDisabled, type DemoExampleValue, type DemoExamples, type DemoFeatureId } from "../shared/demo-features";
import "./demo-feature-panel.css";

const TITLES: Record<string, string> = {
  secretReferences: "Secret references", mirror: "Mirror status", environments: "Environments", resources: "Resources", connection: "Connection",
  previewSettings: "Preview settings", checkSettings: "Check settings", models: "Models", keys: "AI keys", gateway: "AI Gateway",
  invitations: "Invitations", credential: "Credential", clients: "Connected clients",
};
const COLUMNS: Record<string, string> = { githubCommit: "GitHub", gitflare: "Gitflare", lastDeploy: "Last deploy", liveCommit: "Live commit", deployedAt: "Deployed", accountId: "Account ID", addedBy: "Added by", checkedWith: "Checked with", allowedDomains: "Allowed domains", previewEmail: "Preview email", lastSynced: "Last synced", lastUsed: "Last used" };

const humanize = (key: string) => COLUMNS[key] ?? key.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const SHA = /^[0-9a-f]{40}$/;

function Cell({ value }: { value: DemoExampleValue }) {
  if (value === null || value === "") return <span className="demo-example-empty">—</span>;
  if (Array.isArray(value)) return <>{value.join(", ")}</>;
  if (typeof value === "boolean") return <>{value ? "Yes" : "No"}</>;
  if (typeof value === "number") return <>{value.toLocaleString()}</>;
  if (SHA.test(value)) return <code title={value}>{value.slice(0, 12)}</code>;
  if (ISO_DATE.test(value)) return <time dateTime={value}>{new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>;
  if (/^[a-f0-9]{32}$/.test(value)) return <code>{value}</code>;
  return <>{value}</>;
}

export function demoOf(value: unknown): DemoDisabled | null {
  const demo = value && typeof value === "object" ? (value as { demo?: DemoDisabled }).demo : undefined;
  return demo?.disabled ? demo : null;
}

export default function DemoFeaturePanel({ demo, feature, examples, headingLevel = 2 }: { demo?: DemoDisabled | null; feature?: DemoFeatureId; examples?: DemoExamples; headingLevel?: 2 | 3 }) {
  const shown = demo ?? (feature ? demoDisabled(feature) : null);
  if (!shown) return null;
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const Subheading = headingLevel === 2 ? "h3" : "h4";
  const tables = Object.entries(examples ?? {}).filter(([, rows]) => rows.length > 0);
  const id = `demo-feature-${shown.feature}`;
  return (
    <section className="panel demo-feature" aria-labelledby={id}>
      <div className="demo-feature-head">
        <span className="demo-feature-icon" aria-hidden="true"><LockSimpleIcon size={20} /></span>
        <div className="demo-feature-copy">
          <div className="demo-feature-title">
            <Heading id={id}>{shown.name}</Heading>
            <Badge variant="warning">Disabled in the demo</Badge>
          </div>
          <p>{shown.summary}</p>
          <p className="demo-feature-reason">{shown.reason}</p>
        </div>
      </div>
      <div className="demo-feature-actions">
        <LinkButton variant="secondary" size="base" icon={BookOpenIcon} href={shown.docs}>See how it works</LinkButton>
        <LinkButton variant="primary" size="base" icon={ArrowSquareOutIcon} href={shown.install || DEMO_INSTALL_URL}>Install your own</LinkButton>
      </div>
      {tables.map(([key, rows]) => {
        const columns = Object.keys(rows[0]);
        const title = TITLES[key] ?? humanize(key);
        return (
          <div className="demo-example" key={key}>
            <div className="demo-example-head"><Subheading>{title}</Subheading><span className="demo-example-label">Example</span></div>
            <div className="demo-example-scroll" role="region" aria-label={`${title} example`} tabIndex={0}>
              <table className="demo-example-table">
                <thead><tr>{columns.map((column) => <th key={column} scope="col">{humanize(column)}</th>)}</tr></thead>
                <tbody>{rows.map((row, index) => <tr key={index}>{columns.map((column) => <td key={column}><Cell value={row[column] ?? null} /></td>)}</tr>)}</tbody>
              </table>
            </div>
          </div>
        );
      })}
      {tables.length > 0 && <p className="demo-example-note">Sample data. No real secrets.</p>}
    </section>
  );
}
