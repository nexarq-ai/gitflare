import { useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { ArrowClockwiseIcon, ArrowSquareOutIcon, CopyIcon, LockKeyIcon } from "@phosphor-icons/react";
import InfoTip from "./InfoTip";
import { request } from "./api";
import { ErrorNotice } from "./components";
import { mcpClientGuides } from "../shared/mcp-clients";
import DemoFeaturePanel, { demoOf } from "./DemoFeaturePanel";
import type { DemoMarked } from "../shared/demo-features";

type McpMetadata = DemoMarked & { endpoint: string; configured: boolean; tools: string[]; authentication: string };
export default function McpConnections() {
  const [metadata, setMetadata] = useState<McpMetadata | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const [client, setClient] = useState("claude");
  const endpoint = new URL("/mcp", window.location.origin).href;
  const guides = mcpClientGuides(endpoint);
  const guide = guides.find(item => item.id === client) ?? guides[0];
  async function load() { setBusy(true); setError(""); try { setMetadata(await request<McpMetadata>("/api/mcp")); } catch (failure) { setError(failure instanceof Error ? failure.message : "Connection settings are unavailable."); } finally { setBusy(false); } }
  function copy(key: string, value: string) { void navigator.clipboard.writeText(value).then(() => setCopied(key)).catch(() => setError("Select and copy the text manually.")); }
  useEffect(() => { void load(); }, []);
  return <section className="mcp-connections">
    <div className="section-heading"><div><h2>Connect AI clients</h2><p className="mcp-section-description">Authorize Claude, Codex, Cursor, OpenCode, VS Code or any MCP client to use the same workspace actions and permissions.</p></div><Button variant="secondary" icon={ArrowClockwiseIcon} loading={busy} onClick={() => void load()}>Refresh</Button></div>
    {error && <ErrorNotice message={error} onRetry={() => void load()}/>}
    {demoOf(metadata) ? <DemoFeaturePanel demo={demoOf(metadata)} examples={metadata?.examples} /> : <>
    <section className="panel"><div className="panel-header"><h2>Gitflare MCP endpoint</h2><span className="pill">{metadata?.configured ? "Ready" : "Not set up"}</span></div><div className="panel-body"><div className="mcp-endpoint"><code>{endpoint}</code><Button variant="secondary" icon={CopyIcon} onClick={() => copy("endpoint", endpoint)}>{copied === "endpoint" ? "Copied" : "Copy URL"}</Button></div><p className="mcp-section-description mcp-auth-note"><LockKeyIcon size={14} aria-hidden="true" /><span>Browser authorization through OAuth. Your client initiates the connection; Gitflare asks you to approve it.</span></p></div></section>
    <div className="mcp-client-picker" role="tablist" aria-label="AI client">{guides.map(item => <button key={item.id} type="button" role="tab" id={`mcp-tab-${item.id}`} aria-controls="mcp-client-panel" aria-selected={item.id === guide.id} className={item.id === guide.id ? "selected" : ""} onClick={() => { setClient(item.id); setCopied(""); }}>{item.name}</button>)}</div>
    <section className="panel" role="tabpanel" id="mcp-client-panel" aria-labelledby={`mcp-tab-${guide.id}`}>
      <div className="panel-header"><h2>{guide.name}</h2>{guide.link && <a className="mcp-install-link" href={guide.link.href}>{guide.link.label}</a>}</div>
      <div className="panel-body">
        <p className="mcp-section-description">{guide.summary}</p>
        <ol className="mcp-steps">{guide.steps.map((step, index) => <li key={index}><p>{step.text}</p>{step.code && <div className="mcp-code"><div><span>{step.label}</span><Button variant="ghost" size="sm" icon={CopyIcon} onClick={() => copy(`${guide.id}-${index}`, step.code!)}>{copied === `${guide.id}-${index}` ? "Copied" : "Copy"}</Button></div><pre>{step.code}</pre></div>}</li>)}</ol>
        {guide.note && <p className="notice-inline">{guide.note}</p>}
        <a className="mcp-doc-link" href={guide.source} target="_blank" rel="noopener noreferrer">{guide.name} setup reference <ArrowSquareOutIcon size={13}/></a>
      </div>
    </section>
    <section className="panel"><div className="panel-body"><p className="mcp-section-description">Clients act with your role and repository access.<InfoTip label="client access">Revoking your access revokes the client's. Agents use their own scoped credentials, never your session.</InfoTip></p><a href="/docs/mcp">MCP documentation</a></div></section>
    </>}
  </section>;
}
