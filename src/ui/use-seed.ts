import { useRef, useState } from "react";
import { seeded, type Seeded } from "./page-context";

export function useSeed<T>(url: string | null): [Seeded<T> | undefined, () => boolean] {
  const [seed] = useState(() => seeded<T>(url));
  const pending = useRef(!!seed);
  return [seed, () => {
    const skip = pending.current;
    pending.current = false;
    return skip;
  }];
}
