import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { liveRunsOf } from "../src/orchestrator/run/live-runs";
import { stopThreadTree } from "../src/orchestrator/run/stop-thread-tree";
import { insertTurn } from "../src/storage/run-store";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { BRIEF, makeEnv, resultMsg, stubGateway } from "./helpers";
import { type Call, sleep, teammateHarness, until, workersDone } from "./teammate-harness";

/* Characterisation of the run lifecycle (begin turn -> run -> close / fail turn, registry, events): the DB rows a teammate
   run and a worker run leave. Pinned before `runTurn` merged the sequences; they must not change. */

/** What a run leaves in the db, ids and times left out: turn rows, run rows, task statuses, event kinds (in order). */
function snap(db: Database) {
  return {
    turns: db
      .query(
        "SELECT role, status, kind, location, hop, source, session_id IS NOT NULL AS sess FROM turns ORDER BY rowid",
      )
      .all(),
    runs: db.query("SELECT outcome, cost_usd AS cost FROM runs ORDER BY rowid").all(),
    tasks: db
      .query(
        "SELECT owner_role AS owner, status, result_kind AS kind FROM owned_tasks ORDER BY rowid",
      )
      .all(),
    events: db.query("SELECT kind FROM thread_events ORDER BY rowid").all(),
  };
}

const dispatchOne = (c: Call) =>
  c.orchestrate("dispatch", {
    strategy: "DIRECT",
    small: true,
    intent: "work",
    reason: "test",
    assignments: [{ key: "a", subject: "task", role: "scout", brief: "do a", dependsOn: [] }],
  });

test("teammate run ends ok: one done teammate turn, one success run, session kept", async () => {
  const h = teammateHarness(async () => "hello");
  await h.send("hi");
  await until(() => h.posts.length > 0);
  expect(liveRunsOf("t1")).toHaveLength(0);
  expect(snap(h.env.db)).toMatchSnapshot();
});

test("teammate run errors: its turn row is closed, the owner gets the fixed notice", async () => {
  const h = teammateHarness(async () => {
    throw new Error("model down");
  });
  await h.send("hi");
  await until(() => h.posts.length > 0);
  await sleep(50);
  expect(liveRunsOf("t1")).toHaveLength(0);
  expect(snap(h.env.db)).toMatchSnapshot();
});

test("worker run ends ok: worker turn done + task completed + end event", async () => {
  const h = teammateHarness(async (c) => {
    if (c.kind === "worker") {
      await c.report("result", { title: "T", status: "COMPLETED", summary: "ok" });
      return "done";
    }
    if (c.prompt.includes("<owner_message>")) {
      await dispatchOne(c);
      return "started";
    }
    return "";
  });
  await h.send("go");
  await workersDone(h.env.db);
  await sleep(100);
  expect(liveRunsOf("t1")).toHaveLength(0);
  expect(snap(h.env.db)).toMatchSnapshot();
});

test("worker aborted by /stop: its query sees the abort, rows closed, registry empty", async () => {
  let saw = false;
  const h = teammateHarness(async (c) => {
    if (c.kind === "worker") {
      const signal = c.options.abortController.signal as AbortSignal;
      await new Promise<void>((res) => {
        if (signal.aborted) res();
        signal.addEventListener("abort", () => res());
      });
      saw = signal.aborted;
      return "stopped";
    }
    await dispatchOne(c);
    return "started";
  });
  await h.send("go");
  await until(() => h.calls.some((c) => c.kind === "worker"));
  stopThreadTree(h.env.db, "t1");
  await workersDone(h.env.db);
  await sleep(100);
  expect(saw).toBe(true);
  expect(liveRunsOf("t1")).toHaveLength(0);
  expect(snap(h.env.db)).toMatchSnapshot();
});

test("worker whose close step throws: turn row ends `failed`, `failure` event, registry empty", async () => {
  const { runDetached } = await import("../src/orchestrator/run/run-turn");
  const env = makeEnv();
  const locations = loadWorkspaces(env.home).workspaces[0]!.locations;
  insertTurn(env.db, {
    id: "ch-turn",
    threadId: "ch-th",
    source: "t",
    location: locations[0]!.name,
    role: "developer",
    brief: BRIEF,
  });
  let settled = false;
  runDetached(
    {
      db: env.db,
      config: env.config,
      approvals: stubGateway(),
      stopping: () => {
        throw new Error("close step crashed");
      },
      queryFn: ((_: unknown) =>
        (async function* () {
          yield resultMsg();
        })()) as never,
    } as never,
    {
      turnId: "ch-turn",
      threadId: "ch-th",
      text: BRIEF,
      role: "developer",
      workspace: "main",
      locations,
      ac: new AbortController(),
    },
    {
      language: "en",
      taskId: "ch-turn",
      location: locations[0]!.name,
      slot: () => {},
      resultKind: () => undefined,
      onSettled: () => {
        settled = true;
      },
    },
  );
  await until(() => settled);
  expect(liveRunsOf("ch-th")).toHaveLength(0);
  expect(snap(env.db)).toMatchSnapshot();
});
