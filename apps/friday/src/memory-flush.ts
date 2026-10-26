import type { BotId, BotRuntimeSpec, FlushNote, GroupId, MemoryOwner } from "@friday/core";
import { appendJournal, groupLabel } from "@friday/tools";
import { logJournalAppend } from "./journal-append-log";

type FlushLog = { error(o: object, msg: string): void; warn(o: object, msg: string): void };

/**
 * Write a flush's notes into today's journals under `label`. In a group session `about: group` notes go to the
 * group's journal (`label`) and `about: bot` ones to the bot's (`<label> @<groupId>`, so consolidation knows they come
 * from a group); in a direct session every note goes to the bot's (`label`). Returns the owners a block was saved for.
 */
export function writeFlushNotes(
  root: string,
  scope: { botId: BotId; groupId?: GroupId },
  label: string,
  notes: FlushNote[],
  log: FlushLog,
): MemoryOwner[] {
  const bot: MemoryOwner = { kind: "bot", botId: scope.botId };
  const { groupId } = scope;
  const writes: [MemoryOwner, string, FlushNote[]][] = groupId
    ? [
        [{ kind: "group", groupId }, label, notes.filter((n) => n.about === "group")],
        [bot, groupLabel(label, groupId), notes.filter((n) => n.about !== "group")],
      ]
    : [[bot, label, notes]];
  const saved: MemoryOwner[] = [];
  const now = new Date();
  for (const [owner, l, some] of writes) {
    if (some.length === 0) continue;
    const r = appendJournal(
      root,
      owner,
      l,
      some.map((n) => n.note),
      now,
    );
    logJournalAppend(log, owner, r);
    if (r.status === "saved") saved.push(owner);
  }
  return saved;
}

/**
 * The `onCompact` of the runtime: the notes `extract` finds in a compaction summary go into today's journals as a
 * `Flush` block, split by `writeFlushNotes` (never into `MEMORY.md`, which the bot curates). No consolidation here:
 * the next idle-flush or daily one takes these notes. A failure is logged, never thrown.
 * `afterWrite` tells the memory index a journal changed. Returns the promise so tests can wait; the runtime does not.
 */
export function memoryFlush(
  memoryDir: string,
  extract: (spec: BotRuntimeSpec, summary: string) => Promise<FlushNote[]>,
  log: FlushLog,
  afterWrite?: (owner: MemoryOwner) => void,
) {
  return (spec: BotRuntimeSpec, summary: string): Promise<void> =>
    extract(spec, summary)
      .then((notes) => {
        const scope = { botId: spec.bot.id, groupId: spec.groupId };
        for (const owner of writeFlushNotes(memoryDir, scope, "Flush", notes, log))
          afterWrite?.(owner);
      })
      .catch((err) => log.error({ error: String(err), botId: spec.bot.id }, "memory.flush"));
}
