import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { createGitMcp } from "../src/mcp/git-mcp";
import { createTaskHandler } from "../src/orchestrator/handle-task";
import { listStages } from "../src/storage/stage-store";
import { EXIT_PLAN_MODE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { g, makeRepo } from "./git-fixture";
import {
  addRepo,
  clearWorkspaces,
  devIntent,
  makeEnv,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";

const git = createGitMcp();
afterAll(() => git.close());

/** Env with one workspace whose repo `real` is a real git clone (a managed clone). */
async function setup() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeRepo("main");
  const clone = workspacePaths(env.home).workspace("main").repo("real").clone;
  addRepo(env.home, "real", { gitAuthor: "Test User <test@example.com>" }, { path: clone });
  await g(env.home, "clone", "-q", src.repo, clone);
  return env;
}

/** Plan stage submits a plan and is aborted like the real flow; exec writes + commits, or ends on `execResult`. */
const fakeSdk = (execResult?: Record<string, unknown>) => (a: any) => {
  const o = a.options;
  return (async function* () {
    if (o.permissionMode === "plan") {
      const r = await o.canUseTool(EXIT_PLAN_MODE_TOOL_NAME, { plan: "repo: real\nadd b.txt" }, {});
      if (r.behavior === "allow") throw new Error("process aborted");
      yield resultMsg({ result: "plan rejected" });
      return;
    }
    if (execResult) {
      yield resultMsg(execResult);
      return;
    }
    writeFileSync(join(o.cwd, "b.txt"), "two\n");
    await g(o.cwd, "add", "b.txt");
    await g(
      o.cwd,
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "add b",
    );
    yield resultMsg({ result: "done", session_id: "sess-exec", total_cost_usd: 0.25 });
  })();
};

const msg = (text: string) => ({
  source: "t",
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId: "th1",
  text,
});

const handler = (env: Awaited<ReturnType<typeof setup>>, exec?: Record<string, unknown>) =>
  createTaskHandler({
    git,
    db: env.db,
    config: env.config,
    approvals: stubGateway({
      confirm: async () => ({ approved: false, reason: "owner declined" }),
    }),
    queryFn: fakeSdk(exec) as never,
    intent: devIntent(env.home),
  });

const codeTask = (env: Awaited<ReturnType<typeof setup>>) =>
  env.db.query<any, []>("SELECT * FROM tasks WHERE type = 'code' ORDER BY started_at").all();

test("stage rows: plan then exec, with model, cost and verdict; task keeps role, kind, parent and hop", async () => {
  const env = await setup();
  await handler(env)(msg("[dev] please add b.txt"));
  const [t] = codeTask(env);
  expect(t).toMatchObject({ role: "dev", kind: "staged", hop: 0, counts_toward_cap: 1 });
  expect(t.parent_task_id).toBeNull(); // opened by the intent layer: no source turn
  expect(env.db.query("SELECT id FROM tasks WHERE type = 'qa'").all()).toEqual([]);
  const stages = listStages(env.db, t.id);
  expect(stages.map((s) => [s.idx, s.name, s.status, s.verdict])).toEqual([
    [0, "plan", "done", "approved"],
    [1, "exec", "done", null],
  ]);
  expect(stages[0]!.model).toBe(env.config.models.sonnet);
  expect(stages[1]!.costUsd).toBeCloseTo(0.25);
  expect(stages[1]!.sessionId).toBe("sess-exec");
  expect(stages.every((s) => s.startedAt && s.endedAt)).toBe(true);
});

test("class design: the stage rows record the Opus model", async () => {
  const env = await setup();
  await handler(env)(msg("[design] [dev] please add b.txt"));
  const stages = listStages(env.db, codeTask(env)[0].id);
  expect(stages.map((s) => s.model)).toEqual([env.config.models.opus, env.config.models.opus]);
});

test("exec on its budget: stage row interrupted + verdict budget, reply offers `go +usd`, session kept", async () => {
  const env = await setup();
  const handle = handler(env, {
    subtype: "error_max_budget_usd",
    is_error: true,
    errors: ["budget"],
    total_cost_usd: 3.2,
    session_id: "sess-exec",
  });
  const reply = await handle(msg("[dev] please add b.txt"));
  const t = codeTask(env)[0];
  const stages = listStages(env.db, t.id);
  expect(stages.map((s) => [s.name, s.status, s.verdict])).toEqual([
    ["plan", "done", "approved"],
    ["exec", "interrupted", "budget"],
  ]);
  expect(stages[1]!.costUsd).toBeCloseTo(3.2);
  expect(reply).toContain("budget reached");
  expect(reply).toContain("`/go +");
});

test("follow-up in a worktree thread runs only the exec stage (row idx 1) on its own task", async () => {
  const env = await setup();
  const handle = handler(env);
  await handle(msg("[dev] please add b.txt"));
  await handle(msg("[dev] also add c"));
  const tasks = codeTask(env);
  expect(tasks).toHaveLength(2);
  expect(listStages(env.db, tasks[1].id).map((s) => [s.idx, s.name])).toEqual([[1, "exec"]]);
});
