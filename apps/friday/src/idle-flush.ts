import type {
  BotId,
  FlushNote,
  GroupId,
  IdleClose,
  MemoryOwner,
  Store,
  StoredMessage,
} from "@friday/core";
import { writeFlushNotes } from "./memory-flush";
import { ownTurns } from "./own-turns";

/** Messages read per conversation of the closed session. */
const RECENT = 200;
/** Longest transcript sent to the note call (its end is kept). */
const MAX_TRANSCRIPT = 20000;

/** What the idle flush needs. */
export interface IdleFlushDeps {
  store: Pick<Store, "messages">;
  /** Root of the memory files (`<agentHome>/memory`). */
  memoryRoot: string;
  /** Notes worth keeping from a transcript (a one-turn model call), each for the bot or its group. */
  flushNotes: (
    transcript: string,
    ctx: { botId: BotId; groupId?: GroupId; known?: string },
  ) => Promise<FlushNote[]>;
  /** What config already says for the session (`knownFor`), so the call skips it. */
  known: (scope: { botId: BotId; groupId?: GroupId }) => Promise<string | undefined>;
  /** Tell the index an owner's journal changed. */
  memoryChanged: (owner: MemoryOwner) => void;
  /** Consolidate an owner's journal into MEMORY.md (through the per-owner queue); without it none after a flush. */
  consolidate?: (owner: MemoryOwner) => Promise<unknown>;
  log: { error(o: object, msg: string): void; warn(o: object, msg: string): void };
}

/** `author: text`, with the bot's id for a bot. */
const lineOf = (m: StoredMessage): string =>
  `${m.author.kind === "bot" ? m.author.botId : m.author.kind}: ${m.text}`;

/**
 * The hub's `onIdleClose`: the messages of the closed session (its conversations, since it opened; in a group only
 * this bot's turns, see `ownTurns`) go to `flushNotes`, and the notes into today's journals as an `Idle flush` block
 * (split by `writeFlushNotes`). Fewer than 2 messages make no call. Each owner written is then consolidated, not
 * awaited: its failure is logged and never fails the flush. A flush failure is logged and rethrown: the sweep then
 * leaves the scope unflushed and retries it.
 */
export function idleFlush(deps: IdleFlushDeps) {
  return async (e: IdleClose): Promise<void> => {
    try {
      let all: StoredMessage[] = [];
      for (const c of e.conversationIds)
        for (const m of await deps.store.messages.recent(c, RECENT))
          if (m.at >= e.since) all.push(m);
      all.sort((a, b) => a.at - b.at);
      if (e.groupId) all = ownTurns(all, e.botId);
      if (all.length < 2) return;
      const transcript = all.map(lineOf).join("\n").slice(-MAX_TRANSCRIPT);
      const scope = { botId: e.botId, ...(e.groupId && { groupId: e.groupId }) };
      const known = await deps.known(scope);
      const notes = await deps.flushNotes(transcript, { ...scope, ...(known && { known }) });
      for (const owner of writeFlushNotes(deps.memoryRoot, scope, "Idle flush", notes, deps.log)) {
        deps.memoryChanged(owner);
        void deps
          .consolidate?.(owner)
          .catch((err) => deps.log.error({ error: String(err), owner }, "memory.consolidate"));
      }
    } catch (err) {
      deps.log.error({ error: String(err), botId: e.botId }, "memory.idle_flush");
      throw err;
    }
  };
}
