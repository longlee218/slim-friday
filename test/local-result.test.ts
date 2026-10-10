import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionPost } from "../src/approvals/approval-types";
import { capStat } from "../src/orchestrator/outputs/diffstat-cap";
import {
  fetchCommand,
  finishLocalResult,
  PATCH_ATTACH_MAX_BYTES,
  RESULT_MESSAGE_MAX,
  shellQuote,
} from "../src/orchestrator/outputs/local-result-output";
import { filesChangedText } from "../src/storage/files-changed";
import { getWorktreeByTask } from "../src/storage/worktree-store";
import { cloneEnv, tid } from "./clone-fixture";
import { g } from "./git-fixture";
import { stubGateway } from "./helpers";

// Local delivery (P2.2): branch + fetch command + patch for a clone with no GitHub origin. Real git, no network.

const ID = tid("aaaa1111");

/** Env with one clone holding one commit and a gateway that records the posted decision. */
async function delivered(files: [string, string][] = [["b.txt", "two\n"]]) {
  /** Flip to true to simulate a follow-up holding the thread lock. */
  const busy = { on: false };
  const e = await cloneEnv();
  const wt = await e.start(ID);
  for (const [n, c] of files) await e.commit(wt.path, n, c);
  const posts: DecisionPost[] = [];
  const approvals = stubGateway({
    postDecision: async (r) => {
      posts.push(r);
      return true;
    },
  });
  const run = () =>
    finishLocalResult(
      { db: e.env.db, approvals, agentHome: e.env.home, threadBusy: () => busy.on },
      { wt: getWorktreeByTask(e.env.db, ID)!, taskId: ID, threadId: "th", text: "done" },
    );
  return { ...e, wt, posts, run, busy };
}

test("local result: message carries the exact fetch command, stat, patch; row is delivered", async () => {
  const d = await delivered();
  const reply = await d.run();
  const post = d.posts[0]!;
  expect(post.content).toContain(
    `git -C ${d.src.repo} fetch ${d.wt.path} ${d.wt.branch}:${d.wt.branch}`,
  );
  expect(post.content).toContain(`${d.wt.branch}`);
  expect(post.content).toContain("1 commit(s)");
  expect(post.content).toContain("b.txt");
  expect(post.content).toContain("/cleanup aaaa1111");
  expect(post.content.length).toBeLessThanOrEqual(RESULT_MESSAGE_MAX);
  expect(reply).toContain("Result posted");
  const patch = join(d.env.paths.workspace("main").task(ID).root, "aaaa1111.patch");
  expect(post.filePath).toBe(patch);
  expect(readFileSync(patch, "utf8")).toContain("+two");
  expect(getWorktreeByTask(d.env.db, ID)).toMatchObject({
    status: "delivered",
    delivery: "local",
    patchPath: patch,
  });
  expect(filesChangedText(d.env.db, ID)).toBe("1 (b.txt)"); // ledger data from the delivery diffstat
  // The app never ran the fetch: the owner repo has no task branch.
  expect(await g(d.src.repo, "branch", "--list")).not.toContain("friday/");
});

test("local result: a secret in the diff blocks the patch and the message", async () => {
  const d = await delivered([["k.txt", "key AKIAABCDEFGHIJKLMNOP\n"]]);
  const reply = await d.run();
  expect(reply).toContain("Possible secret");
  expect(d.posts).toHaveLength(0);
  const task = d.env.paths.workspace("main").task(ID).root;
  expect(existsSync(join(task, "aaaa1111.patch"))).toBe(false);
  expect(getWorktreeByTask(d.env.db, ID)?.status).toBe("active");
});

test("local result: a patch over 1 MB is not attached, its path is named", async () => {
  const big = "lorem ipsum dolor\n".repeat(Math.ceil(PATCH_ATTACH_MAX_BYTES / 17) + 10);
  const d = await delivered([["big.txt", big]]);
  await d.run();
  expect(d.posts[0]!.filePath).toBeUndefined();
  expect(d.posts[0]!.content).toContain("too large to attach");
});

test("local result: many files are capped, the message stays under the limit", async () => {
  const files = Array.from({ length: 80 }, (_, i): [string, string] => [
    `some-long-file-name-number-${i}.txt`,
    "x\n",
  ]);
  const d = await delivered(files);
  await d.run();
  const c = d.posts[0]!.content;
  expect(c.length).toBeLessThanOrEqual(RESULT_MESSAGE_MAX);
  expect(c).toMatch(/\+\d+ more files/);
  expect(c).toContain("80 files changed");
});

test("local result: no commits -> no message; invalid row fails closed", async () => {
  const e = await cloneEnv();
  const wt = await e.start(ID);
  const approvals = stubGateway({ postDecision: async () => true });
  const deps = { db: e.env.db, approvals, agentHome: e.env.home };
  const input = { taskId: ID, threadId: "th", text: "done" };
  expect(await finishLocalResult(deps, { ...input, wt })).toContain("No commits");
  const bad = { ...wt, workspace: "../x" };
  expect(await finishLocalResult(deps, { ...input, wt: bad })).toContain("row is invalid");
});

test("Keep marks the clone kept; Discard removes it; a second click is expired", async () => {
  const keep = await delivered();
  await keep.run();
  expect(await keep.posts[0]!.onClick("keep")).toContain("Kept");
  expect(getWorktreeByTask(keep.env.db, ID)?.status).toBe("kept");
  expect(await keep.posts[0]!.onClick("discard")).toContain("expired"); // decided row: no effect
  expect(existsSync(keep.wt.path)).toBe(true);

  const drop = await delivered();
  await drop.run();
  expect(await drop.posts[0]!.onClick("discard")).toContain("Discarded");
  expect(existsSync(drop.wt.path)).toBe(false);
  expect(getWorktreeByTask(drop.env.db, ID)).toBeNull();
});

test("Discard is refused while a task holds the thread lock; the clone and row stay, then it works", async () => {
  const d = await delivered();
  await d.run();
  d.busy.on = true;
  const refused = await d.posts[0]!.onClick("discard");
  expect(refused).toContain("Not discarded");
  expect(refused).toContain("/cleanup aaaa1111");
  expect(existsSync(d.wt.path)).toBe(true);
  expect(getWorktreeByTask(d.env.db, ID)?.status).toBe("delivered");
  d.busy.on = false;
  expect(await d.posts[0]!.onClick("discard")).toContain("Discarded");
  expect(existsSync(d.wt.path)).toBe(false);
});

test("shell quoting is for display; capStat keeps the summary line", () => {
  expect(shellQuote("/a/b-c_d.txt")).toBe("/a/b-c_d.txt");
  expect(shellQuote("/my repo/it's")).toBe(`'/my repo/it'\\''s'`);
  expect(fetchCommand({ repoPath: "/my repo", path: "/c", branch: "friday/x" } as never)).toBe(
    "git -C '/my repo' fetch /c friday/x:friday/x",
  );
  const stat = [" a | 1 +", " b | 1 +", " c | 1 +", " 3 files changed"].join("\n");
  expect(capStat(stat, 30)).toBe("+3 more files\n 3 files changed");
});
