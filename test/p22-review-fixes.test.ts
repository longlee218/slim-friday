import { expect, test } from "bun:test";
import { createDecisionPoster } from "../src/approvals/clone-decision";
import { DAY_MS, expireClones } from "../src/lifecycle/clone-retention";
import { createGitMcp } from "../src/mcp/git-mcp";
import {
  finishLocalResult,
  RESULT_MESSAGE_MAX,
} from "../src/orchestrator/outputs/local-result-output";
import { finishCodeTask } from "../src/orchestrator/outputs/pr-output";
import { insertApproval } from "../src/storage/approval-store";
import { insertTask } from "../src/storage/run-store";
import { getWorktreeByTask, insertWorktree, listKeptClones } from "../src/storage/worktree-store";
import { hasCredentials, safeOriginUrl } from "../src/workspaces/origin-url";
import { deliveryFor } from "../src/workspaces/task-clone";
import { cloneEnv, tid } from "./clone-fixture";
import { g, LEGACY_WT_FIELDS } from "./git-fixture";
import { stubGateway } from "./helpers";

// Review fixes of P2.2: origin credentials, push error redaction, full-diff scan, activity-based retention,
// click restore, fetch command under the cap, legacy rows out of the cap. Real git + fs, no network.

const author = { name: "Test User", email: "t@t.t" };
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

test("a clone of a repo whose origin carries credentials stores no url and is delivered locally", async () => {
  const e = await cloneEnv(`https://u:${TOKEN}@github.com/Acme/widgets.git`);
  const wt = await e.start(tid("dddd0001"));
  expect(wt.originUrl).toBeNull();
  expect(wt.delivery).toBe("local");
  expect(JSON.stringify(getWorktreeByTask(e.env.db, wt.taskId))).not.toContain(TOKEN);
  expect(deliveryFor(wt.originUrl)).toBe("local");
  await e.commit(wt.path, "b.txt", "two\n");
  const posts: string[] = [];
  const reply = await finishLocalResult(
    {
      db: e.env.db,
      agentHome: e.env.home,
      approvals: stubGateway({ postDecision: async (r) => (posts.push(r.content), true) }),
    },
    { wt, taskId: wt.taskId, threadId: "th", text: "done" },
  );
  expect(posts[0]).toContain("No origin url used");
  expect(posts[0]).not.toContain(TOKEN);
  expect(reply).not.toContain(TOKEN);
});

/** A GitHub-origin clone with a commit; `insteadOf` rewrites the url so the push fails locally. */
async function prSetup(insteadOf?: string) {
  const e = await cloneEnv("git@github.com:Acme/widgets");
  const wt = await e.start(tid("dddd0002"));
  if (insteadOf)
    await g(wt.path, "config", `url.${insteadOf}.insteadOf`, "git@github.com:Acme/widgets");
  await g(wt.path, "config", "user.email", author.email);
  return { e, wt };
}

test("a failed push never puts a secret from git's error into the owner reply", async () => {
  const { e, wt } = await prSetup(`/nonexistent/${TOKEN}`);
  await e.commit(wt.path, "b.txt", "two\n");
  const git = createGitMcp();
  try {
    const reply = await finishCodeTask(
      {
        db: e.env.db,
        git,
        agentHome: e.env.home,
        approvals: stubGateway({ confirm: async () => ({ approved: true }) }),
      },
      {
        wt: getWorktreeByTask(e.env.db, wt.taskId)!,
        taskId: wt.taskId,
        threadId: "th",
        title: "t",
        body: "b",
        text: "done",
        signal: new AbortController().signal,
        author,
      },
    );
    expect(reply).toContain("PR failed");
    expect(reply).not.toContain(TOKEN);
  } finally {
    await git.close();
  }
});

test("a secret after the 200 KB diff cap still blocks the PR offer", async () => {
  const { e, wt } = await prSetup();
  await e.commit(wt.path, "big.txt", `${"x".repeat(100)}\n`.repeat(2500) + `key=${TOKEN}\n`);
  const git = createGitMcp();
  let asked = 0;
  try {
    const reply = await finishCodeTask(
      {
        db: e.env.db,
        git,
        agentHome: e.env.home,
        approvals: stubGateway({ confirm: async () => (asked++, { approved: true }) }),
      },
      {
        wt: getWorktreeByTask(e.env.db, wt.taskId)!,
        taskId: wt.taskId,
        threadId: "th",
        title: "t",
        body: "b",
        text: "done",
        signal: new AbortController().signal,
        author,
      },
    );
    expect(reply).toContain("Possible secret");
    expect(asked).toBe(0);
  } finally {
    await git.close();
  }
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
  insertTask(e.env.db, {
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
    taskId: crypto.randomUUID(),
    tool: "max_effort",
    summary: "s",
  });
  const n = env.db.query("SELECT COUNT(*) AS n FROM approvals").get() as { n: number };
  expect(n.n).toBe(1);
  expect(env.db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 0 });
});

test("clone decision: a throwing onClick keeps the entry and answers an error; a retry works", async () => {
  const sent: unknown[] = [];
  const client = {
    channels: {
      fetch: async () => ({ isSendable: () => true, send: async (m: unknown) => sent.push(m) }),
    },
  } as never;
  const poster = createDecisionPoster({ getClient: () => client, ownerId: "o" });
  const id = tid("dddd0005");
  let calls = 0;
  await poster.post({
    taskId: id,
    threadId: "th",
    content: "r",
    onClick: async () => {
      if (++calls === 1) throw new Error("boom");
      return "ok";
    },
  });
  const click = async () => {
    const out: { reply?: string; update?: string } = {};
    await poster.handle({
      isButton: () => true,
      customId: `clone:keep:${id}`,
      user: { id: "o" },
      reply: async (r: { content: string }) => {
        out.reply = r.content;
      },
      update: async (r: { content: string }) => {
        out.update = r.content;
      },
    } as never);
    return out;
  };
  expect((await click()).reply).toContain("failed");
  expect((await click()).update).toContain("ok");
});

test("local result: the fetch command stays whole under the cap and ``` in a path cannot close the fence", async () => {
  const e = await cloneEnv();
  const wt = await e.start(tid("dddd0006"));
  for (let i = 0; i < 40; i++) await e.commit(wt.path, `file-${i}-${"n".repeat(30)}.txt`, "x\n");
  const row = {
    ...getWorktreeByTask(e.env.db, wt.taskId)!,
    repoPath: `/${"d".repeat(400)}/a\`\`\`b`,
  };
  const posts: string[] = [];
  await finishLocalResult(
    {
      db: e.env.db,
      agentHome: e.env.home,
      approvals: stubGateway({ postDecision: async (r) => (posts.push(r.content), true) }),
    },
    { wt: row, taskId: wt.taskId, threadId: "th", text: "done" },
  );
  const c = posts[0]!;
  expect(c.length).toBeLessThanOrEqual(RESULT_MESSAGE_MAX);
  expect(c).toContain(` fetch ${wt.path} ${wt.branch}:${wt.branch}\n\`\`\``); // command intact to its end
  expect(c.match(/```/g)?.length).toBe(4); // only the two real fences
});
