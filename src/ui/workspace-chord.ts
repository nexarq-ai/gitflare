const CHORD_WINDOW_MS = 1200;

export function typingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  const element = target as HTMLElement;
  return element.isContentEditable || !!element.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox'], [role='combobox']");
}

export function chordMatcher(now: () => number = Date.now, second = "w") {
  let armedAt: number | null = null;
  return (event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "target">): boolean => {
    if (event.metaKey || event.ctrlKey || event.altKey || typingTarget(event.target)) { armedAt = null; return false; }
    const key = event.key.toLowerCase();
    if (key === second && armedAt !== null && now() - armedAt <= CHORD_WINDOW_MS) { armedAt = null; return true; }
    armedAt = key === "g" ? now() : null;
    return false;
  };
}

export function workspaceChord(open: () => void, second = "w"): () => void {
  const matches = chordMatcher(Date.now, second);
  const listener = (event: KeyboardEvent) => { if (matches(event)) { event.preventDefault(); open(); } };
  window.addEventListener("keydown", listener);
  return () => window.removeEventListener("keydown", listener);
}
