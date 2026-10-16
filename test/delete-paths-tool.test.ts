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
import { deletePaths } from "../src/mcp/effects/delete-paths";
import { createDeletePathsTool } from "../src/mcp/effects/tools/DeletePathsTool/delete-paths-tool";
import type { EffectsCtx } from "../src/policy/effect-context";
import { defaultEnvelope } from "../src/policy/envelope";
import { openDb } from "../src/storage/db";
import { effectsOfGoal } from "../src/storage/effect-log-store";

/* DeletePaths: trash move + audit row, and the fail-closed path rules. Real files, real db, fake owner gate. */

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "delete-paths-")));

/** A home, two locations (`api` in the envelope, `web` registered but not), a scratch dir and a context. */
function setup(maxItems?: number) {
  const home = tmp();
  const api = join(tmp(), "api");
  const web = join(tmp(), "web");
  const scratch = join(home, "scratch");
  for (const d of [api, join(api, ".git"), web, scratch]) mkdirSync(d, { recursive: true });
  const asked: string[] = [];
  let answer = true;
  const envelope = defaultEnvelope("goal-1", ["api"], scratch);
  if (maxItems !== undefined) envelope.bounds.maxItems = maxItems;
  const ctx: EffectsCtx = {
    db: openDb(join(home, "t.db")),
    threadId: "t1",
    goalId: "goal-1",
    itemId: "item-1",
    envelope,
    locations: [
      { name: "api", path: api },
      { name: "web", path: web },
    ],
    agentHome: home,
    confirm: async (s) => {
      asked.push(s);
      return answer;
    },
    run: async () => ({ code: 0, out: "" }),
    now: () => 1_000_000_000_000,
  };
  return { home, api, web, scratch, ctx, asked, answer: (v: boolean) => (answer = v) };
}

test("inside the location: moved to the trash, no question, audit row with undo and a 7-day expiry", async () => {
  const s = setup();
  const f = join(s.api, "node_modules");
  mkdirSync(f);
  writeFileSync(join(f, "a.js"), "x");
  const r = await deletePaths(s.ctx, { paths: [f], reason: "cleanup" });
  expect(r).toMatchObject({ ok: true, moved: 1, keptDays: 7 });
  expect(existsSync(f)).toBe(false);
  expect(s.asked).toEqual([]);
  const [row] = effectsOfGoal(s.ctx.db, "goal-1");
  expect(row).toMatchObject({ tool: "DeletePaths", grantedBy: "envelope", itemId: "item-1" });
  const undo = JSON.parse(row?.undo ?? "{}") as { restore: { from: string; to: string }[] };
  expect(undo.restore[0]?.from).toBe(f);
  expect(undo.restore[0]?.to.startsWith(join(s.home, "trash", "goal-1", "1000000000000"))).toBe(
    true,
  );
  expect(readFileSync(join(undo.restore[0]?.to ?? "", "a.js"), "utf8")).toBe("x"); // restorable
});

test("the goal's own scratch dir is deletable too", async () => {
  const s = setup();
  const f = join(s.scratch, "tmp.txt");
  writeFileSync(f, "x");
  expect(await deletePaths(s.ctx, { paths: [f], reason: "r" })).toMatchObject({ ok: true });
});

test("refused, nothing moved: relative, missing, outside every location, root, git dir, secret, agent home", async () => {
  const s = setup();
  const keep = join(s.api, "keep.txt");
  writeFileSync(keep, "x");
  writeFileSync(join(s.api, ".env"), "SECRET=1");
  writeFileSync(join(s.home, "MEMORY.md"), "m");
  const outside = join(tmp(), "other.txt");
  writeFileSync(outside, "x");
  for (const p of [
    "keep.txt",
    join(s.api, "missing"),
    outside,
    s.api,
    join(s.api, ".git"),
    join(s.api, ".env"),
    join(s.home, "MEMORY.md"),
    join(s.api, "..", ".."),
    "/",
  ]) {
    const r = await deletePaths(s.ctx, { paths: [keep, p], reason: "r" });
    expect(r).toMatchObject({ ok: false, code: "FORBIDDEN_PATH" });
  }
  expect(existsSync(keep)).toBe(true); // one bad path refuses the whole call
  expect(s.asked).toEqual([]);
  // Every refusal is audited (result = refused) and none moved anything.
  const rows = effectsOfGoal(s.ctx.db, "goal-1");
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows)
    expect(JSON.parse(r.result)).toMatchObject({ result: "refused", code: "FORBIDDEN_PATH" });
});

test("symlinks: a link out is removed as a link (target untouched); a path through a link out is refused", async () => {
  const s = setup();
  const outDir = tmp();
  writeFileSync(join(outDir, "victim.txt"), "x");
  symlinkSync(outDir, join(s.api, "link"));
  const through = await deletePaths(s.ctx, {
    paths: [join(s.api, "link", "victim.txt")],
    reason: "r",
  });
  expect(through).toMatchObject({ ok: false, code: "FORBIDDEN_PATH" });
  expect(existsSync(join(outDir, "victim.txt"))).toBe(true);
  const link = await deletePaths(s.ctx, { paths: [join(s.api, "link")], reason: "r" });
  expect(link).toMatchObject({ ok: true });
  expect(existsSync(join(s.api, "link"))).toBe(false);
  expect(existsSync(join(outDir, "victim.txt"))).toBe(true);
});

test("another registered location is R4: asked at every act; no = refused, yes = moved with granted_by owner", async () => {
  const s = setup();
  const f = join(s.web, "x.txt");
  writeFileSync(f, "x");
  s.answer(false);
  const no = await deletePaths(s.ctx, { paths: [f], reason: "r" });
  expect(no).toMatchObject({ ok: false, code: "OWNER_DENIED" });
  expect(existsSync(f)).toBe(true);
  s.answer(true);
  expect(await deletePaths(s.ctx, { paths: [f], reason: "r" })).toMatchObject({ ok: true });
  expect(s.asked).toHaveLength(2);
  expect(effectsOfGoal(s.ctx.db, "goal-1").at(-1)?.grantedBy).toBe("owner");
});

test("past the item bound: one question once concrete; the usage of earlier calls counts", async () => {
  const s = setup(2);
  const files = ["a", "b", "c", "d"].map((n) => join(s.api, n));
  for (const f of files) writeFileSync(f, "x");
  const first = await deletePaths(s.ctx, { paths: files.slice(0, 2), reason: "r" });
  expect(first).toMatchObject({ ok: true });
  expect(s.asked).toEqual([]);
  s.answer(false);
  const third = files[2] as string;
  expect(await deletePaths(s.ctx, { paths: [third], reason: "r" })).toMatchObject({
    ok: false,
    code: "OVER_BOUNDS",
  });
  expect(existsSync(third)).toBe(true);
  s.answer(true);
  expect(await deletePaths(s.ctx, { paths: [third], reason: "r" })).toMatchObject({ ok: true });
  expect(s.asked).toHaveLength(2);
});

test("the tool wrapper validates the input and returns the JSON reply", async () => {
  const s = setup();
  const f = join(s.api, "z.txt");
  writeFileSync(f, "x");
  const t = createDeletePathsTool(s.ctx);
  const r = await t.handler({ paths: [f], reason: "r" }, {});
  expect(JSON.parse((r.content[0] as { text: string }).text)).toMatchObject({ ok: true, moved: 1 });
});
