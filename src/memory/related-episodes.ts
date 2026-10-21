import type { Database } from "bun:sqlite";
import {
  EPISODE_ABSTRACT_CHARS,
  INJECT_MAX_CHARS,
  INJECT_MAX_HITS,
  INJECT_MIN_TERMS,
} from "../config/memory-caps";
import { logEvent, logger } from "../observability/logger";
import { clip, errText, redactText } from "../observability/redact";
import { episodesOfChannel } from "../storage/episode-store";
import { summaryPath } from "../storage/thread-summary-store";
import { monthDay } from "./channel-digest";
import { queryTerms } from "./index/fold-text";
import { SEARCH_MAX_QUERY_CHARS, SEARCH_MAX_TERMS, searchIndex } from "./index/memory-search";
import { RELATED_HEADING } from "./related-heading";

const log = logger.child({ module: "related-episodes" });

export { RELATED_HEADING };

/** Extra hits fetched so the current thread's own episode and weak matches can be dropped and 3 still remain. */
const FETCH_SLACK = 3;
/** Position-based thread id of a summary hit id (`summary/<threadId>@<cycle>`). */
const ID_PREFIX_LEN = summaryPath("").length;

/** Thread id inside a summary hit id. */
const threadOfHit = (id: string): string => id.slice(ID_PREFIX_LEN, id.lastIndexOf("@"));

/**
 * Per-turn "related earlier threads" block of the lead: the episode abstracts of the run's channel that best match the
 * owner's text, from the FTS index only (no model call, no vectors).
 * Rules: no channel = nothing; the owner text needs `INJECT_MIN_TERMS` searchable terms; an episode must share that
 * many terms; the current thread's own episode is skipped; at most `INJECT_MAX_HITS` lines and `INJECT_MAX_CHARS`
 * chars. Abstracts are redacted and clipped. Empty string = no block. Never throws (a failure is a warn log).
 */
export function relatedEpisodesBlock(
  db: Database,
  p: { workspace: string; channel: string | undefined; threadId: string; text: string },
): string {
  if (!p.channel) return "";
  const t0 = Date.now();
  try {
    const terms = queryTerms(p.text, SEARCH_MAX_QUERY_CHARS, SEARCH_MAX_TERMS);
    if (terms.length < INJECT_MIN_TERMS) return "";
    const { hits } = searchIndex(db, p.workspace, {
      query: p.text,
      scope: "summary",
      channel: p.channel,
      limit: INJECT_MAX_HITS + FETCH_SLACK,
    });
    const ids = [...new Set(hits.map((h) => threadOfHit(h.id)).filter((id) => id !== p.threadId))];
    const byId = new Map(
      episodesOfChannel(db, p.workspace, p.channel, ids).map((e) => [e.threadId, e]),
    );
    const lines: string[] = [];
    let size = RELATED_HEADING.length;
    for (const id of ids) {
      const e = byId.get(id);
      if (!e || lines.length >= INJECT_MAX_HITS) continue;
      const label =
        clip(
          redactText(e.title ?? "")
            .replace(/\s+/g, " ")
            .trim(),
          60,
        ) || id.slice(0, 6);
      const abstract = clip(
        redactText(e.abstract).replace(/\s+/g, " ").trim(),
        EPISODE_ABSTRACT_CHARS,
      );
      // Shared-term rule: BM25 over OR terms returns one-word matches too. Terms are counted as whole TOKENS (same
      // split and fold as the query) of the text that is SHOWN (title + abstract), so what the lead reads always
      // explains why the line is there ("ai" never matches "main"; a term found only deep in the summary does not count).
      const shown = new Set(queryTerms(`${label} ${abstract}`, Number.MAX_SAFE_INTEGER, Infinity));
      if (terms.filter((t) => shown.has(t)).length < INJECT_MIN_TERMS) continue;
      const line = `- ${monthDay(e.updatedAt)} ${label}: ${abstract}`;
      if (size + line.length + 1 > INJECT_MAX_CHARS) continue; // too long: a shorter one may still fit
      lines.push(line);
      size += line.length + 1;
    }
    logEvent(log, "memory.inject", {
      terms: terms.length,
      hits: lines.length,
      chars: size,
      ms: Date.now() - t0,
    });
    return lines.length ? `${RELATED_HEADING}\n${lines.join("\n")}` : "";
  } catch (err) {
    logEvent(log, "memory.inject_failed", { err: errText(err, 200) }, "warn");
    return "";
  }
}
