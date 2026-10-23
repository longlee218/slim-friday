import type { Database } from "bun:sqlite";
import { redactText } from "../../observability/redact";
import { summaryPath } from "../../storage/thread-summary-store";
import { buildMatch, queryTerms } from "./fold-text";
import type { Source } from "./memory-ids";

/** Query limits (named constants, one place). */
export const SEARCH_MAX_QUERY_CHARS = 200;
export const SEARCH_MAX_TERMS = 12;
/** Length of a snippet, in characters (the FTS5 token window is wider; the text is clipped after). */
const SNIPPET_CHARS = 200;
export const SNIPPET_TOKENS = 32;
/** 1-based SQL position of the thread id inside a summary hit id (`summary/<threadId>@<cycle>`). */
const SUMMARY_ID_START = summaryPath("").length + 1;
/** Hits whose bm25 score is within this share of the band's best score count as near-equal: the newer date goes first. */
export const RECENCY_BAND = 0.05;
/** Longest shown section / block label. */
const LABEL_CHARS = 80;

export interface SearchArgs {
  query: string;
  scope?: Source;
  kind?: string;
  /** `YYYY-MM-DD`: only entries with this date or later. */
  since?: string;
  limit: number;
  /** Channel of the run: channel entries of any other channel are left out (none when absent). */
  channel?: string;
}

export interface Hit {
  id: string;
  source: string;
  section: string;
  kind: string;
  date: string;
  snippet: string;
  /** BM25 negated: higher is better. */
  score: number;
}

/**
 * Snippet in the ORIGINAL spelling. FTS5 cut `snip` out of the folded text; folding keeps the length, so the same
 * window of `orig` is shown. If the window cannot be located, the start of `orig` is shown.
 */
export function origSnippet(snip: string, folded: string, orig: string): string {
  const core = snip.replace(/^\.\.\./, "").replace(/\.\.\.$/, "");
  const at = core === "" ? -1 : folded.indexOf(core);
  const text = at >= 0 ? orig.slice(at, at + core.length) : orig;
  const teammate = at > 0 ? "..." : "";
  return (teammate + text).replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
}

/**
 * Recency tie-break (pure): `rows` come best-first (score = -bm25, higher is better). Walk down the list; a row whose
 * score is within RECENCY_BAND of the first row of the current band joins that band, and each band is then ordered
 * newest date first (stable, so equal dates keep the bm25 order). Bands are never mixed, so a clearly better hit
 * is never pushed below a clearly worse one.
 */
export function recencyOrder<T extends { date: string }>(
  rows: T[],
  scoreOf: (r: T) => number,
): T[] {
  const out: T[] = [];
  let band: T[] = [];
  let top = 0;
  const close = () => {
    out.push(...band.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)));
    band = [];
  };
  for (const r of rows) {
    const sc = scoreOf(r);
    if (band.length && sc < top * (1 - RECENCY_BAND)) close();
    if (band.length === 0) top = sc;
    band.push(r);
  }
  close();
  return out;
}

/**
 * Ranked keyword search over the index, for ONE workspace (plus root rows). The workspace comes from the run,
 * never from the model; the query is reduced to quoted terms joined by OR, so the model cannot inject FTS
 * syntax. `terms` = 0 means the query had no searchable word (no SQL was run).
 */
export function searchIndex(
  db: Database,
  workspace: string,
  a: SearchArgs,
): { hits: Hit[]; terms: number } {
  const terms = queryTerms(a.query, SEARCH_MAX_QUERY_CHARS, SEARCH_MAX_TERMS);
  if (terms.length === 0) return { hits: [], terms: 0 };
  const where = ["memory_fts MATCH ?", "workspace IN (?, '')"];
  const params: (string | number)[] = [buildMatch(terms), workspace];
  // Channel and journal entries only for the run's own channel (id prefix `channel/<name>`, `journal/<name>/<date>`);
  // summary entries (`summary/<threadId>@<cycle>`) only when the thread's episode belongs to that channel.
  if (a.channel) {
    where.push(
      "(source NOT IN ('channel', 'journal') OR substr(id, 1, instr(id, '#') - 1) = ? OR substr(id, 1, instr(id, '#') - 1) LIKE ?)",
      `(source <> 'summary' OR substr(id, ${SUMMARY_ID_START}, instr(id, '@') - ${SUMMARY_ID_START}) IN (SELECT thread_id FROM thread_summaries WHERE channel = ?))`,
    );
    params.push(`channel/${a.channel}`, `journal/${a.channel}/%`, a.channel);
  } else where.push("source NOT IN ('channel', 'journal', 'summary')");
  if (a.scope) where.push("source = ?"), params.push(a.scope);
  if (a.kind) where.push("kind = ?"), params.push(a.kind);
  if (a.since) where.push("date >= ?"), params.push(a.since);
  params.push(a.limit);
  const rows = db
    .query<
      {
        id: string;
        source: string;
        section: string;
        kind: string;
        date: string;
        snip: string;
        folded: string;
        orig: string;
        rank: number;
      },
      (string | number)[]
    >(
      `SELECT id, source, section, kind, date, text AS folded, orig, snippet(memory_fts, 0, '', '', '...', ${SNIPPET_TOKENS}) AS snip,
         bm25(memory_fts) AS rank
       FROM memory_fts WHERE ${where.join(" AND ")} ORDER BY rank LIMIT ?`,
    )
    .all(...params);
  // Query terms stay OR-joined; only the order of near-equal hits changes (newer first).
  const hits = recencyOrder(rows, (r) => -r.rank).map((r) => ({
    id: r.id,
    source: r.source,
    section: redactText(r.section).slice(0, LABEL_CHARS),
    kind: r.kind,
    date: r.date,
    snippet: origSnippet(r.snip, r.folded, r.orig),
    score: Math.round(-r.rank * 100) / 100,
  }));
  return { hits, terms: terms.length };
}
