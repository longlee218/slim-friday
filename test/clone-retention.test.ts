import { expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config/agent-config";
import { DAY_MS, expireClones } from "../src/lifecycle/clone-retention";
import { checkWorktrees, runStartupHygiene } from "../src/lifecycle/startup";
import { keptClonesRefusal, MAX_KEPT_CLONES } from "../src/orchestrator/dispatch/task-repo";
import { RESUME_PROMPT } from "../src/orchestrator/message-commands";
import { resolveCommand } from "../src/orchestrator/message-routing";
import {
  insertTask,
  latestTaskSession,
  setTaskSession,
  setTaskStatus,
} from "../src/storage/run-store";
import {
  getWorktreeByTask,
  insertWorktree,
  listWorktrees,
  setDelivered,
  setWorktreeStatus,
} from "../src/storage/worktree-store";
import { cloneEnv, tid } from "./clone-fixture";
import { LEGACY_WT_FIELDS } from "./git-fixture";
import { makeEnv } from "./helpers";

// Retention, orphan scan, kept-clones cap and resume of a missing clone (P2.2). Real git + fs, no network.

const OLD = Date.now() - 20 * DAY_MS;

/** Age a row: delivered_at and created_at in the past. */
const age = (e: Awaited<ReturnType<typeof cloneEnv>>, id: string, at: number) =>
  e.env.db
    .query("UPDATE worktrees SET delivered_at = ?, created_at = ? WHERE task_id = ?")
    .run(at, at, id);

test("config: CLONE_RETENTION_DAYS defaults to 14 and reads the env", () => {
  expect(makeEnv().config.cloneRetentionDays).toBe(14);
  expect(loadConfig({ AGENT_HOME: "/x", CLONE_RETENTION_DAYS: "3" }).cloneRetentionDays).toBe(3);
});

test("expireClones: old delivered|kept clones go (dir, patch, row); recent, active and legacy rows stay", async () => {
  const e = await cloneEnv();
  const ids = [tid("00000001"), tid("00000002"), tid("00000003"), tid("00000004")];
  const wts = [];
  for (const id of ids) wts.push(await e.start(id, `th-${id.slice(0, 8)}`));
  const patch = join(e.env.paths.workspace("main").task(ids[0]!).root, "00000001.patch");
  writeFileSync(patch, "p");
  setDelivered(e.env.db, ids[0]!, "local", patch); // old delivered -> removed
  setWorktreeStatus(e.env.db, ids[1]!, "kept"); // old kept -> removed
  setDelivered(e.env.db, ids[2]!, "local", null); // recent delivered -> stays
  // ids[3] stays `active` and old -> stays
  age(e, ids[0]!, OLD);
  age(e, ids[1]!, OLD);
  age(e, ids[3]!, OLD);
  insertWorktree(e.env.db, {
    ...LEGACY_WT_FIELDS,
    taskId: "legacy",
    threadId: "tl",
    repo: "ext",
    repoPath: e.src.repo,
    path: "/nowhere",
    branch: "agent/x",
    base: "main",
    status: "kept",
    createdAt: OLD,
  });
  expect(expireClones(e.env.db, e.env.home, 14).sort()).toEqual([ids[0]!, ids[1]!].sort());
  expect(existsSync(wts[0]!.path) || existsSync(wts[1]!.path) || existsSync(patch)).toBe(false);
  expect(existsSync(wts[2]!.path) && existsSync(wts[3]!.path)).toBe(true);
  expect(
    listWorktrees(e.env.db)
      .map((w) => w.taskId)
      .sort(),
  ).toEqual([ids[2]!, ids[3]!, "legacy"].sort());
});

test("orphan scan: a dir without row is removed only when older than the retention; a lost active row is dropped", async () => {
  const e = await cloneEnv();
  const root = e.env.paths.workspace("main").repo("ext").worktrees;
  const lost = await e.start(tid("00000005"));
  await Bun.$`rm -rf ${lost.path}`;
  const oldDir = join(root, "old-orphan");
  const newDir = join(root, "new-orphan");
  mkdirSync(oldDir, { recursive: true });
  mkdirSync(newDir, { recursive: true });
  utimesSync(oldDir, new Date(OLD), new Date(OLD));
  const r = checkWorktrees(e.env.db, e.env.home, 14);
  expect(r.noRow.sort()).toEqual([newDir, oldDir].sort());
  expect(r.removedOrphans).toEqual([oldDir]);
  expect(existsSync(oldDir)).toBe(false);
  expect(existsSync(newDir)).toBe(true);
  expect(r.missingDir).toEqual([lost.taskId]);
  expect(getWorktreeByTask(e.env.db, lost.taskId)).toBeNull();
});

test("runStartupHygiene applies the retention it is given", async () => {
  const e = await cloneEnv();
  const wt = await e.start(tid("00000006"));
  setDelivered(e.env.db, wt.taskId, "local", null);
  age(e, wt.taskId, Date.now() - 2 * DAY_MS);
  await runStartupHygiene(e.env.db, e.env.home, 14);
  expect(existsSync(wt.path)).toBe(true);
  await runStartupHygiene(e.env.db, e.env.home, 1);
  expect(existsSync(wt.path)).toBe(false);
});

/** Insert `n` synthetic clone rows of a workspace with the given status/delivery. */
function rows(
  db: ReturnType<typeof makeEnv>["db"],
  n: number,
  ws: string,
  status: "kept" | "delivered",
  delivery: "pr" | "local",
) {
  for (let i = 0; i < n; i++)
    insertWorktree(db, {
      ...LEGACY_WT_FIELDS,
      taskId: `${ws}-${status}-${delivery}-${i}`,
      threadId: `t${i}`,
      repo: "ext",
      repoPath: "/r",
      path: "/p",
      branch: `friday/0000000${i}-x`,
      base: "main",
      workspace: ws,
      baseSha: "a".repeat(40),
      status,
      delivery,
    });
}

test("kept-clones cap: the 11th is refused with the list and a /cleanup hint", () => {
  const { db } = makeEnv();
  rows(db, MAX_KEPT_CLONES - 1, "main", "kept", "local");
  rows(db, 3, "main", "delivered", "pr"); // PR-delivered: not held by the owner
  rows(db, 5, "other", "kept", "local"); // another workspace
  expect(keptClonesRefusal(db, "main")).toBeUndefined();
  rows(db, 1, "main", "delivered", "local");
  const refusal = keptClonesRefusal(db, "main")!;
  expect(refusal.reason).toBe("kept_clones_limit");
  expect(refusal.reply).toContain("/cleanup <taskId8>");
  expect(refusal.reply).toContain("friday/00000000-x");
});

test("resume with the clone dir gone: the task is failed and the reply says why", async () => {
  const e = await cloneEnv();
  const wt = await e.start(tid("00000007"));
  insertTask(e.env.db, { id: "task-1", threadId: "th", source: "t", repo: "ext", role: "dev" });
  setTaskSession(e.env.db, "task-1", "sess", realpathSync(wt.path)); // the run stores a real cwd
  setTaskStatus(e.env.db, "task-1", "interrupted");
  const deps = { db: e.env.db, agentHome: e.env.home, workspace: "main", repos: [e.repo] };
  const resume = { kind: "resume" } as const;
  expect(resolveCommand(deps as never, resume, "th")).toMatchObject({
    cmd: { text: RESUME_PROMPT },
  });
  await Bun.$`rm -rf ${wt.path}`;
  const out = resolveCommand(deps as never, resume, "th");
  expect(out).toMatchObject({ reason: "clone_missing" });
  expect((out as { reply: string }).reply).toContain("clone is gone");
  expect(latestTaskSession(e.env.db, "th")?.status).toBe("failed");
});
