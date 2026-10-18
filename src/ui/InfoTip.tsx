import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { InfoIcon } from "@phosphor-icons/react";
import "./info-tip.css";

const BUBBLE_WIDTH = 300;

export default function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  function show() {
    const rect = button.current?.getBoundingClientRect();
    if (rect && window.innerWidth > 600) setStyle({ top: rect.bottom + 6, left: Math.max(16, Math.min(rect.left - 8, window.innerWidth - BUBBLE_WIDTH - 16)) });
    else setStyle({});
    setOpen(true);
  }
  function hide() { setOpen(false); setPinned(false); }

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) hide(); };
    const scroll = () => hide();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", scroll);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", scroll); };
  }, [open]);

  return <span className="info-tip" ref={root} onMouseEnter={show} onMouseLeave={() => { if (!pinned) setOpen(false); }}>
    <button type="button" ref={button} className="info-tip-button" aria-label={`About ${label}`} aria-expanded={open} aria-describedby={open ? id : undefined}
      onClick={event => { event.preventDefault(); if (pinned) hide(); else { show(); setPinned(true); } }}
      onFocus={show} onBlur={() => { if (!pinned) setOpen(false); }}
      onKeyDown={event => { if (event.key === "Escape" && open) { event.stopPropagation(); hide(); } }}>
      <InfoIcon size={14} aria-hidden="true" />
    </button>
    {open && <span role="tooltip" id={id} className="info-tip-bubble" style={style}>{children}</span>}
  </span>;
}
