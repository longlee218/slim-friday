import type { IdleClose, MemoryOwner, Store, StoredMessage } from "@friday/core";
import { appendJournal } from "@friday/tools";
import { logJournalAppend } from "./journal-append-log";

/** Messages read per conversation of the closed session. */
const RECENT = 200;
/** Longest transcript sent to the note call (its end is kept). */
const MAX_TRANSCRIPT = 20000;

/** What the idle flush needs. */
export interface IdleFlushDeps {
  store: Pick<Store, "messages">;
  /** Root of the memory files (`<agentHome>/memory`). */
  memoryRoot: string;
  /** Notes worth keeping from a transcript (a one-turn model call). */
  flushNotes: (transcript: string) => Promise<string[]>;
  /** Tell the index the bot's journal changed. */
  memoryChanged: (owner: MemoryOwner) => void;
  log: { error(o: object, msg: string): void; warn(o: object, msg: string): void };
}

/** `author: text`, with the bot's id for a bot. */
const lineOf = (m: StoredMessage): string =>
  `${m.author.kind === "bot" ? m.author.botId : m.author.kind}: ${m.text}`;

/**
 * The hub's `onIdleClose`: the messages of the closed session (its conversations, since it opened) go to
 * `flushNotes`, and the notes into today's journal as an `Idle flush` block: the group's for a group session, else the
 * bot's. Fewer than 2 messages make
 * no call. A failure is logged, never thrown.
 */
export function idleFlush(deps: IdleFlushDeps) {
  return async (e: IdleClose): Promise<void> => {
    try {
      const all: StoredMessage[] = [];
      for (const c of e.conversationIds)
        for (const m of await deps.store.messages.recent(c, RECENT))
          if (m.at >= e.since) all.push(m);
      if (all.length < 2) return;
      all.sort((a, b) => a.at - b.at);
      const transcript = all.map(lineOf).join("\n").slice(-MAX_TRANSCRIPT);
      const notes = await deps.flushNotes(transcript);
      const owner: MemoryOwner = e.groupId
        ? { kind: "group", groupId: e.groupId }
        : { kind: "bot", botId: e.botId };
      const r = appendJournal(deps.memoryRoot, owner, "Idle flush", notes, new Date());
      logJournalAppend(deps.log, owner, r);
      if (r.status === "saved") deps.memoryChanged(owner);
    } catch (err) {
      deps.log.error({ error: String(err), botId: e.botId }, "memory.idle_flush");
    }
  };
}
