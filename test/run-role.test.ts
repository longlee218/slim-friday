import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { ASK_USER_QUESTION_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { g, makeRepo } from "./git-fixture";
import {
  addRepo,
  clearWorkspaces,
  devIntent,
  initMsg,
  makeEnv,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";

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

/**
 * The dev run asks the owner to approve its plan (AskUserQuestion through canUseTool), then edits, commits and ends with
 * the report + `repo: real` marker; or ends on `result` (budget, error).
 */
const fakeSdk = (result?: Record<string, unknown>) => (a: any) => {
  const o = a.options;
  return (async function* () {
    yield { ...initMsg, session_id: "sess-dev", cwd: o.cwd } as never;
    const ans = await o.canUseTool(
      ASK_USER_QUESTION_TOOL_NAME,
      {
        questions: [
          {
            question: "Plan: add b.txt. Approve?",
            options: [{ label: "Approve" }, { label: "Revise" }],
          },
        ],
      },
      {},
    );
    if (ans.behavior !== "allow") throw new Error("ask denied");
    if (result) {
      yield resultMsg(result);
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
    yield resultMsg({
      result: "done: b.txt added\n\nrepo: real",
      session_id: "sess-dev",
      total_cost_usd: 0.25,
    });
  })();
};

const msg = (text: string) => ({
  source: "t",
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId: "th1",
  text,
});

const asked: string[] = [];

const handler = (env: Awaited<ReturnType<typeof setup>>, result?: Record<string, unknown>) =>
  createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: stubGateway({
      askChoice: async (a) => {
        asked.push(a.question);
        return a.options[0];
      },
      confirm: async () => ({ approved: false, reason: "owner declined" }),
    }),
    queryFn: fakeSdk(result) as never,
    intent: devIntent(env.home),
  });

const codeTask = (env: Awaited<ReturnType<typeof setup>>) =>
  env.db.query<any, []>("SELECT * FROM turns WHERE type = 'code' ORDER BY started_at").all();

const runsOf = (env: Awaited<ReturnType<typeof setup>>, turnId: string) =>
  env.db.query<any, [string]>("SELECT * FROM runs WHERE turn_id = ?").all(turnId);

test("one dev run: the plan approval is a normal ask, then it edits; ONE runs row with model and cost; repo from the marker", async () => {
  const env = await setup();
  asked.length = 0;
  const reply = await handler(env)(msg("[dev] please add b.txt"));
  const [t] = codeTask(env);
  expect(t).toMatchObject({
    role: "dev",
    kind: "single",
    hop: 0,
    counts_toward_cap: 1,
    status: "done",
    repo: "real",
  });
  expect(t.parent_turn_id).toBeNull(); // opened by the intent layer: no source turn
  expect(asked).toEqual(["Plan: add b.txt. Approve?"]); // the approval reached the owner through the ask relay
  const runs = runsOf(env, t.id);
  expect(runs).toHaveLength(1);
  expect(runs[0].model).toBe(env.config.models.sonnet);
  expect(runs[0].cost_usd).toBeCloseTo(0.25);
  expect(reply).toContain("done: b.txt added");
  expect(reply).not.toContain("repo: real"); // the marker is the app's, not the owner's reply
  // The dev session is the turn row's, never the thread's.
  expect(env.db.query("SELECT session_id FROM sessions").get()).toBeNull();
  expect(t.session_id).toBe("sess-dev");
});

test("class design: the run row records the Opus model", async () => {
  const env = await setup();
  await handler(env)(msg("[design] [dev] please add b.txt"));
  expect(runsOf(env, codeTask(env)[0].id)[0].model).toBe(env.config.models.opus);
});

test("a final report without a valid `repo:` marker keeps the repo of the row; memory is skipped", async () => {
  const env = await setup();
  const handle = handler(env, { result: "done\n\nrepo: nope", total_cost_usd: 0.1 });
  await handle(msg("[dev] please add b.txt"));
  // One registered repo: the sole repo is the run's repo even without a valid marker.
  expect(codeTask(env)[0].repo).toBe("real");
});

test("dev on its budget: failed_resumable, reply offers `go +usd`, run row keeps the cost, session kept on the row", async () => {
  const env = await setup();
  const handle = handler(env, {
    subtype: "error_max_budget_usd",
    is_error: true,
    errors: ["budget"],
    total_cost_usd: 3.2,
    session_id: "sess-dev",
  });
  const reply = await handle(msg("[dev] please add b.txt"));
  const t = codeTask(env)[0];
  expect(t.status).toBe("failed_resumable");
  expect(runsOf(env, t.id)[0]).toMatchObject({ outcome: "max_budget" });
  expect(runsOf(env, t.id)[0].cost_usd).toBeCloseTo(3.2);
  expect(reply).toContain("budget reached");
  expect(reply).toContain("`/go +");
  expect(env.db.query("SELECT session_id FROM sessions").get()).toBeNull();
});

test("a second dev message in the thread is a new task with its own run", async () => {
  const env = await setup();
  const handle = handler(env);
  await handle(msg("[dev] please add b.txt"));
  await handle(msg("[dev] also add c"));
  const tasks = codeTask(env);
  expect(tasks).toHaveLength(2);
  expect(runsOf(env, tasks[1].id)).toHaveLength(1);
});
