import type { BotRuntimeSpec, MemoryOwner } from "@friday/core";
import { appendJournal } from "@friday/tools";
import { logJournalAppend } from "./journal-append-log";

/**
 * The `onCompact` of the runtime: the notes `extract` finds in a compaction summary go into the journal for today as
 * a `Flush` block: the group's for a group session (group knowledge reaches the group memory), else the bot's (never into `MEMORY.md`, which the bot curates). A failure is logged, never thrown.
 * `afterWrite` tells the memory index the journal changed. Returns the promise so tests can wait; the runtime does not.
 */
export function memoryFlush(
  memoryDir: string,
  extract: (summary: string) => Promise<string[]>,
  log: { error(o: object, msg: string): void; warn(o: object, msg: string): void },
  afterWrite?: (owner: MemoryOwner) => void,
) {
  return (spec: BotRuntimeSpec, summary: string): Promise<void> =>
    extract(summary)
      .then((notes) => {
        const owner: MemoryOwner = spec.groupId
          ? { kind: "group", groupId: spec.groupId }
          : { kind: "bot", botId: spec.bot.id };
        const r = appendJournal(memoryDir, owner, "Flush", notes, new Date());
        logJournalAppend(log, owner, r);
        afterWrite?.(owner);
      })
      .catch((err) => log.error({ error: String(err), botId: spec.bot.id }, "memory.flush"));
}
