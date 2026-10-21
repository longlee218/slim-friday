import { EPISODE_ABSTRACT_CHARS, EPISODE_TOPICS_MAX } from "../config/memory-caps";
import { foldText } from "./index/fold-text";

/* Extractive abstract and key topics of an episode summary: pure code, no model (like GoClaw's abstract). */

/** Words that carry no topic (English and common Vietnamese function words, folded spelling). */
const STOPWORDS = new Set(
  (
    "the and for that this with from have has had are was were will would should could can not but you your " +
    "they them their then than when what which where who how why into onto over under about after before " +
    "also just more most some such only very been being does did done use used using need needs want wants " +
    "thread summary owner user lead worker task item " +
    "khong nhung cua cho voi mot nhieu cac nay kia nao thi la va de duoc dang da se cung nhu khi neu thanh"
  ).split(" "),
);

/** A term is a run of letters or digits, at least this long. */
const MIN_TERM_CHARS = 4;
const TERM = /[\p{L}\p{N}]+/gu;

/**
 * First sentences of `text`, whole while they fit in `max` chars (default `EPISODE_ABSTRACT_CHARS`); when even the first
 * one is longer, it is cut at `max`. Whitespace is collapsed to single spaces.
 */
export function abstractOf(text: string, max = EPISODE_ABSTRACT_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  // Sentence = text up to a `.`, `!` or `?` followed by a space (or the end).
  const sentences = flat.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [flat];
  let out = "";
  for (const s of sentences) {
    const next = out ? `${out} ${s.trim()}` : s.trim();
    if (next.length > max) break;
    out = next;
  }
  return out || flat.slice(0, max);
}

/**
 * Top `max` terms of `text` by frequency (ties: first seen first), lowercased and `đ`-folded like the index,
 * stopwords and short words out. Space separated, ready for a column and for the search index.
 */
export function keyTopics(text: string, max = EPISODE_TOPICS_MAX): string {
  const count = new Map<string, number>();
  for (const m of foldText(text).toLowerCase().matchAll(TERM)) {
    const w = m[0];
    if (w.length < MIN_TERM_CHARS || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    count.set(w, (count.get(w) ?? 0) + 1);
  }
  // Map keeps insertion order and Array.sort is stable: equal counts stay in first-seen order.
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([w]) => w)
    .join(" ");
}
