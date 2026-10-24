import type { StoredMessage } from "../domain/message";
import type { Store } from "../ports/store";
import type { Surface } from "../ports/surface";

/**
 * Store a message, then post it with its row id, so every posted message can be found again
 * (replies, pagination, read marks). A failing post rejects and the row stays: history keeps it.
 */
export async function postStored(
  deps: { store: Pick<Store, "messages">; surface: Surface },
  m: StoredMessage,
): Promise<number> {
  const id = await deps.store.messages.append(m);
  await deps.surface.post(m.conversationId, { ...m, id });
  return id;
}
