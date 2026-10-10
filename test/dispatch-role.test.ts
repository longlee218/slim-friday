import { afterAll, expect, test } from "bun:test";
import { workspacePaths } from "../src/config/workspace-paths";
import { createGitMcp } from "../src/mcp/git-mcp";
import { dispatchRole } from "../src/orchestrator/dispatch/dispatch-role";
import { createTaskHandler } from "../src/orchestrator/handle-task";
import { listPendingProposals } from "../src/storage/proposal-store";
import { insertTask } from "../src/storage/run-store";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { g, makeRepo } from "./git-fixture";
import {
  addRepo,
  BRIEF,
  clearWorkspaces,
  devIntent,
  makeEnv,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";

const git = createGitMcp();
afterAll(() => git.close());

async function setup() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeRepo("main");
  const clone = workspacePaths(env.home).workspace("main").repo("real").clone;
  addRepo(env.home, "real", { gitAuthor: "T <t@example.com>" }, { path: clone });
  await g(env.home, "clone", "-q", src.repo, clone);
  return { env, repos: loadWorkspaces(env.home).workspaces[0]!.repos };
}

const task = { source: "t", channelId: TEST_CHANNEL, userId: "u", threadId: "th1", text: "x" };
const rows = (env: { db: any }, sql: string) => env.db.query(sql).all() as any[];

/** Dispatcher deps whose stage runs would be captured (none must start in the refusal tests). */
const deps = (env: Awaited<ReturnType<typeof setup>>["env"], runs: unknown[]) => ({
  git,
  db: env.db,
  config: env.config,
  approvals: stubGateway(),
  queryFn: ((a: unknown) => {
    runs.push(a);
    return (async function* () {})();
  }) as never,
  stopping: () => false,
});

test("ordering: the proposal is persisted and validated before the plan stage runs; no assistant turn first", async () => {
  const { env } = await setup();
  const events: string[] = [];
  const query = (a: any) => {
    // Stage run = dispatch happened: the proposal row must already exist.
    events.push(
      `stage-run ${a.options.permissionMode} proposals=${rows(env, "SELECT 1 FROM proposals").length}`,
    );
    return (async function* () {
      yield resultMsg();
    })();
  };
  const handle = createTaskHandler({
    git,
    db: env.db,
    config: env.config,
    approvals: stubGateway(),
    queryFn: query as never,
    intent: devIntent(env.home),
  });
  await handle({ ...task, text: "[dev] add a file with the answer" });
  expect(events).toEqual(["stage-run plan proposals=1"]);
  expect(rows(env, "SELECT status FROM proposals")).toEqual([{ status: "dispatched" }]);
});

test("ask rule: unknown repo -> ONE question, proposal stays pending, no task row, no run", async () => {
  const { env, repos } = await setup();
  const runs: unknown[] = [];
  const reply = await dispatchRole(deps(env, runs), {
    request: { role: "dev", brief: BRIEF, repo: "nope" },
    task,
    reply: "Q&A answer",
    workspace: "main",
    repos,
    ac: new AbortController(),
  });
  expect(reply).toContain("Q&A answer");
  expect(reply).toContain('Unknown repo "nope"');
  expect(reply).toContain("Send the task again with repo:<name>");
  expect(listPendingProposals(env.db)).toHaveLength(1);
  expect(rows(env, "SELECT 1 FROM tasks")).toEqual([]);
  expect(runs).toEqual([]);
});

test("refusal (cap full): proposal refused, reply says busy, nothing starts", async () => {
  const { env, repos } = await setup();
  for (const id of ["a", "b"])
    insertTask(env.db, { id, threadId: id, source: "t", repo: "real", role: "dev" });
  const runs: unknown[] = [];
  const reply = await dispatchRole(deps(env, runs), {
    request: { role: "dev", brief: BRIEF },
    task,
    reply: "",
    workspace: "main",
    repos,
    ac: new AbortController(),
  });
  expect(reply).toContain("busy");
  expect(rows(env, "SELECT status, role FROM proposals")).toEqual([
    { status: "refused", role: "dev" },
  ]);
  expect(runs).toEqual([]);
});

test("owner `go` on a pending proposal: confirmed, re-validated, dispatched with parent + hop", async () => {
  const { env, repos } = await setup();
  const runs: any[] = [];
  const d = deps(env, runs);
  // Low confidence: asked once, stays pending ...
  const first = await dispatchRole(d, {
    request: { role: "dev", brief: BRIEF, confidence: 0.1 },
    task,
    reply: "",
    workspace: "main",
    repos,
    ac: new AbortController(),
  });
  expect(first).toContain("Reply `go`");
  const [p] = listPendingProposals(env.db);
  expect(p!.confidence).toBeCloseTo(0.1);
  // ... then `go` (confirmed) starts it and marks it dispatched.
  await dispatchRole(d, {
    request: {
      role: p!.role,
      brief: p!.brief,
      confidence: 0.1,
      proposalId: p!.id,
      confirmed: true,
    },
    task,
    reply: "",
    workspace: "main",
    repos,
    ac: new AbortController(),
    fromTaskId: "src-task",
  });
  expect(runs).toHaveLength(1); // the plan stage ran
  expect(rows(env, "SELECT status FROM proposals")).toEqual([{ status: "dispatched" }]);
  expect(rows(env, "SELECT role, kind, parent_task_id, hop, proposal_id FROM tasks")).toEqual([
    { role: "dev", kind: "staged", parent_task_id: "src-task", hop: 1, proposal_id: p!.id },
  ]);
});

test("new ask supersedes the thread's older pending proposals; go on an invalid proposal replies once and refuses it", async () => {
  const { env, repos } = await setup();
  const runs: unknown[] = [];
  const d = deps(env, runs);
  const send = (request: any) =>
    dispatchRole(d, {
      request,
      task,
      reply: "",
      workspace: "main",
      repos,
      ac: new AbortController(),
    });
  await send({ role: "dev", brief: BRIEF, repo: "nope" });
  await send({ role: "dev", brief: BRIEF, repo: "nope2" });
  const pending = listPendingProposals(env.db);
  expect(pending).toHaveLength(1);
  expect(pending[0]!.repo).toBe("nope2");
  expect(rows(env, "SELECT status FROM proposals ORDER BY created_at, rowid")).toEqual([
    { status: "expired" },
    { status: "pending" },
  ]);
  // `go` (proposalId set, confirmed) still fails validation: one reply, then it is final (no loop).
  const p = pending[0]!;
  const reply = await send({
    role: p.role,
    brief: p.brief,
    repo: "nope2",
    proposalId: p.id,
    confirmed: true,
  });
  expect(reply).toContain('Unknown repo "nope2"');
  expect(reply).toContain("Send a new request");
  expect(listPendingProposals(env.db)).toEqual([]);
  expect(rows(env, "SELECT status FROM proposals WHERE id = ?".replace("?", `'${p.id}'`))).toEqual([
    { status: "refused" },
  ]);
  expect(runs).toEqual([]);
});

test("a proposal that is no longer pending is never started twice", async () => {
  const { env, repos } = await setup();
  const runs: unknown[] = [];
  const d = deps(env, runs);
  await dispatchRole(d, {
    request: { role: "dev", brief: BRIEF, confidence: 0.1 },
    task,
    reply: "",
    workspace: "main",
    repos,
    ac: new AbortController(),
  });
  const [p] = listPendingProposals(env.db);
  env.db.query("UPDATE proposals SET status = 'dispatched' WHERE id = ?").run(p!.id);
  const reply = await dispatchRole(d, {
    request: { role: "dev", brief: BRIEF, proposalId: p!.id, confirmed: true },
    task,
    reply: "",
    workspace: "main",
    repos,
    ac: new AbortController(),
  });
  expect(reply).toContain("no longer pending");
  expect(runs).toEqual([]);
});
