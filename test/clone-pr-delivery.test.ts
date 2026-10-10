import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { createGitMcp } from "../src/mcp/git-mcp";
import { finishCodeTask } from "../src/orchestrator/outputs/pr-output";
import { filesChangedText } from "../src/storage/files-changed";
import { getWorktreeByTask } from "../src/storage/worktree-store";
import { deliveryFor } from "../src/workspaces/task-clone";
import { cloneEnv, tid } from "./clone-fixture";
import { g, runCmd } from "./git-fixture";
import { stubGateway } from "./helpers";

// PR delivery of a clone: the app pushes `HEAD:refs/heads/<branch>` to the recorded origin url, friday/* only.
// The "GitHub" url is redirected to a local bare repo with url.<bare>.insteadOf: no network.

const git = createGitMcp();
afterAll(() => git.close());

const GITHUB = "git@github.com:Acme/widgets";
const ID = tid("cccc3333");
const author = { name: "Test User", email: "t@t.t" }; // makeRepo commits as t@t.t

/** Owner repo with a GitHub-looking origin, a clone with one commit, and the bare repo the push lands in. */
async function setup(rename?: string) {
  const e = await cloneEnv(GITHUB);
  const wt = await e.start(ID);
  const bare = join(e.env.home, "bare.git");
  await g(e.env.home, "init", "-q", "--bare", bare);
  await g(wt.path, "config", `url.${bare}.insteadOf`, GITHUB);
  await g(wt.path, "config", "user.email", author.email);
  await e.commit(wt.path, "b.txt", "two\n");
  let row = getWorktreeByTask(e.env.db, ID)!;
  if (rename) {
    await g(wt.path, "branch", "-m", rename);
    row = { ...row, branch: rename };
  }
  const pushed = async (b: string) =>
    (await runCmd(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${b}`], bare)).code === 0;
  const created: Record<string, unknown>[] = [];
  const run = (approve: boolean) =>
    finishCodeTask(
      {
        db: e.env.db,
        approvals: stubGateway({ confirm: async () => ({ approved: approve }) }),
        git,
        agentHome: e.env.home,
        createPr: async (a: any) => {
          created.push(a);
          return { ok: true as const, url: "https://github.com/Acme/widgets/pull/9" };
        },
      },
      {
        wt: row,
        taskId: ID,
        threadId: "th",
        title: "t",
        body: "b",
        text: "done",
        signal: new AbortController().signal,
        author,
      },
    );
  return { e, row, pushed, run, created: () => created };
}

test("clone with a GitHub origin: approve pushes friday/<branch> only, opens the PR, row delivered", async () => {
  const s = await setup();
  expect(s.row.delivery).toBe("pr");
  const reply = await s.run(true);
  expect(reply).toContain("PR: https://github.com/Acme/widgets/pull/9");
  expect(await s.pushed(s.row.branch)).toBe(true);
  expect(s.created()[0]).toMatchObject({
    owner: "Acme",
    repo: "widgets",
    head: s.row.branch,
    base: "main",
  });
  expect(getWorktreeByTask(s.e.env.db, ID)).toMatchObject({ status: "delivered", delivery: "pr" });
  expect(filesChangedText(s.e.env.db, ID)).toBe("1 (b.txt)"); // ledger data from the PR path's diffstat
});

test("declined: nothing is pushed, the clone is kept", async () => {
  const s = await setup();
  expect(await s.run(false)).toContain("not pushed");
  expect(await s.pushed(s.row.branch)).toBe(false);
  expect(s.created()).toHaveLength(0);
  expect(getWorktreeByTask(s.e.env.db, ID)?.status).toBe("kept");
});

test("a branch outside friday/* is never pushed", async () => {
  const s = await setup("feature/x");
  expect(await s.run(true)).toContain("refusing to publish non-agent branch");
  expect(await s.pushed("feature/x")).toBe(false);
  expect(s.created()).toHaveLength(0);
});

test("deliveryFor: only a github.com host is a PR origin", () => {
  expect(deliveryFor(GITHUB)).toBe("pr");
  expect(deliveryFor("https://github.com/Acme/widgets.git")).toBe("pr");
  expect(deliveryFor("https://user@github.com/Acme/widgets")).toBe("pr");
  expect(deliveryFor("https://evil.example/github.com/Acme/widgets")).toBe("local");
  expect(deliveryFor("ext::sh -c x github.com/a/b")).toBe("local");
  expect(deliveryFor("/srv/git/widgets.git")).toBe("local");
  expect(deliveryFor(null)).toBe("local");
});
