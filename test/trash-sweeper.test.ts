import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purgeThreadTrash } from "../src/effects/purge-trash";
import { moveToTrash } from "../src/effects/trash-store";
import { sweepTrash } from "../src/lifecycle/trash-sweeper";
import { openDb } from "../src/storage/db";
import { appendEffect } from "../src/storage/effect-log-store";

/* The trash: move + manifest, the 7-day sweeper, and /purge scoped to the thread's goals. */

const DAY = 86_400_000;
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "trash-")));

test("moveToTrash keeps the bytes under <home>/trash/<goal>/<ms>/ with a manifest; a bad goal id throws", () => {
  const home = tmp();
  const src = join(tmp(), "dir");
  mkdirSync(src);
  writeFileSync(join(src, "f.txt"), "hello");
  const m = moveToTrash(home, "goal-1", [src], 5_000_000_000_000);
  expect(m.error).toBeUndefined();
  expect(existsSync(src)).toBe(false);
  expect(readFileSync(join(m.entries[0]?.to ?? "", "f.txt"), "utf8")).toBe("hello");
  expect(JSON.parse(readFileSync(join(m.dir, "manifest.json"), "utf8")).entries).toHaveLength(1);
  expect(() => moveToTrash(home, "../evil", [src], 1)).toThrow();
});

test("the sweeper removes entries older than 7 days and keeps newer ones; empty goal dirs go", () => {
  const home = tmp();
  const now = 10_000_000_000_000;
  const file = (n: string) => {
    const f = join(tmp(), n);
    writeFileSync(f, "x");
    return f;
  };
  const old = moveToTrash(home, "g-old", [file("a")], now - 8 * DAY);
  const fresh = moveToTrash(home, "g-mixed", [file("b")], now - 1 * DAY);
  const stale = moveToTrash(home, "g-mixed", [file("c")], now - 7 * DAY - 1);
  expect(sweepTrash(home, now)).toBe(2);
  expect(existsSync(old.dir)).toBe(false);
  expect(existsSync(join(home, "trash", "g-old"))).toBe(false);
  expect(existsSync(stale.dir)).toBe(false);
  expect(existsSync(fresh.dir)).toBe(true);
  expect(sweepTrash(home, now)).toBe(0);
  expect(sweepTrash(tmp(), now)).toBe(0); // no trash dir at all
});

test("the sweeper never follows a link or touches a foreign name", () => {
  const home = tmp();
  const victim = tmp();
  writeFileSync(join(victim, "keep.txt"), "x");
  mkdirSync(join(home, "trash", "g1"), { recursive: true });
  symlinkSync(victim, join(home, "trash", "g1", "1000000000000")); // an old-looking entry that is a link
  mkdirSync(join(home, "trash", "g1", "notes")); // not an entry name
  expect(sweepTrash(home, 99_000_000_000_000)).toBe(0);
  expect(existsSync(join(victim, "keep.txt"))).toBe(true);
  expect(existsSync(join(home, "trash", "g1", "notes"))).toBe(true);
});

test("/purge empties the trash of THIS thread's goals only, after a yes", async () => {
  const home = tmp();
  const db = openDb(join(home, "t.db"));
  // A thread's goals are the goal keys its effects were logged under.
  const goal = (id: string, threadId: string) =>
    appendEffect(db, {
      id: `e-${id}`,
      threadId,
      goalId: id,
      tool: "DeletePaths",
      scope: "s",
      grantedBy: "owner",
      result: "ok",
    });
  goal("goal-a", "t1");
  goal("goal-b", "t2");
  const f = (n: string) => {
    const p = join(tmp(), n);
    writeFileSync(p, "x");
    return p;
  };
  moveToTrash(home, "goal-a", [f("a")], 1_700_000_000_000);
  moveToTrash(home, "goal-b", [f("b")], 1_700_000_000_000);
  const yes = async () => true;
  const asked: string[] = [];
  // No click (or a "no"): nothing is emptied, the goal's trash stays.
  expect(
    await purgeThreadTrash(db, home, "t1", "en", async (q) => {
      asked.push(q);
      return false;
    }),
  ).toContain("left the trash");
  expect(asked).toHaveLength(1);
  expect(existsSync(join(home, "trash", "goal-a"))).toBe(true);
  expect(await purgeThreadTrash(db, home, "t1", "en", yes)).toContain("1 goal");
  expect(existsSync(join(home, "trash", "goal-a"))).toBe(false);
  expect(existsSync(join(home, "trash", "goal-b"))).toBe(true);
  expect(await purgeThreadTrash(db, home, "t1", "en", yes)).toContain("empty");
  expect(await purgeThreadTrash(db, home, "t1", "vi", yes)).toContain("trống");
});
