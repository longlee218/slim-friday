import type { RecentMessage } from "../intent/intent-types";
import { cleanRecent, RECENT_COUNT } from "../intent/recent-messages";
import { parseMessageCommand } from "../orchestrator/message-commands";

/** Longest wait (ms) for the thread history; the message then goes on without it. */
export const FETCH_RECENT_TIMEOUT_MS = 1500;
/** Messages fetched: a little more than shown, because the current message and foreign authors are skipped. */
const FETCH_EXTRA = 2;
/** Longest text of one message of the rollover history (summary / extract input; the intent layer's own is shorter). */
export const HISTORY_CHARS = 1000;

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
  count = RECENT_COUNT,
  chars?: number,
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
  return cleanRecent(rows, count, chars);
}

/** Read the thread history from Discord. Never throws: a failed fetch is no history (the intent layer still works). */
export async function fetchRecent(
  channel: HistoryChannel,
  p: { currentId: string; ownerId: string; botId: string },
  count = RECENT_COUNT,
  chars?: number,
): Promise<RecentMessage[]> {
  try {
    const got = await channel.messages.fetch({ limit: count + FETCH_EXTRA });
    return toRecent(got.values(), p, count, chars);
  } catch {
    return [];
  }
}

/**
 * The thread history for the intent layer. Skipped for commands (slash or legacy: `/stop` must be instant) and
 * raced against FETCH_RECENT_TIMEOUT_MS: a hang or an error is no history, the message still proceeds.
 */
export const recentFor = (
  ch: Parameters<typeof fetchRecent>[0],
  id: string,
  ids: { ownerId: string; botId: string },
  text: string,
) =>
  parseMessageCommand(text).kind !== "message"
    ? []
    : Promise.race([
        fetchRecent(ch, { currentId: id, ...ids }),
        new Promise<never[]>((r) => setTimeout(() => r([]), FETCH_RECENT_TIMEOUT_MS).unref()),
      ]);

/** The thread's last `limit` messages, whoever is current (nothing excluded); the bot's own reply included. */
export const historyOf = (
  ch: HistoryChannel,
  ownerId: string,
  botId: string | undefined,
  limit: number,
) =>
  botId
    ? fetchRecent(ch, { currentId: "", ownerId, botId }, limit, HISTORY_CHARS)
    : Promise.resolve([]);
