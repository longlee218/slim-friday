import type { MessageIndexStore, Store } from "@friday/core";

/** Messages read from the engine db per round. */
const BATCH = 500;

/**
 * Index every stored message newer than the index's last id, in rounds of 500 (ids only grow, so this is
 * all that changed). Returns how many were added; running it again with nothing new adds 0.
 */
export async function catchUpMessages(
  source: Pick<Store["messages"], "after">,
  index: MessageIndexStore,
): Promise<number> {
  let added = 0;
  for (;;) {
    const rows = await source.after(index.lastMessageId(), BATCH);
    if (!rows.length) return added;
    index.addMessages(rows);
    added += rows.length;
  }
}
