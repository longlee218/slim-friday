/*
 * Orchestrate ask_owner questions that wait for the owner right now, by the Discord message that carries them. A reply to that message
 * answers the task directly (see `answerReply`); this registry lets that reply also end the lead's ask: the buttons go away
 * and the lead run is released with the owner's text instead of blocking until the ask times out.
 */

/** Question message id -> callback that ends its ask with the owner's reply text. */
const asks = new Map<string, (text: string) => void>();

/** Register a waiting ask under its message id. Returns the unregister (call it when the ask ends, whatever the cause). */
export function registerAsk(messageId: string, onReply: (text: string) => void): () => void {
  asks.set(messageId, onReply);
  return () => {
    if (asks.get(messageId) === onReply) asks.delete(messageId);
  };
}

/** The owner replied to that message: end its waiting ask with `text`. Returns false when no ask waits on it. */
export function closeAsk(messageId: string, text: string): boolean {
  const onReply = asks.get(messageId);
  if (!onReply) return false;
  asks.delete(messageId);
  onReply(text);
  return true;
}
