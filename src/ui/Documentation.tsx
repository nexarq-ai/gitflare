import { useEffect, useRef, useState, type ReactNode } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { ArrowsOutIcon, BookOpenIcon, CheckIcon, CopyIcon, ArrowSquareOutIcon, XIcon } from "@phosphor-icons/react";
import { request } from "./api";
import { ErrorNotice } from "./components";
import { diagrams, type DocumentationDiagram } from "./doc-diagrams";
import "./documentation.css";
import { grammarFor, tokenize } from "./diff-highlight";
import { DocumentationIllustration } from "./DocumentationIllustration";
import { navigate as goTo } from "./router";
import { appOrigin } from "./hosts";
import { RouteProgress } from "./WorkspaceLoader";

type DocumentItem = {
  id: string;
  title: string;
  description: string;
  audience: string;
  filename: string;
};
type DocumentContent = DocumentItem & { content: string };

function headingId(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");
}

function plainText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(plainText).join("");
  if (children && typeof children === "object" && "props" in children) {
    return plainText((children.props as { children?: ReactNode }).children);
  }
  return "";
}

function containsMarkdownImage(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  if ("tagName" in node && node.tagName === "img") return true;
  return "children" in node && Array.isArray(node.children) && node.children.some(containsMarkdownImage);
}

function DocumentationCode({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState("Copy");
  const code = plainText(children);
  const codeElement = Array.isArray(children) ? children.find((child) => child && typeof child === "object" && "props" in child) : children;
  const language = codeElement && typeof codeElement === "object" && "props" in codeElement ? ((codeElement.props as { className?: string }).className ?? "").replace("language-", "") : "";
  const grammar = grammarFor(`example.${language}`);
  return <div className="documentation-code-block"><div className="documentation-code-toolbar"><span>{language || "Code"}</span><button type="button" onClick={async () => { try { await navigator.clipboard.writeText(code); setStatus("Copied"); } catch { setStatus("Copy unavailable"); } }} aria-label="Copy code"><CopyIcon size={13} />{status}</button></div><pre tabIndex={0}><code>{code.split("\n").map((line, lineIndex, lines) => <span key={lineIndex}>{tokenize(line, grammar).map((token, index) => token.kind ? <span className={`docs-token-${token.kind}`} key={index}>{token.text}</span> : token.text)}{lineIndex < lines.length - 1 ? "\n" : ""}</span>)}</code></pre><span className="documentation-code-status" role="status">{status === "Copy" ? "" : status === "Copied" ? "Code copied to clipboard." : "Copy unavailable. Select the code to copy it."}</span></div>;
}

export default function Documentation({ id, publicMode = false }: { id: string; publicMode?: boolean }) {
  const isIndex = /^\/docs\/?$/.test(window.location.pathname);
  const [items, setItems] = useState<DocumentItem[]>([]);
  const [document, setDocument] = useState<DocumentContent | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyGeneration = useRef(0);
  const [expandedDiagram, setExpandedDiagram] = useState<(DocumentationDiagram & { alt: string }) | null>(null);
  const [activeHeading, setActiveHeading] = useState("");
  const [guideQuery, setGuideQuery] = useState("");
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 760px)").matches);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setCompact(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const article = useRef<HTMLElement>(null);
  const diagramTrigger = useRef("");
  const pendingAnchor = useRef("");

  useEffect(() => {
    let active = true;
    setItems([]);
    setError("");
    void request<{ items: DocumentItem[] }>(publicMode ? "/api/public/docs" : "/api/docs").then((data) => {
      if (active) setItems(data.items);
    }).catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : "Documentation could not be loaded.");
    });
    return () => { active = false; };
  }, [retry, publicMode]);

  useEffect(() => {
    let active = true;
    setDocument(null);
    setCopyState("idle");
    copyGeneration.current += 1;
    setExpandedDiagram(null);
    setLoading(true);
    setError("");
    void request<DocumentContent>(`${publicMode ? "/api/public/docs" : "/api/docs"}/${encodeURIComponent(id)}`).then((data) => {
      if (active) setDocument(data);
    }).catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : "This document could not be loaded.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [id, retry, publicMode]);

  async function copyMarkdown() {
    if (!document) return;
    const generation = copyGeneration.current;
    try {
      const response = await fetch(`${publicMode ? "/api/public/docs" : "/api/docs"}/${encodeURIComponent(document.id)}.md`, { credentials: "same-origin" });
      if (response.status === 401 && !publicMode) window.dispatchEvent(new Event("gitflare:session-required"));
      if (!response.ok) throw new Error("Markdown could not be loaded.");
      const markdown = await response.text();
      if (generation !== copyGeneration.current) return;
      await navigator.clipboard.writeText(markdown);
      if (generation === copyGeneration.current) setCopyState("copied");
    } catch {
      if (generation === copyGeneration.current) setCopyState("failed");
    }
  }

  function scrollToHeading(anchor: string) {
    const target = Array.from(article.current?.querySelectorAll<HTMLElement>("[id]") ?? []).find((element) => element.id === anchor);
    target?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
    target?.focus({ preventScroll: true });
  }

  useEffect(() => {
    if (document && pendingAnchor.current) {
      scrollToHeading(pendingAnchor.current);
      pendingAnchor.current = "";
    }
  }, [document]);

  useEffect(() => {
    if (!document || !article.current || isIndex) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActiveHeading(visible[0].target.id);
    }, { rootMargin: "-110px 0px -60% 0px" });
    article.current.querySelectorAll("h2[id], h3[id]").forEach((heading) => observer.observe(heading));
    return () => observer.disconnect();
  }, [document, isIndex]);

  const content = document?.content.replace(/^\s*# [^\n]+\n/, "") ?? "";
  const readingMinutes = Math.max(1, Math.ceil(content.split(/\s+/).length / 220));
  const category = document?.audience === "human" ? "Workspace guide" : document?.audience === "agent" ? "AI client guide" : document?.audience === "planning" ? "Platform planning" : "Engineering";
  const headings: { title: string; anchor: string; level: number }[] = [];
  let fence = "";
  for (const line of content.split("\n")) {
    const marker = line.trim().match(/^(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (fence === marker[1][0]) fence = "";
      continue;
    }
    const match = !fence && line.match(/^(#{1,3})\s+(.+?)\s*#*$/);
    if (match) {
      const title = match[2].replace(/[`*_]/g, "");
      headings.push({ title, anchor: headingId(title), level: match[1].length });
    }
  }

  return (
    <div className={`documentation-page wiki-page ${isIndex ? "documentation-index" : ""}`}>
      {!publicMode && <div className="documentation-library-heading"><BookOpenIcon size={20} /><span>Gitflare documentation</span></div>}
      {error && <ErrorNotice message={error} onRetry={() => setRetry((value) => value + 1)} />}
      <div className="documentation-layout">
        <div className="documentation-mobile-selector"><label htmlFor="documentation-guide">Guide</label><select id="documentation-guide" value={isIndex ? "" : id} disabled={!items.length} onChange={(event) => { goTo(`docs/${event.target.value}`); }}>{isIndex && <option value="">Browse all guides</option>}{!items.length && <option value={id}>Loading library…</option>}{items.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>
        <aside className="documentation-navigation" aria-label="Documentation library"><a className="documentation-nav-title" href="/docs"><BookOpenIcon size={18} />Documentation</a><label className="documentation-guide-search"><span>Find a guide</span><input type="search" value={guideQuery} onChange={(event) => setGuideQuery(event.target.value)} placeholder="Search guides…" /></label>
          {[{ label: "For people", audience: "human" }, { label: "For AI clients", audience: "agent" }, { label: "Reference", audience: "reference" }].map((group) => {
            const documents = items.filter((item) => (item.audience === group.audience || (group.audience === "reference" && !["human", "agent"].includes(item.audience))) && `${item.title} ${item.description}`.toLowerCase().includes(guideQuery.toLowerCase()));
            return documents.length > 0 && <section key={group.audience}><h2>{group.label}</h2>{documents.map((item) => <a key={item.id} href={`/docs/${item.id}`} aria-current={!isIndex && id === item.id ? "page" : undefined} className={!isIndex && id === item.id ? "selected" : ""}><span>{item.title}</span><span aria-hidden="true">↗</span></a>)}</section>;
          })}
          {!items.length && !error && <RouteProgress />}
        </aside>
        <article className="documentation-article" ref={article} aria-busy={loading}>
          {isIndex ? <>
            <header className="documentation-index-header"><p className="documentation-eyebrow"><span />THE GITFLARE MANUAL</p><h1>A shared codebase.<br /><em>A clear way forward.</em></h1><p className="documentation-index-intro">From your first connection to your next revision.<br />Everything you need to work with Gitflare.</p><div className="documentation-index-actions"><a className="gfp-button gfp-button-primary" href="/docs/overview">Start with the basics <ArrowSquareOutIcon size={15} /></a><a className="gfp-button" href="/docs/install">Self-hosting guide <span aria-hidden="true">→</span></a></div></header>
            <div className="documentation-guide-heading"><h2>Find your starting point</h2><span>{items.length ? `${String(items.length).padStart(2, "0")} ${publicMode ? "PUBLIC " : ""}GUIDES` : "LOADING GUIDES"}</span></div>
            {!items.length && !error && <RouteProgress />}
            <div className="documentation-card-grid">{items.filter((item) => `${item.title} ${item.description}`.toLowerCase().includes(guideQuery.toLowerCase())).map((item, index) => <a className="documentation-card" href={`/docs/${item.id}`} key={item.id}><div className="documentation-card-top"><span>{String(index + 1).padStart(2, "0")} / {item.audience === "agent" ? "AGENT CONTEXT" : item.audience === "human" ? "THE WORKSPACE" : "REFERENCE"}</span><ArrowSquareOutIcon size={18} /></div><h3>{item.title}</h3><p>{item.description}</p><span className="documentation-card-bottom">Open guide <span aria-hidden="true">→</span></span></a>)}</div>
            <section className="documentation-connect-banner" aria-labelledby="documentation-connect-title"><div className="documentation-connect-icon" aria-hidden="true">⌘</div><div><p className="documentation-eyebrow">YOUR CLIENT. YOUR WORKSPACE.</p><h2 id="documentation-connect-title">Bring your AI along.</h2><p>One authenticated MCP endpoint. The same permissions and review checks.</p><code>{new URL("/mcp", appOrigin()).href}</code></div><a href="/connectors">Connect a client <span aria-hidden="true">↗</span></a></section>
            <p className="documentation-index-footnote">Guides from this installation's documentation library. Implementation and live verification are identified separately in each guide.</p>
          </> : loading ? <p role="status">Opening document…</p> : document ? <>
            <nav className="documentation-breadcrumb" aria-label="Breadcrumb"><a href="/docs">Docs</a><span aria-hidden="true">/</span><span>{category}</span></nav>
            <header className="documentation-title"><div className="documentation-meta"><span>{category}</span><span>{readingMinutes} min read</span></div><h1>{document.title}</h1><p>{document.description}</p><div className="documentation-format-actions"><a href={`${publicMode ? "/api/public/docs" : "/api/docs"}/${encodeURIComponent(document.id)}.md`} target="_blank" rel="noopener noreferrer"><ArrowSquareOutIcon size={16} aria-hidden="true" />View Markdown</a><button type="button" onClick={() => void copyMarkdown()}><span aria-hidden="true">{copyState === "copied" ? <CheckIcon size={16} /> : <CopyIcon size={16} />}</span>{copyState === "copied" ? "Copied" : "Copy Markdown"}</button></div><span className="documentation-copy-status" role="status">{copyState === "copied" ? "Markdown copied to clipboard." : copyState === "failed" ? "Copy unavailable. Open View Markdown to copy the text." : ""}</span></header>
            <div className="documentation-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={(url) => Object.hasOwn(diagrams, url) ? url : defaultUrlTransform(url)} components={{
              pre: ({ children }) => <DocumentationCode key={id + plainText(children)}>{children}</DocumentationCode>,
              p: ({ node, children }) => containsMarkdownImage(node) ? <div className="documentation-media-block">{children}</div> : <p>{children}</p>,
              h1: ({ children }) => <h2 className="documentation-article-heading" id={headingId(plainText(children))} tabIndex={-1}>{children}</h2>,
              h2: ({ children }) => <h2 id={headingId(plainText(children))} tabIndex={-1}>{children}</h2>,
              h3: ({ children }) => <h3 id={headingId(plainText(children))} tabIndex={-1}>{children}</h3>,
              img: ({ src, alt }) => {
                if (src === "gitflare-diagram:flow") return <DocumentationIllustration key={`${id}:revision`} kind="revision" />;
                if (src === "gitflare-diagram:mcp-connection") return <DocumentationIllustration key={`${id}:mcp`} kind="mcp" />;
                if (src === "https://deploy.workers.cloudflare.com/button") return <img src={src} width={200} height={32} alt={alt || "Deploy to Cloudflare"} loading="lazy" />;
                const diagram = src && Object.hasOwn(diagrams, src) ? diagrams[src] : undefined;
                return diagram ? <span className="documentation-diagram" role="figure" aria-label={diagram.title}><span className="documentation-diagram-scroll" tabIndex={0} role="region" aria-label={`${diagram.title}, scroll to see the full diagram`}><img src={diagram.src} alt={alt || diagram.caption} loading="lazy" /></span><span className="documentation-diagram-caption">{diagram.caption}</span><span className="documentation-diagram-tools"><span className="documentation-diagram-hint">Scroll horizontally to see the full diagram.</span><button type="button" data-diagram-key={`${id}:${src}`} onClick={() => { diagramTrigger.current = `${id}:${src}`; setExpandedDiagram({ ...diagram, alt: alt || diagram.caption }); }} aria-label={`Expand diagram: ${diagram.title}`}><ArrowsOutIcon size={15} />Expand diagram</button></span></span> : <span className="documentation-image-label">{alt ? `Image: ${alt}` : "Image reference"}</span>;
              },
              a: ({ href, children }) => {
                if (href?.startsWith("#")) return <button className="documentation-inline-link" onClick={() => scrollToHeading(href.slice(1))}>{children}</button>;
                if (href && /^https?:\/\//i.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
                const [path, anchor] = (href ?? "").split("#");
                let decodedPath = path;
                try { decodedPath = decodeURIComponent(path); } catch { decodedPath = ""; }
                const filename = decodedPath.replace(/^\.\//, "").split("/").pop();
                const linked = items.find((item) => item.filename === decodedPath || item.filename.split("/").pop() === filename);
                if (linked) return <a href={`/docs/${linked.id}`} onClick={(event) => { if (linked.id === id && anchor) { event.preventDefault(); scrollToHeading(anchor); } else { pendingAnchor.current = anchor ?? ""; } }}>{children}</a>;
                return <span title="This reference is not available in the documentation library">{children}<span className="documentation-unavailable"> (reference unavailable)</span></span>;
              },
              table: ({ children }) => <div className="documentation-table"><table>{children}</table></div>,
            }}>{content}</Markdown></div>
            <nav className="documentation-pagination" aria-label="Adjacent guides">{[items[items.findIndex((item) => item.id === id) - 1], items[items.findIndex((item) => item.id === id) + 1]].map((item, index) => item && <a key={item.id} href={`/docs/${item.id}`}><span>{index === 0 ? "← Previous guide" : "Next guide →"}</span><strong>{item.title}</strong></a>)}</nav>
            <footer className="documentation-article-footer"><BookOpenIcon size={16} /><span>Gitflare workspace documentation</span><button onClick={() => article.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" })}>Back to top</button></footer>
          </> : !error && <p>This document is unavailable.</p>}
          {!loading && error && <Button variant="secondary" size="base" onClick={() => setRetry((value) => value + 1)}>Try again</Button>}
        </article>
        {!isIndex && headings.length > 0 && <aside className="documentation-toc" aria-label="On this page"><details className="documentation-toc-details" open={!compact}><summary>On this page</summary><div>{headings.map((heading, index) => <button key={`${heading.anchor}-${index}`} className={`level-${heading.level}`} aria-current={activeHeading === heading.anchor ? "location" : undefined} onClick={() => scrollToHeading(heading.anchor)}>{heading.title}</button>)}</div></details></aside>}
      </div>
      <Dialog.Root open={expandedDiagram !== null} onOpenChange={(open) => { if (!open) setExpandedDiagram(null); }} onOpenChangeComplete={(open) => { if (!open) Array.from(article.current?.querySelectorAll<HTMLButtonElement>("[data-diagram-key]") ?? []).find((button) => button.dataset.diagramKey === diagramTrigger.current)?.focus({ preventScroll: true }); }}>
        <Dialog size="xl" className="documentation-diagram-dialog">
          <div className="documentation-diagram-dialog-heading"><Dialog.Title>{expandedDiagram?.title ?? "Diagram"}</Dialog.Title><Button variant="ghost" size="base" shape="square" icon={XIcon} aria-label="Close diagram" onClick={() => setExpandedDiagram(null)} /></div>
          <Dialog.Description className="documentation-diagram-dialog-description">{expandedDiagram?.caption}</Dialog.Description>
          <div className="documentation-diagram-expanded" tabIndex={0} role="region" aria-label="Expanded diagram, scroll horizontally if needed">{expandedDiagram && <img src={expandedDiagram.src} alt={expandedDiagram.alt} />}</div>
          <p className="documentation-diagram-dialog-hint">Scroll to explore the diagram. Press Escape to close.</p>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}
