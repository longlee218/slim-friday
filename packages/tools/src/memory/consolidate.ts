import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type ConsolidateFn, MAX_REPLACED_PER_RUN, type MemoryOwner } from "@friday/core";
import { type FileMemory, localDay, MemoryError } from "./file-memory";
import {
  JOURNAL_MAX_LINES,
  journalDays,
  journalNotes,
  readConsolidatedMark,
  writeConsolidatedMark,
} from "./journal";
import { MEMORY_NOTE_MAX_CHARS } from "./sanitize-bullet";
import { worthKeeping } from "./worth-keeping";

/** Most journal notes sent in one consolidation call: a whole day file always fits. */
const MAX_NOTES = JOURNAL_MAX_LINES;
/** Most characters of journal notes sent in one consolidation call: a whole day file always fits. */
const MAX_CHARS = JOURNAL_MAX_LINES * (MEMORY_NOTE_MAX_CHARS + 1);

/**
 * Notes of the complete days after the owner's mark, oldest day first, within the caps. A day that does not fit
 * whole is left for the next run; the first day is always sent whole (also a hand-edited one over the caps), so the
 * mark never passes a note that was not sent.
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
    notes.push(...dayNotes);
    chars += size;
    through = day;
  }
  return { notes, through };
}

/**
 * Promote the owner's journal notes of complete days (before today) after its mark into MEMORY.md, as `ask` picks
 * them; `ask` sees the memory as numbered notes. A pick with `replaces: n` updates note n in place (a backup is kept),
 * at most `MAX_REPLACED_PER_RUN` a run; a further one, or one whose n names no note, is added as a new note. The mark
 * moves to the last day sent only when `ask` answered. A note that is too short, the same as another note in
 * MEMORY.md (or one promoted a moment ago) or refused by the file (also too long) is skipped and counted.
 */
export async function consolidateOwner(
  memory: FileMemory,
  owner: MemoryOwner,
  now: Date,
  ask: ConsolidateFn,
): Promise<{ promoted: number; skipped: number; through?: string }> {
  const { notes, through } = pendingNotes(memory.root, owner, localDay(now));
  if (!through) return { promoted: 0, skipped: 0 };
  const bullets = memory.listBullets(owner);
  const numbered = bullets.map((b, i) => `[${i + 1}] (${b.kind}) ${b.text}`).join("\n");
  const picked = notes.length ? await ask(numbered, notes) : [];
  if (!picked) return { promoted: 0, skipped: 0 };
  const kept = bullets.map((b) => b.text);
  let promoted = 0;
  let skipped = 0;
  let replaced = 0;
  for (const p of picked) {
    // A replacement must keep the kind of the line it replaces: the section decides who sees a note (a fact moved
    // under Preferences would reach group sessions), so another kind is added as a new note instead.
    const named =
      p.replaces !== undefined && replaced < MAX_REPLACED_PER_RUN
        ? bullets[p.replaces - 1]
        : undefined;
    const target = named?.kind === p.kind ? named : undefined;
    // An update often shares most words with the line it replaces: compare against the other notes only.
    const others = target ? kept.filter((t) => t !== target.text) : kept;
    if (worthKeeping(p.note, others) !== "keep") {
      skipped++;
      continue;
    }
    try {
      if (target) {
        await memory.edit(owner, target.id, p.note);
        replaced++;
        kept.splice(kept.indexOf(target.text), 1, p.note);
      } else {
        await memory.save(owner, p.note, p.kind);
        kept.push(p.note);
      }
      promoted++;
    } catch (err) {
      const known = ["duplicate", "empty", "too_long", "not_found"];
      if (!(err instanceof MemoryError && known.includes(err.code))) throw err;
      skipped++;
    }
  }
  writeConsolidatedMark(memory.root, owner, through);
  return { promoted, skipped, through };
}

/**
 * Consolidate every bot and group that has a memory dir. One owner failing (a busy file, a bad dir name) does not
 * stop the others; its mark stays, so the next run retries it. `signal` ends the run early. Returns the notes promoted.
 */
export async function consolidateAll(
  memory: FileMemory,
  now: Date,
  ask: ConsolidateFn,
  signal?: AbortSignal,
): Promise<number> {
  // On abort a pending call is given up as failed (undefined), so no mark moves and no further owner is asked.
  const stopped = new Promise<undefined>((r) =>
    signal?.addEventListener("abort", () => r(undefined)),
  );
  const guarded: ConsolidateFn = (m, n) =>
    signal ? Promise.race([ask(m, n), stopped]) : ask(m, n);
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
    if (signal?.aborted) break;
    try {
      total += (await consolidateOwner(memory, owner, now, guarded)).promoted;
    } catch {
      // Left for the next run.
    }
  }
  return total;
}
