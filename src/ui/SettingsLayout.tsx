import type { ReactNode } from "react";
import { REPOSITORY_SETTINGS_PAGES, WORKSPACE_SETTINGS_PAGES } from "./router";
import "./workspace-switcher.css";

type Item = { href: string; label: string; current: boolean; ai?: boolean };

export function SettingsLayout({ title, items, children }: { title: string; items: Item[]; children: ReactNode }) {
  return <div className="settings-layout">
    <nav className="settings-subnav" aria-label={title}>
      <p className="settings-subnav-title">{title}</p>
      {items.map(item => <a key={item.href} href={item.href} className={item.ai ? "ai-only" : undefined} aria-current={item.current ? "page" : undefined}>{item.label}</a>)}
    </nav>
    <div className="settings-content">{children}</div>
  </div>;
}

export function WorkspaceSettingsLayout({ route, children }: { route: string; children: ReactNode }) {
  return <SettingsLayout title="Workspace settings" items={WORKSPACE_SETTINGS_PAGES.map(page => ({ href: `/${page.route}`, label: page.label, current: route === page.route, ai: "ai" in page && page.ai }))}>{children}</SettingsLayout>;
}

export function RepositorySettingsLayout({ repositoryId, page, extra = [], children }: { repositoryId: string; page: string; extra?: { path: string; label: string }[]; children: ReactNode }) {
  const pages = [...REPOSITORY_SETTINGS_PAGES, ...extra];
  return <SettingsLayout title="Repository settings" items={pages.map(item => ({ href: `/repository/${repositoryId}/settings${item.path ? `/${item.path}` : ""}`, label: item.label, current: page === item.path }))}>{children}</SettingsLayout>;
}
