import type { Database } from "bun:sqlite";
import { TEAMMATE_REPLAY_MAX_AGE_MS } from "../../config/teammate-caps";
import { redactText } from "../../observability/redact";
import { appendEvent, listUndelivered, markDeliveredIds } from "../../storage/thread-event-store";
import type { TeammateInput } from "./teammate-queue";

/* The `owner_message` events of the teammate: one per owner message, id = prefix + ingress message id, so the run that reads
   an input closes exactly its events, an input dropped on purpose is closed, and a boot replays only what is left. */

/** Id prefix of an `owner_message` event (followed by the ingress message id). */
const OWNER_EVENT_PREFIX = "owner:";

/** Chars of an owner message kept in its event: a boot replay answers from this text (Discord's own limit is 4000). */
const OWNER_EVENT_TEXT_CHARS = 4000;

/** Event ids of the owner messages an input carries. */
export const ownerEventIds = (messageIds: readonly string[]): string[] =>
  messageIds.map((m) => `${OWNER_EVENT_PREFIX}${m}`);

/** Append the `owner_message` event of one owner message (text redacted: no secrets at rest). */
export function appendOwnerEvent(
  db: Database,
  m: { threadId: string; messageId: string; text: string },
): void {
  appendEvent(db, {
    id: `${OWNER_EVENT_PREFIX}${m.messageId}`,
    threadId: m.threadId,
    kind: "owner_message",
    payload: { text: redactText(m.text.slice(0, OWNER_EVENT_TEXT_CHARS)) },
  });
}

/** Close the owner events of an input dropped on purpose (`/stop`, cap, refusal): a boot must not replay them. */
export function closeOwnerEvents(db: Database, messageIds: readonly string[]): void {
  markDeliveredIds(db, ownerEventIds(messageIds));
}

/**
 * Boot: the owner messages a crash left unanswered (debounce, queue or slot wait) become owner inputs again. One older
 * than `TEAMMATE_REPLAY_MAX_AGE_MS` is closed instead (the owner has moved on, never answered).
 */
export function replayOwnerInputs(
  db: Database,
  threadId: string,
  now = Date.now(),
): TeammateInput[] {
  const inputs: TeammateInput[] = [];
  for (const e of listUndelivered(db, threadId)) {
    if (e.kind !== "owner_message") continue;
    if (now - e.createdAt > TEAMMATE_REPLAY_MAX_AGE_MS) {
      markDeliveredIds(db, [e.id]);
      continue;
    }
    inputs.push({
      threadId,
      kind: "owner",
      messageIds: [e.id.slice(OWNER_EVENT_PREFIX.length)],
      text: String((e.payload as { text?: unknown } | null)?.text ?? ""),
    });
  }
  return inputs;
}
