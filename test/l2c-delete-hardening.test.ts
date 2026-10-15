import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deletePaths } from "../src/orchestrator/approval/delete-paths";
import { type EffectsCtx, safeText } from "../src/orchestrator/approval/effect-context";
import { defaultEnvelope } from "../src/orchestrator/approval/envelope";
import { goalLocations } from "../src/orchestrator/approval/load-envelope";
import { moveToTrash } from "../src/orchestrator/approval/trash-store";
import { MAX_WALK_MS, treeTotals } from "../src/orchestrator/approval/tree-totals";
import { openDb } from "../src/storage/db";
import { effectsOfGoal } from "../src/storage/effect-log-store";
import { cleanupTmp, tmpRoot } from "./tmp-dirs";

afterAll(cleanupTmp);

/* L2c hardening of DeletePaths and the trash: other locations ask and still obey the bounds, a swap during the owner's wait is
   refused, refusals are audited, spoofing characters are escaped, walks are capped, trash dirs never collide. */

const base = tmpRoot("l2c-del-");
let n = 0;

/** Two locations (`api` in the envelope, `web` not), a home and a ctx whose confirm answers `answer` (and runs `during`). */
function setup(answer = true, during?: () => void) {
  const id = `s${n++}`;
  const api = join(base, id, "api");
  const web = join(base, id, "web");
  const home = join(base, id, "home");
  for (const d of [api, web, home, join(home, "scratch")]) mkdirSync(d, { recursive: true });
  const asked: string[] = [];
  const ctx: EffectsCtx = {
    db: openDb(join(home, "t.db")),
    threadId: "t1",
    goalId: "goal-l2c",
    itemId: "i1",
    envelope: defaultEnvelope("goal-l2c", ["api"], join(home, "scratch")),
    locations: [
      { name: "api", path: api },
      { name: "web", path: web },
    ],
    agentHome: home,
    confirm: async (s) => {
      asked.push(s);
      during?.();
      return answer;
    },
    run: async () => ({ code: 0, out: "" }),
    now: () => 1_700_000_000_000,
  };
  return { api, web, home, ctx, asked };
}

test("goal locations: only the pinned ones; unpinned among several = none; a single channel location = it", () => {
  const { ctx } = setup();
  expect(goalLocations(ctx.db, "g", "api", ["api", "web"])).toEqual(["api"]);
  expect(goalLocations(ctx.db, "g", null, ["api", "web"])).toEqual([]);
  expect(goalLocations(ctx.db, "g", null, ["api"])).toEqual(["api"]);
});

test("other location: the owner is asked; yes still obeys the bounds (items): refused, nothing moves", async () => {
  const s = setup(true);
  const files = Array.from({ length: 201 }, (_, i) => join(s.web, `f${i}.txt`));
  for (const f of files) writeFileSync(f, "x");
  const r = await deletePaths(s.ctx, { paths: files, reason: "r" });
  expect(r).toMatchObject({ ok: false, code: "OVER_BOUNDS" });
  expect(s.asked).toHaveLength(1); // the one question was the other-location one
  expect(existsSync(files[0])).toBe(true);
});

test("TOCTOU: a path swapped while the owner decides is refused, nothing moves", async () => {
  const f = { p: "" };
  const s = setup(true, () => {
    writeFileSync(`${f.p}.new`, "evil");
    renameSync(`${f.p}.new`, f.p); // same name, another inode
  });
  f.p = join(s.web, "x.txt");
  writeFileSync(f.p, "x");
  const r = await deletePaths(s.ctx, { paths: [f.p], reason: "r" });
  expect(r).toMatchObject({ ok: false, code: "CHANGED" });
  expect(existsSync(f.p)).toBe(true);
});

test("audit: a refusal and an owner denial each write a row (result + code)", async () => {
  const s = setup(false);
  const f = join(s.web, "y.txt");
  writeFileSync(f, "y");
  await deletePaths(s.ctx, { paths: [join(s.api, "missing")], reason: "r" });
  await deletePaths(s.ctx, { paths: [f], reason: "r" });
  const rows = effectsOfGoal(s.ctx.db, "goal-l2c").map((r) => JSON.parse(r.result));
  expect(rows).toEqual([
    { result: "refused", code: "FORBIDDEN_PATH" },
    { result: "denied", code: "OWNER_DENIED" },
  ]);
});

test("spoofing: control characters in paths and reason are shown escaped in the owner question", async () => {
  const s = setup(false);
  const f = join(s.web, "a\nEvil: approved.txt");
  writeFileSync(f, "x");
  await deletePaths(s.ctx, { paths: [f], reason: "ok\r\nYES" });
  expect(s.asked[0].split("\n")).toHaveLength(3); // header, one path line, reason: no forged line
  expect(s.asked[0]).not.toContain("\r");
  expect(s.asked[0]).toContain("\\u000a");
  expect(safeText("a‮b\u0000")).toBe("a\\u202eb\\u0000");
});

test("walk cap: a walk past its time budget reports capped (unknown size = over the bound), symlinks are not followed", () => {
  const s = setup();
  for (let i = 0; i < 5; i++) writeFileSync(join(s.api, `f${i}`), "x");
  let t = 0;
  expect(treeTotals([s.api], Number.POSITIVE_INFINITY, () => (t += MAX_WALK_MS + 1)).capped).toBe(
    true,
  );
  expect(treeTotals([s.api]).capped).toBe(false);
  // A link to a big dir counts as the link, not the target.
  const link = join(s.home, "lnk");
  Bun.spawnSync(["ln", "-s", s.api, link]);
  expect(treeTotals([link]).files).toBe(1);
});

test("trash: two moves in the same millisecond never share a dir; nothing is overwritten", () => {
  const s = setup();
  const [a, b] = [join(s.api, "a.txt"), join(s.api, "b.txt")];
  writeFileSync(a, "A");
  writeFileSync(b, "B");
  const m1 = moveToTrash(s.home, "goal-l2c", [a], 1_700_000_000_000);
  const m2 = moveToTrash(s.home, "goal-l2c", [b], 1_700_000_000_000);
  expect(m1.dir).not.toBe(m2.dir);
  expect(readdirSync(join(s.home, "trash", "goal-l2c"))).toHaveLength(2);
  expect(m1.entries).toHaveLength(1);
  expect(m2.entries).toHaveLength(1);
  // A path that changed after validation stops the move before it starts.
  writeFileSync(a, "A2");
  expect(moveToTrash(s.home, "goal-l2c", [a], 1, () => false)).toMatchObject({ error: "CHANGED" });
  expect(existsSync(a)).toBe(true);
});

test("M2: a dir that CONTAINS a nested git dir (repo, submodule) asks the owner with the reason; no = nothing moves", async () => {
  const GIT = `${String.fromCharCode(46)}git`;
  const s = setup(false);
  const dir = join(s.api, "vendor");
  mkdirSync(join(dir, "lib", GIT), { recursive: true });
  writeFileSync(join(dir, "lib", "a.ts"), "x");
  expect(await deletePaths(s.ctx, { paths: [dir], reason: "cleanup" })).toMatchObject({
    code: "OWNER_DENIED",
  });
  expect(s.asked).toHaveLength(1);
  expect(s.asked[0]).toContain("git repository");
  expect(existsSync(join(dir, "lib", "a.ts"))).toBe(true);
  // A yes goes on; a plain dir without a git dir asks nothing.
  const yes = setup(true);
  mkdirSync(join(yes.api, "v", "lib", GIT), { recursive: true });
  expect(await deletePaths(yes.ctx, { paths: [join(yes.api, "v")], reason: "r" })).toMatchObject({
    ok: true,
  });
  const plain = setup(false);
  mkdirSync(join(plain.api, "p", "lib"), { recursive: true });
  expect(
    await deletePaths(plain.ctx, { paths: [join(plain.api, "p")], reason: "r" }),
  ).toMatchObject({
    ok: true,
  });
  expect(plain.asked).toHaveLength(0);
});
