import "./demo-banner.css";

export default function DemoBanner({ resetsDaily }: { resetsDaily: string }) {
  return (
    <aside className="demo-banner" role="note" aria-label="Demo notice">
      <span><strong>Demo</strong> · Some actions are off · Resets daily at {resetsDaily}</span>
      <a href="https://gitflare.io/docs/install">Install your own</a>
    </aside>
  );
}
