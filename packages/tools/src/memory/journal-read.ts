import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AdminError, type JournalDay, type MemoryOwner } from "@friday/core";
import { journalDays, journalDir } from "./journal";

/** Day files shown when no day is asked for. */
const RECENT_DAYS = 7;
/** A day is checked with this before it is joined into a path. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The `- ` items of one day file ("" lines dropped); none when the file is missing. */
function itemsOf(root: string, owner: MemoryOwner, day: string): string[] {
  const file = join(journalDir(root, owner), `${day}.md`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
}

/**
 * The journal for the owner's settings page: one day when `day` is given (`YYYY-MM-DD`, else BAD_REQUEST; [] when
 * that day has no file), otherwise the newest 7 day files, newest first.
 */
export function readJournal(root: string, owner: MemoryOwner, day?: string): JournalDay[] {
  if (day !== undefined) {
    if (!DAY.test(day)) throw new AdminError("BAD_REQUEST", "day must be YYYY-MM-DD", "day");
    const items = itemsOf(root, owner, day);
    return items.length || journalDays(root, owner).includes(day) ? [{ day, items }] : [];
  }
  return journalDays(root, owner)
    .reverse()
    .slice(0, RECENT_DAYS)
    .map((d) => ({ day: d, items: itemsOf(root, owner, d) }));
}
