import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { InfoIcon } from "@phosphor-icons/react";
import "./info-tip.css";

const GAP = 6;
const MARGIN = 12;
const SHEET_BREAKPOINT = 600;

export function placeBubble(anchor: { top: number; bottom: number; left: number; right: number }, bubble: { width: number; height: number }, viewport: { width: number; height: number }): { top: number; left: number } {
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - bubble.height;
  const top = below + bubble.height <= viewport.height - MARGIN || above < MARGIN ? Math.min(below, Math.max(MARGIN, viewport.height - MARGIN - bubble.height)) : above;
  const preferred = anchor.left - 8;
  const left = Math.max(MARGIN, Math.min(preferred, viewport.width - MARGIN - bubble.width));
  return { top, left };
}

export default function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);

  function hide() { setOpen(false); setPinned(false); }

  useLayoutEffect(() => {
    if (!open) return;
    if (window.innerWidth <= SHEET_BREAKPOINT) { setStyle({}); return; }
    const anchor = button.current?.getBoundingClientRect();
    const size = bubble.current?.getBoundingClientRect();
    if (!anchor || !size) return;
    setStyle(placeBubble(anchor, size, { width: window.innerWidth, height: window.innerHeight }));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !button.current?.contains(event.target) && !bubble.current?.contains(event.target)) hide(); };
    const dismiss = () => { if (window.innerWidth > SHEET_BREAKPOINT) hide(); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("scroll", dismiss, true); window.removeEventListener("resize", dismiss); };
  }, [open]);

  function show() { if (open) return; setStyle({ visibility: "hidden" }); setOpen(true); }

  return <span className="info-tip" onMouseEnter={show} onMouseLeave={() => { if (!pinned) setOpen(false); }}>
    <button type="button" ref={button} className="info-tip-button" aria-label={`About ${label}`} aria-expanded={open} aria-describedby={open ? id : undefined}
      onClick={event => { event.preventDefault(); if (pinned) hide(); else { show(); setPinned(true); } }}
      onFocus={show} onBlur={() => { if (!pinned) setOpen(false); }}
      onKeyDown={event => { if (event.key === "Escape" && open) { event.stopPropagation(); hide(); } }}>
      <InfoIcon size={14} aria-hidden="true" />
    </button>
    {open && createPortal(<span ref={bubble} role="tooltip" id={id} className="info-tip-bubble" style={style}>{children}</span>, document.body)}
  </span>;
}
