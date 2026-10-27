import { CheckIcon } from "@phosphor-icons/react";
import { checkIdentity, requirableCheck, type RequirableCheck } from "../shared/checks";
import "./info-tip.css";

export const CHECKS_TIP = "A change lands only after these pass on the exact revision that lands. Tests run the repository's tests on it. Visual checks are offered once they run in this repository.";

export const requiredCheckLabel = (name: string): string => requirableCheck(name)?.label ?? name;

export default function CheckChips({ offered, selected, disabled, label, onChange }: { offered: readonly RequirableCheck[]; selected: string[]; disabled?: boolean; label: string; onChange: (names: string[]) => void }) {
  const chosen = new Set(selected.map(checkIdentity));
  const offeredNames = new Set(offered.map(check => check.name));
  const retired = [...chosen].filter(name => !offeredNames.has(name));
  const toggle = (name: string) => onChange(chosen.has(name) ? selected.filter(item => checkIdentity(item) !== name) : [...selected, name]);
  return <div className="check-chips" role="group" aria-label={label}>
    {offered.map(check => {
      const on = chosen.has(check.name);
      return <button key={check.name} type="button" className="check-chip" aria-pressed={on} title={check.name} disabled={disabled} onClick={() => toggle(check.name)}>
        {on && <CheckIcon size={12} weight="bold" aria-hidden="true" />}{check.label}
      </button>;
    })}
    {retired.map(name => <button key={name} type="button" className="check-chip check-chip-retired" aria-pressed="true" title={name} disabled={disabled} onClick={() => toggle(name)}>
      <CheckIcon size={12} weight="bold" aria-hidden="true" />{requiredCheckLabel(name)}<span className="check-chip-note"> {requirableCheck(name) ? "(not seen recently)" : "(no longer runs)"}</span>
    </button>)}
  </div>;
}
