import { useEffect, useState } from "react";
import { request } from "./api";
import cloudflareIcon from "./assets/cloudflare-icon.svg";

type Status = { configured: boolean; connected: boolean };

export function CloudflareConnectPrompt({ onOpen }: { onOpen: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => { let active = true; request<Status>("/api/cloudflare").then((value) => { if (active) setStatus(value); }, () => {}); return () => { active = false; }; }, []);
  if (!status?.configured || status.connected) return null;
  return <div className="info-card cf-connect-prompt"><h3><img src={cloudflareIcon} alt="" width="17" height="17" />Connect your Cloudflare account</h3><p>Link Workers and D1 databases to repositories, see their usage and deploy landed changes. Signing in to Gitflare does not connect one.</p><button className="text-link" onClick={onOpen}>Connect Cloudflare</button></div>;
}
