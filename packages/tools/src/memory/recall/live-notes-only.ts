import type { RecallSource } from "@friday/core";
import type { FileMemory } from "../file-memory";

/**
 * A provider source whose hits are kept only while their text is still a note in the owner's `MEMORY.md`.
 * The file is the truth: a note deleted or replaced while the provider was down (its `forget` failed) must not come
 * back through recall. Write and forget pass through unchanged.
 */
export function liveNotesOnly(
  source: RecallSource,
  memory: Pick<FileMemory, "listBullets">,
): RecallSource {
  return {
    ...source,
    async search(q) {
      const hits = await source.search(q);
      const live = new Set(memory.listBullets(q.owner).map((b) => b.text));
      return hits.filter((h) => live.has(h.text));
    },
  };
}
