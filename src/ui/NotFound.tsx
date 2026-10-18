import { ArrowRightIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { BrandMark } from "./BrandMark";
import "./not-found.css";

export function NotFound({ authenticated }: { authenticated: boolean }) {
  return (
    <section className="not-found" aria-labelledby="not-found-title">
      <span className="not-found-code">404</span>
      <h1 id="not-found-title">This page doesn't exist</h1>
      <p>The link may be out of date, or the page may have moved.</p>
      <a className="not-found-primary" href={authenticated ? "/overview" : "/"}>{authenticated ? "Go to overview" : "Go home"}<ArrowRightIcon size={15} aria-hidden="true" /></a>
      <p className="not-found-hint"><MagnifyingGlassIcon size={14} aria-hidden="true" />{authenticated ? <>Press <kbd>⌘K</kbd> to search repositories and proposals.</> : <>Looking for something specific? <a href="/docs/overview">Search the docs</a>.</>}</p>
    </section>
  );
}

export default function NotFoundScreen({ authenticated = false }: { authenticated?: boolean }) {
  return (
    <div className="not-found-screen">
      <header className="not-found-header"><a href="/" aria-label="Gitflare home"><BrandMark size={28} /></a></header>
      <main id="main-content"><NotFound authenticated={authenticated} /></main>
    </div>
  );
}
