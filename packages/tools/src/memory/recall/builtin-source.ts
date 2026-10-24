import type { MemoryIndexStore, MemoryOwner, RecallSource } from "@friday/core";

/** Id of the builtin source in `RecallHit.source`. */
export const BUILTIN_SOURCE_ID = "builtin";

/** The builtin source: BM25 over the index. `where` is `memory`, or the journal day of the hit. */
export function builtinSource(
  store: MemoryIndexStore,
  /** Run before each search (the app brings the owner's index up to date with the files). */
  beforeSearch?: (owner: MemoryOwner) => Promise<void>,
): RecallSource {
  return {
    id: BUILTIN_SOURCE_ID,
    search: async (q) => {
      await beforeSearch?.(q.owner);
      return store.searchText(q.owner, q.text, q.limit).map((c) => ({
        source: BUILTIN_SOURCE_ID,
        where: c.docId === "memory" ? "memory" : c.docId.replace(/^journal\//, ""),
        ref: c.ref,
        text: c.text,
        score: c.score,
        ...(c.at ? { at: c.at } : {}),
        path: c.path,
      }));
    },
  };
}
