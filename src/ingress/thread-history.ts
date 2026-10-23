import { parseMessageCommand } from "../orchestrator/message-commands";
import type { RecentMessage } from "./intent-types";
import { cleanRecent, RECENT_COUNT } from "./recent-messages";

/** Longest wait (ms) for the thread history; the message then goes on without it. */
export const FETCH_RECENT_TIMEOUT_MS = 1500;
/** Messages fetched: a little more than shown, because the current message and foreign authors are skipped. */
const FETCH_EXTRA = 2;

/** The part of a Discord message the history needs (a real `Message` fits; tests pass plain objects). */
export interface HistoryMessage {
  id: string;
  author: { id: string };
  content: string;
  createdTimestamp: number;
  attachments?: { size: number };
  /** Components-v2 layout (a question, approval or report has no `content`): its text displays are the message text. */
  components?: readonly unknown[];
}

/** Type id of a text display component (Discord `ComponentType.TextDisplay`). */
const TEXT_DISPLAY = 10;

/** The text of every text display in a components-v2 tree (containers and sections nest), in order, joined by a space. */
export function componentsText(nodes: readonly unknown[] | undefined): string {
  const out: string[] = [];
  const walk = (list: readonly unknown[] | undefined) => {
    for (const n of list ?? []) {
      const c = n as { type?: number; content?: string; components?: readonly unknown[] };
      if (c.type === TEXT_DISPLAY && c.content) out.push(c.content);
      walk(c.components);
    }
  };
  walk(nodes);
  return out.join(" ");
}

/** The part of a thread channel the history needs. */
export interface HistoryChannel {
  messages: { fetch(options: { limit: number }): Promise<{ values(): Iterable<HistoryMessage> }> };
}

/** Marker for an attachment: the file content never reaches the model through the history. */
const FILE_MARKER = "[file]";

/**
 * The thread's last messages before the current one, oldest first, as DATA: owner and bot only
 * (anyone else is skipped), redacted and clipped, attachments as a `[file]` marker, empty messages (embeds,
 * buttons) dropped. Pure; `fetchRecent` feeds it.
 */
export function toRecent(
  messages: Iterable<HistoryMessage>,
  p: { currentId: string; ownerId: string; botId: string },
  keep = RECENT_COUNT,
): RecentMessage[] {
  const rows: RecentMessage[] = [];
  const sorted = [...messages]
    .filter((m) => m.id !== p.currentId)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  for (const m of sorted) {
    const from = m.author.id === p.botId ? "bot" : m.author.id === p.ownerId ? "owner" : undefined;
    if (!from) continue;
    const file = (m.attachments?.size ?? 0) > 0 ? FILE_MARKER : "";
    rows.push({ from, text: `${m.content || componentsText(m.components)} ${file}`.trim() });
  }
  return cleanRecent(rows, keep);
}

/** Read the thread history from Discord. Never throws: a failed fetch is no history (the run still works). */
export async function fetchRecent(
  channel: HistoryChannel,
  p: { currentId: string; ownerId: string; botId: string },
  keep = RECENT_COUNT,
): Promise<RecentMessage[]> {
  try {
    const got = await channel.messages.fetch({ limit: keep + FETCH_EXTRA });
    return toRecent(got.values(), p, keep);
  } catch {
    return [];
  }
}

/**
 * The thread history for the teammate. Skipped for commands (`/stop` must be instant) and
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
