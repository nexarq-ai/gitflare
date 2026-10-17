import { Fragment, useId, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BookOpenIcon, CaretRightIcon, FileCodeIcon, FileTextIcon, ImageIcon } from "@phosphor-icons/react";
import { grammarFor, tokenize } from "./diff-highlight";
import "./mission-documents.css";

type ContextFile = { name: string; content: string };

const languageExtensions: Record<string, string> = { javascript: "js", typescript: "ts", python: "py", shell: "sh", shellscript: "sh", rust: "rs", ruby: "rb", golang: "go", csharp: "cs" };

function HighlightedCode({ content, language }: { content: string; language: string }) {
  const grammar = grammarFor(`code.${languageExtensions[language] ?? language}`);
  return <code>{content.split("\n").map((line, index, lines) => <Fragment key={index}>{tokenize(line, grammar).map((token, tokenIndex) => <span key={tokenIndex} className={token.kind ? `document-token-${token.kind}` : undefined}>{token.text}</span>)}{index < lines.length - 1 ? "\n" : ""}</Fragment>)}</code>;
}

export function MarkdownContent({ content, documents = [], currentDocument, onDocumentSelect }: { content: string; documents?: ContextFile[]; currentDocument?: string; onDocumentSelect?: (index: number) => void }) {
  return <div className="mission-document-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ children, href }) => {
      if (!href) return <span>{children}</span>;
      if (/^(https?:|mailto:)/i.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
      if (href.startsWith("#")) return <span>{children}</span>;
      let documentIndex = -1;
      try {
        const base = new URL(currentDocument ?? "", "https://context.invalid/");
        const target = new URL(href, base);
        if (target.origin === base.origin) documentIndex = documents.findIndex(document => decodeURIComponent(new URL(document.name, "https://context.invalid/").pathname) === decodeURIComponent(target.pathname));
      } catch {
        return <span>{children}</span>;
      }
      return documentIndex >= 0 && onDocumentSelect ? <button type="button" className="mission-document-link" onClick={() => onDocumentSelect(documentIndex)}>{children}</button> : <span>{children}</span>;
    },
    img: ({ alt }) => <span className="mission-document-image"><ImageIcon size={18} aria-hidden="true" /><span>{alt || "Attached image"}<small>Image reference</small></span></span>,
    pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
    code: ({ children, className }) => {
      const language = /language-([\w+-]+)/.exec(className ?? "")?.[1]?.toLowerCase();
      return language ? <HighlightedCode content={String(children)} language={language} /> : <code>{children}</code>;
    },
    table: ({ children }) => <div className="mission-document-table" tabIndex={0} role="region" aria-label="Document table"><table>{children}</table></div>,
  }}>{content}</Markdown></div>;
}

function fileFormat(name: string) {
  return /\.(md|markdown|mdown)$/i.test(name) ? "Markdown" : "Text";
}

export function ContextFiles({ files }: { files: ContextFile[] }) {
  const [selected, setSelected] = useState(0);
  const [source, setSource] = useState(false);
  const readerId = useId();
  if (!files.length) return null;
  const currentIndex = Math.min(selected, files.length - 1);
  const current = files[currentIndex];
  const format = fileFormat(current.name);
  const lines = current.content.split("\n").length;
  return <section className="panel mission-context-files" aria-label="Context files">
    <div className="panel-header"><h2><BookOpenIcon size={17} aria-hidden="true" />Context files <span className="mission-context-count">{files.length}</span></h2><span className="mission-context-description">Reference documents</span></div>
    <div className="mission-context-layout">
      <nav className="mission-context-nav" aria-label="Context documents">{files.map((file, index) => <button type="button" key={`${file.name}-${index}`} aria-current={currentIndex === index ? "true" : undefined} aria-controls={readerId} onClick={() => { setSelected(index); setSource(false); }}>
        <FileTextIcon size={19} aria-hidden="true" /><span><strong>{file.name}</strong><small>{fileFormat(file.name)} · {new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(new TextEncoder().encode(file.content).length)} B</small></span><CaretRightIcon size={13} aria-hidden="true" />
      </button>)}</nav>
      <div className="mission-context-reader" id={readerId}>
        <div className="mission-context-toolbar"><span><FileCodeIcon size={16} aria-hidden="true" /><strong>{current.name}</strong></span><div><span className="mission-context-lines">{lines} {lines === 1 ? "line" : "lines"}</span>{format === "Markdown" && <button type="button" aria-pressed={source} onClick={() => setSource(value => !value)}>{source ? "Read document" : "View source"}</button>}</div></div>
        <div className="mission-context-content" role="region" aria-label={`${current.name} content`} tabIndex={0} key={`${currentIndex}-${source}`}>
          {format === "Markdown" && !source ? <MarkdownContent content={current.content} currentDocument={current.name} documents={files} onDocumentSelect={index => { setSelected(index); setSource(false); }} /> : <pre className="mission-document-source"><code>{current.content}</code></pre>}
          {!current.content && <p className="mission-document-empty">This file is empty.</p>}
        </div>
      </div>
    </div>
  </section>;
}
