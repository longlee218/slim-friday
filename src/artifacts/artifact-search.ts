import type { Database } from "bun:sqlite";
import { buildMatch, queryTerms } from "../memory/index/fold-text";
import {
  origSnippet,
  SEARCH_MAX_QUERY_CHARS,
  SEARCH_MAX_TERMS,
  SNIPPET_TOKENS,
} from "../memory/index/memory-search";
import { ftsSearch } from "../storage/artifact-store";

/** One artifact found by a search: the best chunk of it as a snippet in the original spelling. */
export interface ArtifactHit {
  artifactId: string;
  title: string;
  kind: string;
  origin: string;
  path: string;
  location: string | null;
  version: number;
  snippet: string;
  /** BM25 negated: higher is better. */
  score: number;
}

/**
 * Ranked keyword search over the artifacts of ONE workspace (and one channel when given). The scope comes from the run,
 * never from the model; the query is folded like the index and reduced to quoted terms joined by OR (no FTS syntax can get
 * in), so "giao an" finds "giáo án". One hit per artifact (its best chunk). `terms` 0 = no searchable word (no SQL run).
 */
export function searchArtifacts(
  db: Database,
  workspace: string,
  q: {
    query: string;
    channel?: string;
    /** Lookup filters; `since` is epoch ms. */
    goalId?: string;
    threadId?: string;
    since?: number;
    limit: number;
  },
): { hits: ArtifactHit[]; terms: number } {
  const terms = queryTerms(q.query, SEARCH_MAX_QUERY_CHARS, SEARCH_MAX_TERMS);
  if (terms.length === 0) return { hits: [], terms: 0 };
  // Several chunks of one artifact may rank high: over-fetch, keep the best per artifact, then cut to the limit.
  const rows = ftsSearch(db, {
    match: buildMatch(terms),
    workspace,
    ...(q.channel !== undefined && { channel: q.channel }),
    ...(q.goalId !== undefined && { goalId: q.goalId }),
    ...(q.threadId !== undefined && { threadId: q.threadId }),
    ...(q.since !== undefined && { since: q.since }),
    limit: q.limit * 4,
    snippetTokens: SNIPPET_TOKENS,
  });
  const seen = new Set<string>();
  const hits: ArtifactHit[] = [];
  for (const r of rows) {
    if (seen.has(r.artifactId)) continue;
    seen.add(r.artifactId);
    hits.push({
      artifactId: r.artifactId,
      title: r.title,
      kind: r.kind,
      origin: r.origin,
      path: r.path,
      location: r.location,
      version: r.version,
      snippet: origSnippet(r.snip, r.folded, r.orig),
      score: Math.round(-r.rank * 100) / 100,
    });
    if (hits.length >= q.limit) break;
  }
  return { hits, terms: terms.length };
}
