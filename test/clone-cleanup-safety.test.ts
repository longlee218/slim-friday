import { expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { insertWorktree, type WorktreeRow } from "../src/storage/worktree-store";
import { cleanupWorktree, removeCloneDir } from "../src/workspaces/clone-cleanup";
import { safeRemoveClone } from "../src/workspaces/clone-safety";
import { cloneEnv, tid } from "./clone-fixture";
import { LEGACY_WT_FIELDS } from "./git-fixture";
import { TEST_CHANNEL } from "./helpers";

// Clone removal never leaves worktrees/ (fuzz) and the `/cleanup <taskId8|taskId>` grammar (P2.2).

const where = { threadId: "th", channelId: TEST_CHANNEL };

test("fuzz: 50 crafted ids, paths, names never delete anything outside worktrees/", async () => {
  const e = await cloneEnv();
  const ws = e.env.paths.workspace("main");
  const root = ws.repo("ext").worktrees;
  mkdirSync(root, { recursive: true });
  // Things that must survive: a sibling repo's clones, the home files, the owner repo, the root itself.
  const sibling = join(ws.repo("other").worktrees, tid("99999999"));
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "keep"), "x");
  const homeFile = join(e.env.home, "keep.txt");
  writeFileSync(homeFile, "x");
  const link = join(root, tid("77777777"));
  symlinkSync(sibling, link); // a symlink named like a clone, pointing at a sibling clone
  const survivors = [join(sibling, "keep"), homeFile, join(e.src.repo, "a.txt"), root];

  const ids = [
    tid("77777777"),
    "..",
    "../..",
    "",
    "/",
    "/etc",
    `${tid("11111111")}/..`,
    "a/../../x",
    "x\0y",
    tid("2222222g"),
  ];
  const paths = [sibling, e.env.home, e.src.repo, root, `${root}/..`, link];
  const names = ["main", "..", "other", "a/b", ""];
  let n = 0;
  for (const id of ids)
    for (const p of paths) {
      const row = {
        ...LEGACY_WT_FIELDS,
        taskId: id,
        threadId: "t",
        repo: "ext",
        repoPath: e.src.repo,
        path: p,
        branch: "friday/x",
        base: "main",
        baseSha: "a".repeat(40),
        workspace: "main",
      } as WorktreeRow;
      removeCloneDir(row, e.env.home);
      safeRemoveClone(p, root);
      n += 2;
    }
  for (const w of names)
    for (const r of ["..", "ext", "other", ".git", "a/b"]) {
      const row = {
        ...LEGACY_WT_FIELDS,
        taskId: tid("77777777"),
        threadId: "t",
        repo: r,
        repoPath: e.src.repo,
        path: link,
        branch: "friday/x",
        base: "main",
        baseSha: "a".repeat(40),
        workspace: w,
      } as WorktreeRow;
      removeCloneDir(row, e.env.home);
      n++;
    }
  expect(n).toBeGreaterThanOrEqual(50);
  for (const s of survivors) expect(existsSync(s)).toBe(true);
  expect(existsSync(link)).toBe(true); // the symlink itself is never followed or removed
});

test("/cleanup grammar: short prefix, full id, ambiguity, unknown, other workspace", async () => {
  const e = await cloneEnv();
  const a = await e.start(tid("abcdef01", 1), "t1");
  const b = await e.start(tid("abcdef02", 2), "t2");
  const c = await e.start(tid("abcdef02", 3), "t3");
  const deps = { db: e.env.db, agentHome: e.env.home, active: new Map<string, unknown>() };
  const run = (arg: string) => cleanupWorktree(deps, where, arg);
  // unknown / non-id input: one refusal line, nothing removed
  for (const bad of ["../x", "zzzzzzzz", "abc", "abcdef012", "friday/x"]) {
    const r = await run(bad);
    expect(r.split("\n")).toHaveLength(1);
    expect(r).toContain("No clone with that id");
  }
  expect(await run("12345678")).toContain("No clone with that id");
  // ambiguous short prefix lists the candidates
  const amb = await run("abcdef02");
  expect(amb).toContain(b.taskId);
  expect(amb).toContain(c.taskId);
  expect(existsSync(b.path) && existsSync(c.path)).toBe(true);
  // a unique short prefix removes that clone
  expect(await run("abcdef01")).toContain("Removed the task clone");
  expect(existsSync(a.path)).toBe(false);
  // the full id works
  expect(await run(c.taskId)).toContain("Removed");
  expect(existsSync(c.path)).toBe(false);
  expect(existsSync(b.path)).toBe(true);
  // a row of another workspace is not reachable from this one
  insertWorktree(e.env.db, {
    ...LEGACY_WT_FIELDS,
    taskId: tid("fedcba98"),
    threadId: "x",
    repo: "ext",
    repoPath: "/r",
    path: b.path,
    branch: "friday/y",
    base: "main",
    baseSha: "a".repeat(40),
    workspace: "w2",
  });
  expect(await run("fedcba98")).toContain("No clone with that id");
  expect(await run(tid("fedcba98"))).toContain("No clone with that id");
  // a running task's clone is not removed
  expect(
    await cleanupWorktree({ ...deps, active: new Map([["t2", 1]]) }, where, "abcdef02"),
  ).toContain("in use");
});
