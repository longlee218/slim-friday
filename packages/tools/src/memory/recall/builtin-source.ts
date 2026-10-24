import type { MemoryIndexStore, RecallSource } from "@friday/core";

/** Id of the builtin source in `RecallHit.source`. */
export const BUILTIN_SOURCE_ID = "builtin";

/** The builtin source: BM25 over the index. `where` is `memory`, or the journal day of the hit. */
export function builtinSource(store: MemoryIndexStore): RecallSource {
  return {
    id: BUILTIN_SOURCE_ID,
    search: async (q) =>
      store.searchText(q.owner, q.text, q.limit).map((c) => ({
        source: BUILTIN_SOURCE_ID,
        where: c.docId === "memory" ? "memory" : c.docId.replace(/^journal\//, ""),
        ref: c.ref,
        text: c.text,
        score: c.score,
        ...(c.at ? { at: c.at } : {}),
        path: c.path,
      })),
  };
}
