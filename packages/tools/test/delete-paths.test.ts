import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { EffectsContext } from "../src/effects/effects-context";
import { createDeletePathsTool } from "../src/effects/tools/DeletePathsTool/delete-paths-tool";
import { purgeTrash } from "../src/effects/trash";
import { trashRoot } from "../src/effects/trash-store";
import { checkInsideWorkspace } from "../src/effects/workspace-paths";

type Result = { content: { text: string }[]; isError?: boolean };
const call = (t: { handler: (a: never, e: unknown) => Promise<unknown> }, args: object) =>
  t.handler(args as never, {}) as Promise<Result>;

/** A workspace with a few files, a home for the trash and the tool bound to them. */
function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "del-")));
  const ws = join(base, "ws");
  const home = join(base, "home");
  const outside = join(base, "outside.txt");
  mkdirSync(join(ws, ".git"), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(ws, "a.txt"), "a");
  writeFileSync(join(ws, "b.txt"), "b");
  writeFileSync(join(ws, ".env"), "SECRET=1");
  writeFileSync(join(ws, ".git", "config"), "x");
  writeFileSync(outside, "o");
  symlinkSync(outside, join(ws, "link"));
  const ctx: EffectsContext = {
    botId: "ann",
    workspaces: [ws],
    home,
    isSensitive: (real) => basename(real).startsWith(".env"),
    run: async () => ({ code: 0, out: "" }),
  };
  return { ws, home, outside, tool: createDeletePathsTool(ctx) };
}

test("a file inside the workspace moves to the trash", async () => {
  const { ws, home, tool } = setup();
  const r = await call(tool, { paths: [join(ws, "a.txt")], reason: "old" });
  expect(r.isError).toBeUndefined();
  expect(existsSync(join(ws, "a.txt"))).toBe(false);
  expect(r.content[0]?.text).toContain(trashRoot(home));
});

test("a bad path is refused and nothing moves, even in a mixed list", async () => {
  const { ws, outside, tool } = setup();
  const bad = [
    "/etc/hosts",
    join(ws, "..", "outside.txt"),
    join(ws, "link"),
    ws,
    join(ws, ".git", "config"),
    join(ws, ".env"),
    "a.txt",
  ];
  for (const p of bad) {
    const r = await call(tool, { paths: [join(ws, "b.txt"), p], reason: "x" });
    expect(r.isError).toBe(true);
  }
  expect(existsSync(join(ws, "b.txt"))).toBe(true);
  expect(existsSync(outside)).toBe(true);
});

test("checkInsideWorkspace returns the real path and its workspace", () => {
  const { ws } = setup();
  expect(checkInsideWorkspace(join(ws, "a.txt"), [ws], () => false)).toEqual({
    real: join(ws, "a.txt"),
    workspace: ws,
  });
  expect(typeof checkInsideWorkspace(ws, [ws], () => false)).toBe("string");
});

test("purgeTrash empties the trash and counts what it removed", async () => {
  const { ws, home, tool } = setup();
  await call(tool, { paths: [join(ws, "a.txt")], reason: "x" });
  await call(tool, { paths: [join(ws, "b.txt")], reason: "x" });
  expect(purgeTrash(home)).toBe(2);
  expect(readdirSync(trashRoot(home))).toEqual([]);
  expect(purgeTrash(home)).toBe(0);
});

test("a dir holding a sensitive file or a nested .git is refused and stays", async () => {
  const { ws, tool } = setup();
  mkdirSync(join(ws, "cfg"));
  writeFileSync(join(ws, "cfg", ".env"), "K=1");
  mkdirSync(join(ws, "vendor", "lib", ".git"), { recursive: true });
  for (const p of [join(ws, "cfg"), join(ws, "vendor")]) {
    const r = await call(tool, { paths: [p], reason: "x" });
    expect(r.isError).toBe(true);
    expect(existsSync(p)).toBe(true);
  }
});
