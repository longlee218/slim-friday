import { expect, test } from "bun:test";
import { DAY_MS, expireClones } from "../src/lifecycle/clone-retention";
import { insertApproval } from "../src/storage/approval-store";
import { insertTurn } from "../src/storage/run-store";
import { getWorktreeByTask, insertWorktree, listKeptClones } from "../src/storage/worktree-store";
import { hasCredentials, safeOriginUrl } from "../src/workspaces/origin-url";
import { cloneEnv, tid } from "./clone-fixture";
import { LEGACY_WT_FIELDS } from "./git-fixture";

// Review fixes of P2.2 that survive Rev 15 phase 3: origin credentials, activity-based retention, legacy rows out
// of the cap (delivery, push and result tests went with the delivery code). Real git + fs, no network.

const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123";

test("origin credentials: userinfo with password or on http(s) is refused; ssh git@ is fine", () => {
  expect(hasCredentials(`https://${TOKEN}@github.com/a/b`)).toBe(true);
  expect(hasCredentials(`https://u:${TOKEN}@github.com/a/b`)).toBe(true);
  expect(hasCredentials("ssh://git@github.com/a/b")).toBe(false);
  expect(hasCredentials("git@github.com:a/b")).toBe(false);
  expect(safeOriginUrl(`https://u:p@github.com/a/b`)).toEqual({
    url: null,
    refusedCredentials: true,
  });
  expect(safeOriginUrl("git@github.com:a/b")).toEqual({
    url: "git@github.com:a/b",
    refusedCredentials: false,
  });
});

test("a clone of a repo whose origin carries credentials stores no url", async () => {
  const e = await cloneEnv(`https://u:${TOKEN}@github.com/Acme/widgets.git`);
  const wt = await e.start(tid("dddd0001"));
  expect(wt.originUrl).toBeNull();
  expect(wt.delivery).toBe("local");
  expect(JSON.stringify(getWorktreeByTask(e.env.db, wt.taskId))).not.toContain(TOKEN);
});

test("retention ages from last activity: a kept clone with a recent follow-up task stays", async () => {
  const e = await cloneEnv();
  const OLD = Date.now() - 20 * DAY_MS;
  const quiet = await e.start(tid("dddd0003"), "th-quiet");
  const busy = await e.start(tid("dddd0004"), "th-busy");
  for (const w of [quiet, busy]) {
    e.env.db
      .query("UPDATE worktrees SET status='kept', created_at=? WHERE task_id=?")
      .run(OLD, w.taskId);
  }
  insertTurn(e.env.db, {
    id: "t-follow",
    threadId: "th-busy",
    source: "t",
    repo: "ext",
    role: "dev",
  });
  expect(expireClones(e.env.db, e.env.home, 14)).toEqual([quiet.taskId]);
  expect(getWorktreeByTask(e.env.db, busy.taskId)).not.toBeNull();
});

test("legacy kept/delivered rows are not counted in the kept cap", async () => {
  const { env } = await cloneEnv();
  insertWorktree(env.db, {
    ...LEGACY_WT_FIELDS,
    taskId: "legacy-1",
    threadId: "tl",
    repo: "ext",
    repoPath: "/r",
    path: "/p",
    branch: "agent/x",
    base: "main",
    workspace: "main",
    status: "kept",
  });
  expect(listKeptClones(env.db, "main")).toEqual([]);
});

test("insertApproval with a task id that has no task row works (no foreign keys in the schema)", async () => {
  const { env } = await cloneEnv();
  insertApproval(env.db, {
    id: "ab12cd34",
    turnId: crypto.randomUUID(),
    tool: "max_effort",
    summary: "s",
  });
  const n = env.db.query("SELECT COUNT(*) AS n FROM approvals").get() as { n: number };
  expect(n.n).toBe(1);
  expect(env.db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 0 });
});
