import { CheckIcon } from "@phosphor-icons/react";
import "./info-tip.css";

export default function CheckChips({ known, selected, disabled, label, onChange }: { known: string[]; selected: string[]; disabled?: boolean; label: string; onChange: (names: string[]) => void }) {
  const names = [...new Set([...known, ...selected])];
  if (!names.length) return <p className="check-chips-empty">No checks have run yet. Their names appear here after the first proposal runs them.</p>;
  return <div className="check-chips" role="group" aria-label={label}>
    {names.map(name => {
      const on = selected.includes(name);
      return <button key={name} type="button" className="check-chip" aria-pressed={on} disabled={disabled} onClick={() => onChange(on ? selected.filter(item => item !== name) : [...selected, name])}>
        {on && <CheckIcon size={12} weight="bold" aria-hidden="true" />}{name}{!known.includes(name) && <span className="check-chip-note"> (not seen recently)</span>}
      </button>;
    })}
  </div>;
}
