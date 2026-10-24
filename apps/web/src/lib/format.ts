/** Money shown in the capsule and popover: `1.84` -> `"$1.84"`. */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** A run length: `41_000` -> `"41s"`, `520_000` -> `"8m 40s"`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/** A file size: `"512 B"`, `"212 KB"`, `"1.2 MB"`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Midnight (local) of the day `t` falls on. */
const dayStart = (t: number): number => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * Conversation time: `"14:09"` today, `"Yesterday"`, a weekday (`"Tue"`) within 7 days,
 * else `"12 Oct"`. Days are counted on the local calendar; rounding absorbs DST.
 */
export function formatClock(at: number, now: number): string {
  const days = Math.round((dayStart(now) - dayStart(at)) / 86_400_000);
  const d = new Date(at);
  if (days <= 0) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString("en-US", { weekday: "short" });
  return `${d.getDate()} ${d.toLocaleDateString("en-US", { month: "short" })}`;
}

/** Human type of a file: known kinds by name, else the upper-cased extension. */
export function fileTypeLabel(mime: string, name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (mime === "text/markdown" || ext === "md") return "Markdown";
  if (mime === "application/pdf" || ext === "pdf") return "PDF";
  if (mime === "image/png" || ext === "png") return "PNG image";
  return ext ? ext.toUpperCase() : "File";
}
