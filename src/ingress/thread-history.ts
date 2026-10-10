import type { RecentMessage } from "../intent/intent-types";
import { cleanRecent, RECENT_COUNT } from "../intent/recent-messages";

/** Messages fetched: a little more than shown, because the current message and foreign authors are skipped. */
const FETCH_LIMIT = RECENT_COUNT + 2;

/** The part of a Discord message the history needs (a real `Message` fits; tests pass plain objects). */
export interface HistoryMessage {
  id: string;
  author: { id: string };
  content: string;
  createdTimestamp: number;
  attachments?: { size: number };
}

/** The part of a thread channel the history needs. */
export interface HistoryChannel {
  messages: { fetch(options: { limit: number }): Promise<{ values(): Iterable<HistoryMessage> }> };
}

/** Marker for an attachment: the file content never reaches the intent layer through the history. */
const FILE_MARKER = "[file]";

/**
 * The thread's last messages before the current one, oldest first, as intent-layer DATA: owner and bot only
 * (anyone else is skipped), redacted and clipped, attachments as a `[file]` marker, empty messages (embeds,
 * buttons) dropped. Pure; `fetchRecent` feeds it.
 */
export function toRecent(
  messages: Iterable<HistoryMessage>,
  p: { currentId: string; ownerId: string; botId: string },
): RecentMessage[] {
  const rows: RecentMessage[] = [];
  const sorted = [...messages]
    .filter((m) => m.id !== p.currentId)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  for (const m of sorted) {
    const from = m.author.id === p.botId ? "bot" : m.author.id === p.ownerId ? "owner" : undefined;
    if (!from) continue;
    const file = (m.attachments?.size ?? 0) > 0 ? FILE_MARKER : "";
    rows.push({ from, text: `${m.content} ${file}`.trim() });
  }
  return cleanRecent(rows);
}

/** Read the thread history from Discord. Never throws: a failed fetch is no history (the intent layer still works). */
export async function fetchRecent(
  channel: HistoryChannel,
  p: { currentId: string; ownerId: string; botId: string },
): Promise<RecentMessage[]> {
  try {
    const got = await channel.messages.fetch({ limit: FETCH_LIMIT });
    return toRecent(got.values(), p);
  } catch {
    return [];
  }
}
