import { useState, type CSSProperties } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import type { IssueLabelDefinition, IssuePerson } from "../shared/types";

export const LABEL_SWATCHES = ["#d73a4a", "#e99695", "#f9a825", "#fbca04", "#0e8a16", "#1d76db", "#5319e7", "#b60205", "#0075ca", "#6b7280"] as const;

export function labelStyle(color: string | undefined): CSSProperties | undefined {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return undefined;
  return { "--issue-label-color": color } as CSSProperties;
}

export function definitionFor(definitions: IssueLabelDefinition[] | undefined, name: string): IssueLabelDefinition | undefined {
  return definitions?.find(item => item.name.toLowerCase() === name.toLowerCase());
}

export function LabelChip({ name, definitions }: { name: string; definitions?: IssueLabelDefinition[] }) {
  const definition = definitionFor(definitions, name);
  return <span className={`issue-label${definition ? " issue-label-colored" : ""}`} style={labelStyle(definition?.color)} title={definition?.description || undefined}>{name}</span>;
}

export function Labels({ labels, definitions }: { labels: string[]; definitions?: IssueLabelDefinition[] }) {
  return labels.length ? <span className="issue-labels">{labels.map(label => <LabelChip key={label} name={label} definitions={definitions} />)}</span> : null;
}

export function personLabel(id: string, people: Record<string, IssuePerson> | undefined, names?: Map<string, string>, self?: string): string {
  if (id === "gitflare") return "Gitflare";
  const person = people?.[id];
  if (person?.handle) return `@${person.handle}`;
  return names?.get(id) ?? person?.name ?? (id === self ? "You" : "Someone");
}

export function ReasonDialog<T extends string>({ open, title, description, reasons, confirmLabel, tone = "primary", busy, onCancel, onConfirm }: { open: boolean; title: string; description: string; reasons: readonly T[]; confirmLabel: string; tone?: "primary" | "danger"; busy?: boolean; onCancel: () => void; onConfirm: (reason: T) => void }) {
  const [reason, setReason] = useState<T>(reasons[0]!);
  return <Dialog.Root open={open} onOpenChange={value => { if (!value && !busy) onCancel(); }}>
    <Dialog size="sm" className="dialog-content confirm-dialog">
      <Dialog.Title className="dialog-title">{title}</Dialog.Title>
      <Dialog.Description className="dialog-description">{description}</Dialog.Description>
      <div className="form-field issue-reason-field"><label htmlFor="issue-reason">Reason</label><select id="issue-reason" value={reason} onChange={event => setReason(event.target.value as T)}>{reasons.map(item => <option key={item} value={item}>{item[0]!.toUpperCase() + item.slice(1).replace(/-/g, " ")}</option>)}</select></div>
      <div className="dialog-actions confirm-dialog-actions">
        <Button variant="secondary" size="base" type="button" disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button variant={tone === "danger" ? "destructive" : "primary"} size="base" type="button" loading={busy} onClick={() => onConfirm(reason)}>{confirmLabel}</Button>
      </div>
    </Dialog>
  </Dialog.Root>;
}
