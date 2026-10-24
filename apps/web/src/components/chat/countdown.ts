import { useEffect, useState } from "react";

/** Current time, refreshed every second while the component is mounted. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * Auto-deny countdown: `(581_000, 0)` -> `"Auto-denies in 9:41"` (m:ss, never below 0:00);
 * `""` when the card never expires.
 */
export function countdown(expiresAt: number | undefined, now: number): string {
  if (expiresAt === undefined) return "";
  const s = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `Auto-denies in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
