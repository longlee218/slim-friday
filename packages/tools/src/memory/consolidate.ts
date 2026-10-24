import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ConsolidateFn, MemoryOwner } from "@friday/core";
import { type FileMemory, localDay, MemoryError } from "./file-memory";
import { journalDays, journalNotes, readConsolidatedMark, writeConsolidatedMark } from "./journal";

/** Most journal notes sent in one consolidation call. */
const MAX_NOTES = 200;
/** Most characters of journal notes sent in one consolidation call. */
const MAX_CHARS = 20000;

/**
 * Notes of the complete days after the owner's mark, oldest day first, within the caps. A day that does not fit
 * whole is left for the next run, except the first one (cut to the caps), so one huge day cannot stop the mark.
 */
function pendingNotes(root: string, owner: MemoryOwner, today: string) {
  const mark = readConsolidatedMark(root, owner) ?? "";
  const notes: string[] = [];
  let chars = 0;
  let through: string | undefined;
  for (const day of journalDays(root, owner)) {
    if (day <= mark || day >= today) continue;
    const dayNotes = journalNotes(root, owner, day);
    const size = dayNotes.reduce((n, s) => n + s.length, 0);
    if (through && (notes.length + dayNotes.length > MAX_NOTES || chars + size > MAX_CHARS)) break;
    for (const n of dayNotes) {
      if (notes.length >= MAX_NOTES || chars + n.length > MAX_CHARS) break;
      notes.push(n);
      chars += n.length;
    }
    through = day;
  }
  return { notes, through };
}

/**
 * Promote the owner's journal notes of complete days (before today) after its mark into MEMORY.md, as `ask` picks
 * them. The mark moves to the last day sent only when `ask` answered; a duplicate or empty note is skipped.
 */
export async function consolidateOwner(
  memory: FileMemory,
  owner: MemoryOwner,
  now: Date,
  ask: ConsolidateFn,
): Promise<{ promoted: number; through?: string }> {
  const { notes, through } = pendingNotes(memory.root, owner, localDay(now));
  if (!through) return { promoted: 0 };
  const picked = notes.length ? await ask(await memory.read(owner), notes) : [];
  if (!picked) return { promoted: 0 };
  let promoted = 0;
  for (const p of picked) {
    try {
      await memory.save(owner, p.note, p.kind);
      promoted++;
    } catch (err) {
      if (!(err instanceof MemoryError && (err.code === "duplicate" || err.code === "empty")))
        throw err;
    }
  }
  writeConsolidatedMark(memory.root, owner, through);
  return { promoted, through };
}

/**
 * Consolidate every bot and group that has a memory dir. One owner failing (a busy file, a bad dir name) does not
 * stop the others; its mark stays, so the next run retries it. Returns the notes promoted in total.
 */
export async function consolidateAll(
  memory: FileMemory,
  now: Date,
  ask: ConsolidateFn,
): Promise<number> {
  const owners: MemoryOwner[] = [];
  for (const [dir, make] of [
    ["bots", (id: string): MemoryOwner => ({ kind: "bot", botId: id })],
    ["groups", (id: string): MemoryOwner => ({ kind: "group", groupId: id })],
  ] as const) {
    const base = join(memory.root, dir);
    if (existsSync(base)) for (const id of readdirSync(base)) owners.push(make(id));
  }
  let total = 0;
  for (const owner of owners) {
    try {
      total += (await consolidateOwner(memory, owner, now, ask)).promoted;
    } catch {
      // Left for the next run.
    }
  }
  return total;
}
