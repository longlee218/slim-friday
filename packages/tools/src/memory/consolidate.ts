import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type ConsolidateFn,
  MAX_REPLACED_PER_RUN,
  type MemoryOwner,
  type PromotedNote,
} from "@friday/core";
import { type FileMemory, MemoryError } from "./file-memory";
import { writeConsolidatedMark } from "./journal";
import { pendingNotes } from "./pending-journal-notes";
import { worthKeeping } from "./worth-keeping";

/** A journal block label written from a group session ends with ` @<groupId>` (see `groupLabel`). */
const GROUP_LABEL = / @[a-z][a-z0-9-]*$/;

/**
 * Promote the owner's journal notes after its mark (today's included) into MEMORY.md, as `ask` picks them; `ask`
 * sees the memory as numbered notes and `known` (what config and USER/SOUL already say). For a bot, notes from group
 * sessions (block label ` @<groupId>`) are asked in a second call and a fact or decision picked from them is saved as
 * a lesson: group sessions see only a bot's Preferences and Lessons. A pick with `replaces: n` updates note n in place
 * (a backup is kept), at most `MAX_REPLACED_PER_RUN` a run across both calls; a further one, or one whose n names no
 * note, is added as a new note. The mark moves past the last note sent only when every call made answered. A note
 * that is too short, the same as another note in MEMORY.md (or one promoted a moment ago) or refused by the file
 * (also too long) is skipped and counted. `_now` is unused since today's notes are taken too (kept for callers).
 */
export async function consolidateOwner(
  memory: FileMemory,
  owner: MemoryOwner,
  _now: Date,
  ask: ConsolidateFn,
  known?: string,
): Promise<{ promoted: number; skipped: number; through?: string }> {
  const { entries, through } = pendingNotes(memory.root, owner);
  if (!through) return { promoted: 0, skipped: 0 };
  const fromGroup = (label: string) => owner.kind === "bot" && GROUP_LABEL.test(label);
  const direct = entries.filter((e) => !fromGroup(e.label)).map((e) => e.note);
  const group = entries.filter((e) => fromGroup(e.label)).map((e) => e.note);
  const bullets = memory.listBullets(owner);
  const numbered = bullets.map((b, i) => `[${i + 1}] (${b.kind}) ${b.text}`).join("\n");
  const directPicks = direct.length ? await ask(numbered, direct, known) : [];
  if (!directPicks) return { promoted: 0, skipped: 0 };
  const groupPicks = group.length ? await ask(numbered, group, known) : [];
  if (!groupPicks) return { promoted: 0, skipped: 0 };
  const picked: PromotedNote[] = [
    ...directPicks,
    ...groupPicks.map((p) =>
      p.kind === "fact" || p.kind === "decision" ? { ...p, kind: "lesson" as const } : p,
    ),
  ];
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
  writeConsolidatedMark(memory.root, owner, through.day, through.count);
  return { promoted, skipped, through: `${through.day}#${through.count}` };
}

/**
 * Consolidate every bot and group that has a memory dir. One owner failing (a busy file, a bad dir name) does not
 * stop the others; its mark stays, so the next run retries it. `signal` ends the run early; `known` gives each owner's
 * known-context text. Returns the notes promoted.
 */
export async function consolidateAll(
  memory: FileMemory,
  now: Date,
  ask: ConsolidateFn,
  opts: { signal?: AbortSignal; known?: (o: MemoryOwner) => Promise<string | undefined> } = {},
): Promise<number> {
  const { signal } = opts;
  // On abort a pending call is given up as failed (undefined), so no mark moves and no further owner is asked.
  const stopped = new Promise<undefined>((r) =>
    signal?.addEventListener("abort", () => r(undefined)),
  );
  const guarded: ConsolidateFn = (m, n, k) =>
    signal ? Promise.race([ask(m, n, k), stopped]) : ask(m, n, k);
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
      const known = await opts.known?.(owner);
      total += (await consolidateOwner(memory, owner, now, guarded, known)).promoted;
    } catch {
      // Left for the next run.
    }
  }
  return total;
}
