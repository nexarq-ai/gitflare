import { useCallback, useRef, useState, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import type { ConfirmFact, ConfirmPrompt } from "./deploy-progress";

export type { ConfirmPrompt };

export function ConfirmFacts({ facts }: { facts: ConfirmFact[] }) {
  return <dl className="confirm-facts">{facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd title={fact.title}>{fact.code ? <code>{fact.value}</code> : fact.value}</dd></div>)}</dl>;
}

export function ConfirmActions({ prompt, onCancel, onConfirm }: { prompt: ConfirmPrompt; onCancel: () => void; onConfirm: () => void }) {
  return <div className="dialog-actions confirm-dialog-actions">
    <Button variant="secondary" size="base" type="button" onClick={onCancel}>Cancel</Button>
    <Button variant={prompt.tone === "danger" ? "destructive" : "primary"} size="base" type="button" onClick={onConfirm}>{prompt.confirmLabel}</Button>
  </div>;
}

export default function ConfirmDialog({ prompt, open = prompt !== null, onResolve }: { prompt: ConfirmPrompt | null; open?: boolean; onResolve: (confirmed: boolean) => void }) {
  return <Dialog.Root role="alertdialog" open={open} onOpenChange={(open) => { if (!open) onResolve(false); }}>
    <Dialog size="sm" className="dialog-content confirm-dialog">
      {prompt && <>
        <Dialog.Title className="dialog-title">{prompt.title}</Dialog.Title>
        <Dialog.Description className="dialog-description">{prompt.description}</Dialog.Description>
        {prompt.facts?.length ? <ConfirmFacts facts={prompt.facts} /> : null}
        <ConfirmActions prompt={prompt} onCancel={() => onResolve(false)} onConfirm={() => onResolve(true)} />
      </>}
    </Dialog>
  </Dialog.Root>;
}

export function useConfirm(): [(prompt: ConfirmPrompt) => Promise<boolean>, ReactNode] {
  const [prompt, setPrompt] = useState<ConfirmPrompt | null>(null);
  const [open, setOpen] = useState(false);
  const settle = useRef<((confirmed: boolean) => void) | null>(null);
  const confirm = useCallback((next: ConfirmPrompt) => new Promise<boolean>((resolve) => {
    settle.current?.(false);
    settle.current = resolve;
    setPrompt(next);
    setOpen(true);
  }), []);
  const resolve = useCallback((confirmed: boolean) => {
    settle.current?.(confirmed);
    settle.current = null;
    setOpen(false);
  }, []);
  return [confirm, <ConfirmDialog key="confirm-dialog" prompt={prompt} open={open} onResolve={resolve} />];
}
