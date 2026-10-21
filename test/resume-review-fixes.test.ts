import { expect, test } from "bun:test";
import { runOfTask } from "../src/orchestrator/run/live-runs";
import { stopThreadTree } from "../src/orchestrator/run/stop-thread-tree";
import { applyFailurePolicy } from "../src/orchestrator/worker/failure-policy";
import { recoverInFlight } from "../src/orchestrator/worker/recover-in-flight";
import { RESUME_PROMPT } from "../src/orchestrator/worker/resume-prompt";
import { getRole } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import { getItem } from "../src/storage/owned-item-store";
import { getOwnedTask } from "../src/storage/owned-task-store";
import { getSession } from "../src/storage/session-store";
import { recordBotThread } from "../src/storage/thread-store";
import { addLocation, fakeQuery, initMsg, makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";
import { leadHarness, until } from "./lead-harness";
import { isWorkerRun } from "./mcp-run-probe";

/* Review fixes of P2: shutdown resume restarts at boot, resume keeps the first run's cwd, /stop gives up a held item,
   a success result flagged is_error that carries an API error is a transient failure. */

const sessionOf = (options: any, n: number) =>
  options?.resume ?? (isWorkerRun(options) ? "worker-s" : `lead-${n}`);
const itemId = (db: any) =>
  (db.query("SELECT id FROM owned_tasks WHERE parent_id IS NOT NULL").get() as { id: string }).id;
/** The fake abort of the SDK: the run ends with the abort error once its controller fires. */
const untilAborted = (c: any) =>
  new Promise<never>((_, rej) =>
    c.options.abortController.signal.addEventListener("abort", () =>
      rej(new Error("Claude Code process aborted by user")),
    ),
  );
const dispatchDev = (c: any, location?: string) =>
  c.orchestrate("dispatch", {
    strategy: "DIRECT",
    small: true,
    intent: "work",
    reason: "t",
    assignments: [
      { key: "main", subject: "task", role: "developer", brief: "do it", dependsOn: [], location },
    ],
  });

test("SIGTERM: the abort leaves the item ready (nothing restarts while stopping); the next boot dispatches it, same session, no owner message", async () => {
  const env = makeEnv();
  const thread = "th-sigterm";
  recordBotThread(env.db, thread, TEST_CHANNEL, "main", "⏳ 10-15 10:00");
  const h1 = leadHarness(
    async (c) => {
      if (c.kind === "worker") return untilAborted(c);
      if (c.prompt.includes("Owner message:")) {
        await dispatchDev(c);
        return "On it.";
      }
      return "";
    },
    env,
    {},
    sessionOf,
  );
  await h1.send("go", thread);
  await until(() => h1.ofKind("worker").length === 1);
  await h1.handle.drain(3000); // SIGTERM path: abort everything, wait, interrupt leftovers
  const id = itemId(env.db);
  expect(getItem(env.db, id)).toMatchObject({ status: "ready", attempt: 1 });
  expect(h1.ofKind("worker")).toHaveLength(1); // no restart while stopping
  // New process: recovery sees no running item, but the ready one; the wake dispatches it.
  const report = recoverInFlight(env.db);
  expect(report.readyThreads).toEqual([thread]);
  const h2 = leadHarness(
    async (c) => {
      if (c.kind === "worker") {
        await c.report("result", { title: "T", status: "COMPLETED", summary: "ok" });
        return "ok";
      }
      return "";
    },
    env,
    {},
    sessionOf,
  );
  h2.handle.wake(report);
  await until(() => getItem(env.db, id)?.status === "completed", 8000);
  const [resumed] = h2.ofKind("worker");
  expect(resumed!.options.resume).toBe("worker-s");
  expect(resumed!.prompt).toContain(RESUME_PROMPT);
  expect(h2.posts).toEqual([]);
  await until(() => !runOfTask(id), 8000); // this item's runs are gone from the live registry
}, 20_000);

test("resume uses the cwd of the turn that owns the session, even when the item's location changed meanwhile", async () => {
  const env = makeEnv();
  const other = addLocation(env.home, "other"); // a second location of the workspace
  const thread = "th-cwd";
  recordBotThread(env.db, thread, TEST_CHANNEL, "main", "⏳ 10-15 10:00");
  const release: (() => void)[] = [];
  const first = leadHarness(
    async (c) => {
      if (c.kind === "worker") {
        await new Promise<void>((r) => release.push(r)); // the process dies here
        return "late";
      }
      if (c.prompt.includes("Owner message:")) {
        await dispatchDev(c, "location");
        return "On it.";
      }
      return "";
    },
    env,
    {},
    sessionOf,
  );
  await first.send("go", thread);
  await until(() => first.ofKind("worker").length === 1);
  const id = itemId(env.db);
  const firstCwd = first.ofKind("worker")[0]!.options.cwd as string;
  expect(firstCwd).not.toBe(other);
  // The item now reads as another location (a plan rewrite, a config change): recomputing the cwd would pick `other`.
  env.db.query("UPDATE owned_tasks SET location = 'other' WHERE id = ?").run(id);
  const report = recoverInFlight(env.db);
  const second = leadHarness(
    async (c) => {
      if (c.kind === "worker") {
        await c.report("result", { title: "T", status: "COMPLETED", summary: "ok" });
        return "ok";
      }
      return "";
    },
    env,
    {},
    sessionOf,
  );
  second.handle.wake(report);
  await until(() => getItem(env.db, id)?.status === "completed", 8000);
  const resumed = second.ofKind("worker")[0]!;
  expect(resumed.options.resume).toBe("worker-s");
  expect(resumed.options.cwd).toBe(firstCwd);
  for (const r of release) r();
  await until(() => !runOfTask(id), 8000);
}, 20_000);

test("/stop with a held item: it and its dependents are cancelled and the goal settles cancelled", async () => {
  const h = leadHarness(async (c) => {
    if (c.kind === "worker") {
      await c.report("result", { title: "T", status: "FAILED", summary: "broke" });
      return "failed";
    }
    if (c.prompt.includes("Owner message:")) {
      await c.orchestrate("dispatch", {
        strategy: "DELEGATE",
        small: true,
        intent: "work",
        reason: "t",
        assignments: [
          { key: "a", subject: "task", role: "developer", brief: "do a", dependsOn: [] },
          { key: "b", subject: "task", role: "developer", brief: "do b", dependsOn: ["a"] },
        ],
      });
      return "started";
    }
    return "";
  });
  await h.send("go");
  await until(
    () =>
      (h.env.db.query("SELECT status FROM owned_tasks WHERE item_key='a'").get() as any)?.status ===
      "blocked",
  );
  stopThreadTree(h.env.db, "t1");
  const st = (k: string) =>
    (h.env.db.query("SELECT status FROM owned_tasks WHERE item_key = ?").get(k) as any).status;
  expect([st("a"), st("b")]).toEqual(["cancelled", "cancelled"]);
  expect(
    (h.env.db.query("SELECT status FROM owned_tasks WHERE parent_id IS NULL").get() as any).status,
  ).toBe("cancelled");
});

test("a success result flagged is_error with an API error is a transient failure, resumed by the policy", async () => {
  const env = makeEnv();
  const run = (result: string) =>
    runAgent({
      prompt: "q",
      turnId: "T",
      role: getRole("lead"),
      cwd: env.home,
      config: env.config,
      db: env.db,
      abortController: new AbortController(),
      queryFn: fakeQuery([initMsg, resultMsg({ subtype: "success", is_error: true, result })]),
    });
  const overloaded = await run("API Error: 503 Service Unavailable");
  expect(overloaded.outcome).toBe("error");
  expect(overloaded.transient).toBe(true);
  const plain = await run("tests failed: 3 assertions");
  expect(plain.outcome).toBe("success"); // not an API error: unchanged
  expect(plain.transient).toBeUndefined();
  // Through the policy: a running goal item with that result resumes.
  env.db
    .query(
      "INSERT INTO owned_tasks (id, thread_id, owner_role, status, scope, version, correlation_id, created_at, last_progress_at, parent_id, item_key, depends_on) VALUES ('g','th','lead','open','g',0,'c',0,0,NULL,NULL,'[]'), ('it','th','developer','running','s',0,'c',0,0,'g','main','[]')",
    )
    .run();
  const verdict = applyFailurePolicy({
    db: env.db,
    itemId: "it",
    turnId: "T",
    res: { ...overloaded, text: overloaded.text },
    status: "failed",
    stopping: false,
  });
  expect(verdict).toMatchObject({ action: "resume", cause: "api_error" });
  expect(getOwnedTask(env.db, "it")?.status).toBe("ready");
  expect(getSession(env.db, "th")).toBeNull();
});
