import { useEffect, useState } from "react";

/** Wall clock that ticks every second while mounted; `fixed` (tests) turns the timer off and is returned as is. */
export function useNow(fixed?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [fixed]);
  return fixed ?? now;
}
