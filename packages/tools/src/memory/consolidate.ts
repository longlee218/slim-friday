import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type ConsolidateFn,
  GROUP_SESSION_KINDS,
  MAX_REPLACED_PER_RUN,
  type MemoryOwner,
  type PromotedNote,
} from "@friday/core";
import { type FileMemory, type MemoryBullet, MemoryError } from "./file-memory";
import { writeConsolidatedMark } from "./journal";
import type { OwnerQueue } from "./owner-queue";
import { pendingNotes } from "./pending-journal-notes";
import { worthKeeping } from "./worth-keeping";

/** A journal block label written from a group session ends with ` @<groupId>` (see `groupLabel`). */
const GROUP_LABEL = / @[a-z][a-z0-9-]*$/;

/**
 * Promote the owner's journal notes after its mark (today's included) into MEMORY.md, as `ask` picks them; `ask`
 * sees the memory as numbered notes and `known` (what config and USER/SOUL already say). For a bot, notes from group
 * sessions (block label ` @<groupId>`) are asked in a second call that sees only the Preferences and Lessons (what
 * group sessions see), and a fact or decision picked from them is saved as a lesson. A pick with `replaces: n`
 * updates note n of the list that call saw in place (a backup is kept), at most `MAX_REPLACED_PER_RUN` a run across
 * both calls; a further one, or one whose n names no note, is added as a new note. The mark moves past the last note sent only when every call made answered. A note
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
  const numbered = (list: MemoryBullet[]) =>
    list.map((b, i) => `[${i + 1}] (${b.kind}) ${b.text}`).join("\n");
  const directPicks = direct.length ? await ask(numbered(bullets), direct, known) : [];
  if (!directPicks) return { promoted: 0, skipped: 0 };
  // The group call sees only the notes group sessions see, so it can neither fold a hidden fact into a lesson nor
  // name one to replace; its `replaces` numbers that view and is mapped back to the full list.
  const seen = bullets.filter((b) => (GROUP_SESSION_KINDS as readonly string[]).includes(b.kind));
  const groupPicks = group.length ? await ask(numbered(seen), group, known) : [];
  if (!groupPicks) return { promoted: 0, skipped: 0 };
  const picked: PromotedNote[] = [
    ...directPicks,
    ...groupPicks.map((p) => {
      const target = p.replaces === undefined ? undefined : seen[p.replaces - 1];
      const kind = p.kind === "fact" || p.kind === "decision" ? ("lesson" as const) : p.kind;
      return { ...p, kind, replaces: target ? bullets.indexOf(target) + 1 : undefined };
    }),
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
 * known-context text (a lookup that throws consolidates the owner without it); `queue` serializes each owner's run
 * with other runs of the same owner. Returns the notes promoted.
 */
export async function consolidateAll(
  memory: FileMemory,
  now: Date,
  ask: ConsolidateFn,
  opts: {
    signal?: AbortSignal;
    known?: (o: MemoryOwner) => Promise<string | undefined>;
    queue?: OwnerQueue;
  } = {},
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
      const run = async () => {
        const known = await opts.known?.(owner).catch(() => undefined);
        return (await consolidateOwner(memory, owner, now, guarded, known)).promoted;
      };
      total += await (opts.queue ? opts.queue(owner, run) : run());
    } catch {
      // Left for the next run.
    }
  }
  return total;
}
