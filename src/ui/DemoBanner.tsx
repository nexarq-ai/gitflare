import "./demo-banner.css";

export default function DemoBanner({ resetsDaily }: { resetsDaily: string }) {
  return (
    <aside className="demo-banner" role="note" aria-label="Demo notice">
      <strong>Demo of the self-hosted edition.</strong>
      <span>You are signed in as a demo visitor. Deploys, Cloudflare connections, secrets, mirrors, AI keys, email, invitations and agent runs are disabled. Everything resets nightly at {resetsDaily}.</span>
      <a href="https://gitflare.io/docs/install">Install your own</a>
    </aside>
  );
}
