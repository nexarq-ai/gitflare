import { useEffect, useId, useMemo, useState, type ComponentType } from "react";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import {
  ActivityIcon,
  ArrowRightIcon,
  ArrowsLeftRightIcon,
  BellIcon,
  BookOpenIcon,
  BuildingsIcon,
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  CloudIcon,
  CompassIcon,
  CopyIcon,
  DownloadSimpleIcon,
  FileTextIcon,
  FolderSimpleIcon,
  GearSixIcon,
  GitBranchIcon,
  GitForkIcon,
  HouseIcon,
  KeyIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  PlugsConnectedIcon,
  PlusIcon,
  RocketLaunchIcon,
  ShieldCheckIcon,
  SignOutIcon,
  SunIcon,
  TrayIcon,
  UserCircleIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import type { Workspace } from "../shared/types";
import { useTheme } from "./ThemeToggle";
import { SECTION_ORDER, emptySuggestions, paletteKey, resultCountLabel, searchPalette, staticEntries, workspaceEntries, type PaletteAction, type PaletteContext, type PaletteEntry, type PaletteIcon } from "./command-palette";

type IconComponent = ComponentType<{ size?: number }>;

const ICONS: Record<PaletteIcon, IconComponent> = {
  home: HouseIcon,
  page: FileTextIcon,
  inbox: TrayIcon,
  repository: FolderSimpleIcon,
  proposal: GitBranchIcon,
  activity: ActivityIcon,
  explore: CompassIcon,
  settings: GearSixIcon,
  account: UserCircleIcon,
  security: ShieldCheckIcon,
  ai: PlugsConnectedIcon,
  notifications: BellIcon,
  people: UsersThreeIcon,
  cloud: CloudIcon,
  audit: ClockCounterClockwiseIcon,
  admin: BuildingsIcon,
  docs: BookOpenIcon,
  plus: PlusIcon,
  import: DownloadSimpleIcon,
  theme: MoonIcon,
  switch: ArrowsLeftRightIcon,
  copy: CopyIcon,
  signout: SignOutIcon,
  search: MagnifyingGlassIcon,
  deploy: RocketLaunchIcon,
  branch: GitForkIcon,
  checks: CheckCircleIcon,
  secret: KeyIcon,
};

const DYNAMIC_SEARCH_DELAY = 120;

export default function QuickSearch({
  open,
  workspace,
  context: access,
  onClose,
  onNavigate,
  onSwitchWorkspace,
  onAction,
}: {
  open: boolean;
  workspace: Workspace;
  context: Omit<PaletteContext, "theme">;
  onClose: () => void;
  onNavigate: (route: string) => void;
  onSwitchWorkspace?: (id: string) => void;
  onAction: (action: PaletteAction) => void;
}) {
  const [query, setQuery] = useState("");
  const [dynamicQuery, setDynamicQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listId = useId();
  const theme = useTheme();
  const context = useMemo(() => ({ ...access, theme }), [access, theme]);

  useEffect(() => {
    const timer = setTimeout(() => setDynamicQuery(query), DYNAMIC_SEARCH_DELAY);
    return () => clearTimeout(timer);
  }, [query]);

  const staticItems = useMemo(() => staticEntries(context), [context]);
  const dynamicItems = useMemo(() => workspaceEntries(workspace), [workspace]);
  const groups = useMemo(() => {
    const fixed = searchPalette(staticItems, query);
    const live = searchPalette(dynamicItems, dynamicQuery);
    return [...fixed, ...live].sort((a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section));
  }, [staticItems, dynamicItems, query, dynamicQuery]);
  const suggestions = useMemo(() => groups.length ? [] : emptySuggestions(query, context), [groups.length, query, context]);
  const flat = useMemo(() => groups.length ? groups.flatMap(group => group.entries) : suggestions, [groups, suggestions]);
  const count = groups.reduce((total, group) => total + group.entries.length, 0);

  useEffect(() => {
    if (open) {
      setQuery("");
      setDynamicQuery("");
      setSelected(0);
    }
  }, [open]);
  useEffect(() => {
    setSelected(0);
  }, [query]);
  useEffect(() => {
    if (selected >= flat.length) setSelected(0);
  }, [flat.length, selected]);

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [selected, open, listId]);

  function choose(entry: PaletteEntry | undefined) {
    if (!entry) return;
    onClose();
    if (entry.workspaceId) onSwitchWorkspace?.(entry.workspaceId);
    else if (entry.action) onAction(entry.action);
    else if (entry.route) onNavigate(entry.route);
  }

  function row(entry: PaletteEntry, index: number) {
    const Icon = entry.action === "toggle-theme" && context.theme === "dark" ? SunIcon : ICONS[entry.icon];
    return (
      <button
        key={entry.id}
        id={`${listId}-${index}`}
        role="option"
        aria-selected={selected === index}
        tabIndex={-1}
        className={`command-result ${selected === index ? "selected" : ""}`}
        onMouseEnter={() => setSelected(index)}
        onClick={() => choose(entry)}
      >
        <Icon size={17} />
        <span>
          <strong>{entry.title}</strong>
          {entry.detail && <small>{entry.detail}</small>}
        </span>
        <ArrowRightIcon size={14} />
      </button>
    );
  }

  const term = query.trim();
  let index = 0;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <Dialog size="lg" className="command-dialog">
        <Dialog.Title className="sr-only">Search Gitflare</Dialog.Title>
        <Dialog.Description className="sr-only">
          Find pages, settings, actions, repositories, proposals and docs. Use the arrow keys to select a result and Enter to open it.
        </Dialog.Description>
        <div className="command-input">
          <MagnifyingGlassIcon size={20} />
          <Input
            autoFocus
            aria-label="Search pages, actions, repositories and docs"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flat[selected] ? `${listId}-${selected}` : undefined}
            placeholder="Search or jump to…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
              event.preventDefault();
              const next = paletteKey(event.key, selected, flat.length);
              setSelected(next.selected);
              if (next.choose) choose(flat[next.selected]);
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="command-results" role="listbox" id={listId} aria-label="Search results">
          {groups.length ? (
            groups.map((group) => (
              <div key={group.section} role="group" aria-labelledby={`${listId}-${group.section}`} className="command-group">
                <div className="command-group-label" id={`${listId}-${group.section}`} role="presentation">{group.label}</div>
                {group.entries.map((entry) => row(entry, index++))}
              </div>
            ))
          ) : term ? (
            <>
              <div className="command-empty">No results for “{term}”</div>
              <div role="group" aria-label="Suggestions" className="command-group">
                {suggestions.map((entry, position) => row(entry, position))}
              </div>
            </>
          ) : (
            <div className="command-empty">Type to search pages, settings and docs.</div>
          )}
        </div>
        <div className="command-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to navigate
          </span>
          <span>
            <kbd>↵</kbd> to open
          </span>
          <span aria-live="polite">{resultCountLabel(count)}</span>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
