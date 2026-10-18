import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { InfoIcon } from "@phosphor-icons/react";
import "./info-tip.css";

export default function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) { setOpen(false); setPinned(false); } };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <span className="info-tip" ref={root} onMouseEnter={() => setOpen(true)} onMouseLeave={() => { if (!pinned) setOpen(false); }}>
    <button type="button" className="info-tip-button" aria-label={`About ${label}`} aria-expanded={open} aria-describedby={open ? id : undefined}
      onClick={() => { setPinned(!pinned); setOpen(!pinned); }}
      onFocus={() => setOpen(true)} onBlur={() => { if (!pinned) setOpen(false); }}
      onKeyDown={event => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); setPinned(false); } }}>
      <InfoIcon size={14} aria-hidden="true" />
    </button>
    {open && <span role="tooltip" id={id} className="info-tip-bubble">{children}</span>}
  </span>;
}
