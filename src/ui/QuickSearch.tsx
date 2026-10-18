import { repositoryLabel } from "../shared/repository-names";
import { useEffect, useId, useMemo, useState } from "react";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import {
  ArrowRightIcon,
  ArrowsLeftRightIcon,
  FolderSimpleIcon,
  GitBranchIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import type { Workspace } from "../shared/types";
import type { WorkspaceEntry } from "./WorkspaceSwitcher";

export function workspaceSwitchEntries(workspaces: WorkspaceEntry[], currentId: string) {
  return workspaces.filter(item => item.id !== currentId).map(item => ({ id: `workspace:${item.id}`, workspaceId: item.id, title: `Switch to ${item.name}`, detail: item.role ?? "", category: "Workspace" }));
}

export default function QuickSearch({
  open,
  workspace,
  workspaces = [],
  currentWorkspaceId = "",
  onClose,
  onNavigate,
  onSwitchWorkspace,
}: {
  open: boolean;
  workspace: Workspace;
  workspaces?: WorkspaceEntry[];
  currentWorkspaceId?: string;
  onClose: () => void;
  onNavigate: (route: string) => void;
  onSwitchWorkspace?: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listId = useId();
  const results = useMemo(() => {
    const term = query.trim().toLowerCase();
    const switches = onSwitchWorkspace ? workspaceSwitchEntries(workspaces, currentWorkspaceId).map(item => ({ ...item, icon: ArrowsLeftRightIcon })) : [];
    return [
      ...switches,
      ...workspace.repositories.map((repository) => ({
        id: `repository/${repository.id}`,
        title: repositoryLabel(repository),
        detail: repository.description,
        category: "Repository",
        icon: FolderSimpleIcon,
      })),
      ...workspace.missions.map((mission) => ({
        id: `mission/${mission.id}`,
        title: mission.title,
        detail:
          workspace.repositories.find(
            (repository) => repository.id === mission.repositoryId,
          )?.name ?? "",
        category: "Mission",
        icon: GitBranchIcon,
      })),
    ]
      .filter((result) =>
        `${result.title} ${result.detail}`.toLowerCase().includes(term),
      )
      .slice(0, 12);
  }, [query, workspace, workspaces, currentWorkspaceId, onSwitchWorkspace]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
    }
  }, [open]);
  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    if (open)
      document
        .getElementById(`${listId}-${selected}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [selected, open, listId]);

  function choose(index: number) {
    const result = results[index];
    if (!result) return;
    onClose();
    if ("workspaceId" in result && typeof result.workspaceId === "string") onSwitchWorkspace?.(result.workspaceId);
    else onNavigate(result.id);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <Dialog size="lg" className="command-dialog">
        <Dialog.Title className="sr-only">Search workspace</Dialog.Title>
        <Dialog.Description className="sr-only">
          Find a repository or mission. Use the arrow keys to select a result
          and Enter to open it.
        </Dialog.Description>
        <div className="command-input">
          <MagnifyingGlassIcon size={20} />
          <Input
            autoFocus
            aria-label="Search repositories and missions"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              results[selected] ? `${listId}-${selected}` : undefined
            }
            placeholder="Search repositories and missions…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((index) => Math.min(index + 1, results.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((index) => Math.max(index - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(selected);
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div
          className="command-results"
          role="listbox"
          id={listId}
          aria-label="Search results"
        >
          {results.length ? (
            results.map((result, index) => (
              <button
                key={result.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={selected === index}
                tabIndex={-1}
                className={`command-result ${selected === index ? "selected" : ""}`}
                onMouseEnter={() => setSelected(index)}
                onClick={() => choose(index)}
              >
                <result.icon size={18} />
                <span>
                  <strong>{result.title}</strong>
                  <small>
                    {result.category}
                    {result.detail ? ` · ${result.detail}` : ""}
                  </small>
                </span>
                <ArrowRightIcon size={14} />
              </button>
            ))
          ) : (
            <div className="command-empty">
              {query
                ? "No repositories or missions match your search."
                : "Create a repository or mission to find it here."}
            </div>
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
          <span>{results.length} results</span>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
