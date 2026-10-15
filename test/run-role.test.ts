import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { g, makeLocation } from "./git-fixture";
import {
  addLocation,
  clearWorkspaces,
  defaultLocationPath,
  initMsg,
  makeEnv,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";
import { noticeSink, workersDone } from "./lead-harness";

/** Env with one workspace whose location `real` is a real git clone (a managed clone). */
async function setup() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeLocation("main");
  const clone = defaultLocationPath(env.home, "real", "main");
  addLocation(env.home, "real", { gitAuthor: "Test User <test@example.com>" }, { path: clone });
  await g(env.home, "clone", "-q", src.location, clone);
  return env;
}

/**
 * The dev worker edits, commits and ends with the report + `location: real` marker; or ends on `result` (budget, error).
 * No plan approval here: a worker's ask is relayed to the lead (covered by lead-flow).
 */
const fakeSdk = (result?: Record<string, unknown>) => (a: any) => {
  const o = a.options;
  return (async function* () {
    yield { ...initMsg, session_id: "sess-dev", cwd: o.cwd } as never;
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
    // The typed result a worker ends with: what decides the task status.
    await o.mcpServers.worker.instance._registeredTools.ReportResult.handler(
      { status: "COMPLETED", summary: "b.txt added" },
      {},
    );
    yield resultMsg({
      result: "done: b.txt added\n\nlocation: real",
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

const handler = (env: Awaited<ReturnType<typeof setup>>, result?: Record<string, unknown>) =>
  createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: stubGateway(),
    queryFn: fakeSdk(result) as never,
    leadTiming: { debounceMs: 10, announceWindowMs: 20 },
  });

/** Send one message and wait until its detached worker settled (the worker's text is never returned). */
const send = async (
  h: ReturnType<typeof handler>,
  env: Awaited<ReturnType<typeof setup>>,
  text: string,
) => {
  const sink = noticeSink();
  const out = await h({ ...msg(text), notify: sink.notify });
  const reply = out ?? (await sink.first()); // a role tag answers through the lead queue
  await workersDone(env.db);
  return reply;
};

const codeTask = (env: Awaited<ReturnType<typeof setup>>) =>
  env.db.query<any, []>("SELECT * FROM turns WHERE role != 'lead' ORDER BY started_at").all();

const runsOf = (env: Awaited<ReturnType<typeof setup>>, turnId: string) =>
  env.db.query<any, [string]>("SELECT * FROM runs WHERE turn_id = ?").all(turnId);

test("one dev run: ONE runs row with model and cost; the worker's text is not returned; location from the marker", async () => {
  const env = await setup();
  const reply = await send(handler(env), env, "[dev] please add b.txt");
  expect(reply).toContain("starting"); // the fixed start notice, not the worker's report
  const [t] = codeTask(env);
  expect(t).toMatchObject({
    role: "dev",
    kind: "single",
    hop: 1,
    counts_toward_cap: 1,
    status: "done",
    location: "real",
  });
  const runs = runsOf(env, t.id);
  expect(runs).toHaveLength(1);
  expect(runs[0].model).toBe(env.config.models.sonnet);
  expect(runs[0].cost_usd).toBeCloseTo(0.25);
  // The dev session is the turn row's, never the thread's.
  expect(env.db.query("SELECT session_id FROM sessions").get()).toBeNull();
  expect(t.session_id).toBe("sess-dev");
  // The typed result of the owned task carries the report; the marker line is the app's, not the owner's.
  const task = env.db.query<any, []>("SELECT * FROM owned_tasks WHERE parent_id IS NOT NULL").get();
  expect(task?.status).toBe("completed");
  expect(task?.result_excerpt ?? "").not.toContain("location: real");
});

test("a final report without a valid `location:` marker keeps the location of the row", async () => {
  const env = await setup();
  const handle = handler(env, { result: "done\n\nlocation: nope", total_cost_usd: 0.1 });
  await send(handle, env, "[dev] please add b.txt");
  // One registered location: the sole location is the run's location even without a valid marker.
  expect(codeTask(env)[0].location).toBe("real");
});

test("dev on its budget: the run row keeps the cost and outcome, the task is not done", async () => {
  const env = await setup();
  const handle = handler(env, {
    subtype: "error_max_budget_usd",
    is_error: true,
    errors: ["budget"],
    total_cost_usd: 3.2,
    session_id: "sess-dev",
  });
  await send(handle, env, "[dev] please add b.txt");
  const t = codeTask(env)[0];
  expect(runsOf(env, t.id)[0]).toMatchObject({ outcome: "max_budget" });
  expect(runsOf(env, t.id)[0].cost_usd).toBeCloseTo(3.2);
  expect(t.status).not.toBe("done");
  expect(env.db.query("SELECT session_id FROM sessions").get()).toBeNull();
});

test("a second dev message in the thread is a new task with its own run", async () => {
  const env = await setup();
  const handle = handler(env);
  await send(handle, env, "[dev] please add b.txt");
  await send(handle, env, "[dev] also add c");
  const tasks = codeTask(env);
  expect(tasks).toHaveLength(2);
  expect(runsOf(env, tasks[1].id)).toHaveLength(1);
});

test("partial background result: a dev run that hits its turn limit is NOT re-run automatically (it may have written)", async () => {
  const env = await setup();
  await send(
    handler(env, {
      subtype: "error_max_turns",
      is_error: true,
      result: undefined,
      errors: [],
      session_id: "sess-dev",
    }),
    env,
    "[dev] please add b.txt",
  );
  expect(codeTask(env)).toHaveLength(1);
  expect(runsOf(env, codeTask(env)[0].id)).toHaveLength(1); // no second run
});
