import type { Database } from "bun:sqlite";
import {
  auditCounts,
  type ChannelDayCount,
  episodeCounts,
  promotedEpisodeCounts,
  promotedJournalCounts,
} from "../storage/memory-metrics-store";

/*
 * Memory metrics: counts only, never text. Sources (the db first; the log only where the db keeps no record):
 *  - saves, edits: `memory_audit` (action save, edit_delete, edit_replace).
 *  - episodes written, promoted episodes, promoted journal bullets: `thread_summaries`, `memory_promotions`.
 *  - flushes, dreams (applied, skipped, failed by reason), prunes: pino log events (`memory.flush`, `memory.dream`,
 *    `memory.dream_skipped`, `memory.dream_failed`, `memory.prune`): no table records them. Prune is global (no channel).
 * A row is a channel on a local day. The channel is the yaml name: the audit table has no workspace column.
 */

/** Counters of one channel on one day. */
export interface MemoryDayStats {
  channel: string;
  day: string;
  saves: number;
  editDeletes: number;
  editReplaces: number;
  /** Flush modes: llm, fallback, none. */
  flushes: Record<string, number>;
  episodes: number;
  dreams: number;
  /** Skipped or failed dreams by reason. */
  dreamSkips: Record<string, number>;
  promotedEpisodes: number;
  promotedJournal: number;
}

/** Everything `metrics:memory` prints. */
export interface MemoryMetrics {
  rows: MemoryDayStats[];
  /** Prune totals in the window (global: the prune job runs over all channels). */
  prune: { runs: number; episodes: number; journals: number; promotions: number };
}

const empty = (channel: string, day: string): MemoryDayStats => ({
  channel,
  day,
  saves: 0,
  editDeletes: 0,
  editReplaces: 0,
  flushes: {},
  episodes: 0,
  dreams: 0,
  dreamSkips: {},
  promotedEpisodes: 0,
  promotedJournal: 0,
});

const bump = (m: Record<string, number>, k: string): void => {
  m[k] = (m[k] ?? 0) + 1;
};

/** Local `YYYY-MM-DD` of an epoch-ms time (same day boundaries as the SQL `localtime` modifier). */
function localDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parsed log line of one of the memory events, or null (not JSON, other event, outside the window). */
function memoryEvent(line: string, sinceMs: number): Record<string, unknown> | null {
  if (!line.includes('"memory.')) return null;
  try {
    const e = JSON.parse(line) as Record<string, unknown>;
    return typeof e.event === "string" && typeof e.time === "number" && e.time >= sinceMs
      ? e
      : null;
  } catch {
    return null; // half-written last line
  }
}

/** Counts of the last `days` days: db tables plus the log lines (any iterable of JSONL text). */
export function memoryMetrics(
  db: Database,
  logLines: Iterable<string>,
  days: number,
  now = Date.now(),
): MemoryMetrics {
  const sinceMs = now - days * 86_400_000;
  const byKey = new Map<string, MemoryDayStats>();
  const at = (channel: string, day: string): MemoryDayStats => {
    const k = `${channel}\u0000${day}`;
    let r = byKey.get(k);
    if (!r) {
      r = empty(channel, day);
      byKey.set(k, r);
    }
    return r;
  };
  for (const a of auditCounts(db, sinceMs)) {
    const r = at(a.channel, a.day);
    if (a.action === "save") r.saves += a.n;
    else if (a.action === "edit_delete") r.editDeletes += a.n;
    else if (a.action === "edit_replace") r.editReplaces += a.n;
  }
  const add = (rows: ChannelDayCount[], f: (r: MemoryDayStats, n: number) => void): void => {
    for (const c of rows) f(at(c.channel, c.day), c.n);
  };
  add(episodeCounts(db, sinceMs), (r, n) => {
    r.episodes += n;
  });
  add(promotedEpisodeCounts(db, sinceMs), (r, n) => {
    r.promotedEpisodes += n;
  });
  add(promotedJournalCounts(db, sinceMs), (r, n) => {
    r.promotedJournal += n;
  });

  const prune = { runs: 0, episodes: 0, journals: 0, promotions: 0 };
  for (const line of logLines) {
    const e = memoryEvent(line, sinceMs);
    if (!e) continue;
    const day = localDay(e.time as number);
    const channel = typeof e.channel === "string" ? e.channel : "";
    if (e.event === "memory.flush") bump(at(channel, day).flushes, String(e.mode ?? "?"));
    else if (e.event === "memory.dream") at(channel, day).dreams++;
    else if (e.event === "memory.dream_skipped" || e.event === "memory.dream_failed")
      bump(at(channel, day).dreamSkips, String(e.reason ?? "?"));
    else if (e.event === "memory.prune") {
      prune.runs++;
      prune.episodes += Number(e.episodes) || 0;
      prune.journals += Number(e.journals) || 0;
      prune.promotions += Number(e.promotions) || 0;
    }
  }
  const rows = [...byKey.values()].sort(
    (a, b) => a.channel.localeCompare(b.channel) || a.day.localeCompare(b.day),
  );
  return { rows, prune };
}

const kv = (m: Record<string, number>): string =>
  Object.keys(m).length
    ? Object.entries(m)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}:${v}`)
        .join(",")
    : "-";

/** Plain-text report: one line per channel and day. */
export function formatMemoryMetrics(m: MemoryMetrics, days: number): string {
  const out = [`Memory metrics, last ${days} day(s)`];
  if (!m.rows.length) out.push("  (no memory activity)");
  for (const r of m.rows) {
    out.push(
      `${r.channel || "(unknown channel)"} ${r.day}: saves ${r.saves}, edits ${r.editDeletes + r.editReplaces} ` +
        `(delete ${r.editDeletes}, replace ${r.editReplaces}), flushes ${kv(r.flushes)}, episodes ${r.episodes}, ` +
        `dreams ${r.dreams} (skipped/failed ${kv(r.dreamSkips)}), promoted episodes ${r.promotedEpisodes}, ` +
        `promoted journal bullets ${r.promotedJournal}`,
    );
  }
  const p = m.prune;
  out.push(
    `prune (all channels): ${p.runs} run(s), episodes ${p.episodes}, journals ${p.journals}, promotions ${p.promotions}`,
    "Source: db tables for saves, edits, episodes, promotions; log for flushes, dreams, prunes. Counts only.",
  );
  return out.join("\n");
}
