import type { BotRuntimeSpec } from "@friday/core";
import { appendJournal } from "@friday/tools";

/**
 * The `onCompact` of the runtime: the notes `extract` finds in a compaction summary go into the bot's journal for
 * today as a `Flush` block (never into `MEMORY.md`, which the bot curates). A failure is logged, never thrown.
 * Returns the promise so tests can wait; the runtime does not.
 */
export function memoryFlush(
  memoryDir: string,
  extract: (summary: string) => Promise<string[]>,
  log: { error(o: object, msg: string): void },
) {
  return (spec: BotRuntimeSpec, summary: string): Promise<void> =>
    extract(summary)
      .then((notes) => {
        appendJournal(memoryDir, { kind: "bot", botId: spec.bot.id }, "Flush", notes, new Date());
      })
      .catch((err) => log.error({ error: String(err), botId: spec.bot.id }, "memory.flush"));
}
