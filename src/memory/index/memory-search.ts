import type { Database } from "bun:sqlite";
import { redactText } from "../../observability/redact";
import { buildMatch, queryTerms } from "./fold-text";
import type { Source } from "./memory-ids";

/** Query limits (named constants, one place). */
const SEARCH_MAX_QUERY_CHARS = 200;
const SEARCH_MAX_TERMS = 12;
/** Length of a snippet, in characters (the FTS5 token window is wider; the text is clipped after). */
const SNIPPET_CHARS = 200;
const SNIPPET_TOKENS = 32;
/** Longest shown section / block label. */
const LABEL_CHARS = 80;

export interface SearchArgs {
  query: string;
  scope?: Source;
  kind?: string;
  /** `YYYY-MM-DD`: only entries with this date or later. */
  since?: string;
  limit: number;
  /** Location names of the run's registry: hits of any other location are left out. */
  locations: string[];
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
function origSnippet(snip: string, folded: string, orig: string): string {
  const core = snip.replace(/^\.\.\./, "").replace(/\.\.\.$/, "");
  const at = core === "" ? -1 : folded.indexOf(core);
  const text = at >= 0 ? orig.slice(at, at + core.length) : orig;
  const lead = at > 0 ? "..." : "";
  return (lead + text).replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
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
  // Location entries only for locations the run knows (the id prefix before '#' is `location/<name>`).
  if (a.locations.length) {
    where.push(
      `(source <> 'location' OR substr(id, 1, instr(id, '#') - 1) IN (${a.locations.map(() => "?").join(", ")}))`,
    );
    params.push(...a.locations.map((r) => `location/${r}`));
  } else where.push("source <> 'location'");
  // Channel entries only for the run's own channel (id prefix `channel/<name>`).
  if (a.channel)
    where.push("(source <> 'channel' OR substr(id, 1, instr(id, '#') - 1) = ?)"),
      params.push(`channel/${a.channel}`);
  else where.push("source <> 'channel'");
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
  const hits = rows.map((r) => ({
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
