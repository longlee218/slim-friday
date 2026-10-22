/** USD with cents; tiny amounts keep three decimals so a $0.004 run is not "$0.00". */
export function usd(v: number | null | undefined): string {
  if (v == null) return "–";
  return v > 0 && v < 0.1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`;
}

/** 1234 -> 1.2k, 2_300_000 -> 2.3M. */
export function tokens(v: number | null | undefined): string {
  if (v == null) return "–";
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

/** Milliseconds as 850ms, 12.4s, 3m 05s, 2h 10m. */
export function dur(ms: number | null | undefined): string {
  if (ms == null) return "–";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "14:05" today, "Oct 21 14:05" otherwise. */
export function when(ms: number | null | undefined): string {
  if (!ms) return "–";
  const d = new Date(ms);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (d.toDateString() === new Date().toDateString()) return hm;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`;
}

/** "4m ago", "3h ago", "2d ago". */
export function ago(ms: number | null | undefined): string {
  if (!ms) return "–";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Parse a JSON column; a bad or empty value returns the raw text. */
export function parseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Pretty JSON for a payload panel; non-JSON text is shown as is. */
export function pretty(text: string | null | undefined): string {
  const v = parseJson(text);
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}
