import type { RecallHit } from "@friday/core";

/** Reciprocal rank fusion constant: a larger k flattens the gap between ranks. */
const RRF_K = 60;

/**
 * Reciprocal rank fusion of ranked lists: a hit scores the sum of `1 / (60 + rank)` over the lists that hold it
 * (rank from 1), so one found by several sources beats one found first by a single source. The same `where`, `ref`
 * and `text` is one hit (the first seen is kept, with the fused score). Equal scores keep first-seen order.
 */
export function fuse(lists: RecallHit[][], limit: number): RecallHit[] {
  const merged = new Map<string, RecallHit>();
  for (const list of lists)
    list.forEach((h, i) => {
      const key = `${h.where}\u0000${h.ref}\u0000${h.text}`;
      const add = 1 / (RRF_K + i + 1);
      const have = merged.get(key);
      if (have) have.score += add;
      else merged.set(key, { ...h, score: add });
    });
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
