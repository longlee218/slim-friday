import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IntentDeps } from "../src/intent/decide-intent";
import type { IntentResult } from "../src/intent/intent-types";
import { loadLexicon } from "../src/intent/load-lexicon";
import { createRoleTagRouter } from "../src/intent/role-tag";
import { expireHeldTasks, HELD_TASK_DAYS } from "../src/lifecycle/startup";
import { captureLogs } from "../src/observability/logger";
import { resumeQuestionOf } from "../src/orchestrator/dispatch/resume-failed-task";
import { MAX_CAPPED_TASKS } from "../src/orchestrator/dispatch/task-location";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { CONTINUE_PROMPT } from "../src/orchestrator/message-routing";
import { NO_DELIVERY_NOTE } from "../src/orchestrator/outputs/outcome-validator";
import { deriveThreadState } from "../src/orchestrator/thread/thread-state";
import { type FlowResult, RESUMABLE, resumeReasonOf } from "../src/orchestrator/turns/turn-result";
import { ROLES } from "../src/roles/role-registry";
import { activeOwnedTask, getOwnedTask } from "../src/storage/owned-task-store";
import { insertTurn } from "../src/storage/run-store";
import { g, makeLocation } from "./git-fixture";
import {
  addLocation,
  clearWorkspaces,
  DEV_REQUEST,
  defaultLocationPath,
  initMsg,
  makeEnv,
  promptText,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";

/* Rev 12 D, Rev 15 phase 5: `failed_resumable`. A background run that fails (budget, error) with its session saved keeps
   it; `/go` or a yes to the resume question continues THAT session in its cwd (the location) with a "continue" prompt, as a
   new `resume` row under the same task ceiling. `/go +<usd>` raises the budget. */

async function setup() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeLocation("main");
  const clone = defaultLocationPath(env.home, "real", "main");
  addLocation(env.home, "real", { gitAuthor: "Test User <test@example.com>" }, { path: clone });
  await g(env.home, "clone", "-q", src.location, clone);
  await g(clone, "config", "user.email", "test@example.com");
  await g(clone, "config", "user.name", "t");
  return { env, clone };
}

const msg = (text: string) => ({
  source: "t",
  language: "en" as const,
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId: "th1",
  text,
});

/** What one dev run does: fail (`error` / `budget`), fail on its resume, or write + commit b.txt. */
type RunStep = "error" | "budget" | "resume-gone" | "no-session" | "answer" | "ok";

/** Fake SDK: each dev run follows the next step; its session id is `sess-<n>`. */
function sdk(steps: RunStep[], seen: any[]) {
  let n = 0;
  return (a: any) => {
    const o = a.options;
    return (async function* () {
      a.promptText = await promptText(a.prompt);
      seen.push(a);
      const step = steps[n++] ?? "ok";
      if (step !== "no-session") yield { ...initMsg, session_id: `sess-${n}` } as never;
      const fail = (errors?: string[], subtype = "error_during_execution", cost?: number) =>
        resultMsg({
          subtype,
          is_error: true,
          ...(errors && { errors }),
          total_cost_usd: cost,
          ...(step === "no-session" && { session_id: undefined }), // died before the CLI reported a session
        });
      if (step === "error" || step === "no-session") {
        yield fail(["boom"]);
        return;
      }
      if (step === "budget") {
        yield fail(undefined, "error_max_budget_usd", 3.2);
        return;
      }
      if (step === "resume-gone") {
        yield fail(["No conversation found with session ID: sess-1"]);
        return;
      }
      if (step === "answer") {
        // Ends well but changes nothing: no commit, push or PR.
        yield resultMsg({ result: "Only an answer\n\nlocation: real", session_id: `sess-${n}` });
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
      yield resultMsg({ result: "Xong\n\nlocation: real", session_id: `sess-${n}` });
    })();
  };
}

/** L3: "continue" = yes to the pending question; "other" = a different NEW dev request; else a supplement. */
const intent = (home: string): IntentDeps => ({
  pipeline: { lexicon: loadLexicon(home), tagRouter: createRoleTagRouter(Object.values(ROLES)) },
  classifier: {
    classify: async (i): Promise<IntentResult> => {
      const base = { confidence: "high" as const, reason: "r", role: "dev" };
      if (i.text.includes("other")) return { ...base, scope: "new" };
      return i.text === "continue"
        ? { ...base, scope: "active", pendingAnswer: "yes" }
        : { ...base, scope: "active" };
    },
  },
});

/** A handler whose dev runs follow `steps`. */
async function run(steps: RunStep[]) {
  const { env, clone } = await setup();
  const seen: any[] = [];
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: stubGateway({ confirm: async () => ({ approved: false, reason: "declined" }) }),
    queryFn: sdk(steps, seen) as never,
    intent: intent(env.home),
  });
  return { env, clone, seen, handle };
}

const status = (env: { db: ReturnType<typeof makeEnv>["db"] }) =>
  env.db.query("SELECT status, kind, parent_turn_id FROM turns ORDER BY started_at, rowid").all();
const taskIds = (env: { db: ReturnType<typeof makeEnv>["db"] }) =>
  env.db.query<{ id: string }, []>("SELECT id FROM turns ORDER BY started_at, rowid").all();

test("a transient error -> failed_resumable: session and reason kept; the reply asks to continue; thread is idle", async () => {
  const { env, clone, handle } = await run(["error"]);
  const reply = await handle(msg(DEV_REQUEST));
  expect(reply).toContain("did not finish your request");
  expect(reply).toContain("continue from where it stopped?");
  const id = taskIds(env)[0]!.id;
  expect(status(env)).toEqual([
    { status: "failed_resumable", kind: "single", parent_turn_id: null },
  ]);
  // The run's session and cwd are on the turn row: what `/go` continues.
  expect(env.db.query("SELECT session_id, session_cwd FROM turns WHERE id = ?").get(id)).toEqual({
    session_id: "sess-1",
    session_cwd: realpathSync(clone),
  });
  expect(deriveThreadState(env.db, "th1")).toBe("idle");
  expect(resumeQuestionOf(env.db, "th1")).toBe(
    "Would you like to continue from where it stopped? Reply yes or send `/go`.",
  );
  expect(existsSync(clone)).toBe(true);
});

test("/go continues the SAME session in the location with the continue prompt; the new row is a resume child; the held row is closed", async () => {
  const { env, clone, seen, handle } = await run(["error", "ok"]);
  await handle(msg(DEV_REQUEST));
  const firstId = taskIds(env)[0]!.id;
  const reply = await handle(msg("/go"));
  expect(reply).toContain("Xong");
  expect(seen).toHaveLength(2);
  const [first, second] = seen;
  expect(second.options.cwd).toBe(realpathSync(clone));
  expect(second.options.resume).toBe("sess-1"); // the very session the first run recorded
  expect(second.promptText).toBe(CONTINUE_PROMPT);
  expect(first.options.cwd).toBe(second.options.cwd);
  expect(first.promptText).not.toBe(CONTINUE_PROMPT); // the first run is a normal one
  expect(status(env)).toEqual([
    { status: "failed", kind: "single", parent_turn_id: null },
    { status: "done", kind: "resume", parent_turn_id: firstId },
  ]);
  expect(readFileSync(join(clone, "b.txt"), "utf8")).toBe("two\n");
});

test('a yes read by L3 ("continue") resumes the same way', async () => {
  const { seen, handle } = await run(["error", "ok"]);
  await handle(msg(DEV_REQUEST));
  expect(await handle(msg("continue"))).toContain("Xong");
  expect(seen).toHaveLength(2);
  expect(seen[1].options.resume).toBe("sess-1");
  expect(seen[1].promptText).toBe(CONTINUE_PROMPT);
});

test("an unrelated NEW request starts a new task with a fresh session; the held task is not resumed", async () => {
  const { env, seen, handle } = await run(["error", "ok"]);
  await handle(msg(DEV_REQUEST));
  await handle(msg("other thing entirely: add c.txt with three please"));
  expect(seen).toHaveLength(2);
  expect(seen[1].options.resume).toBeUndefined();
  expect(seen[1].promptText).not.toBe(CONTINUE_PROMPT);
  expect(status(env)[0]).toEqual({
    status: "failed_resumable",
    kind: "single",
    parent_turn_id: null,
  });
});

test("budget stop is resumable, but only with a raise (`/go +<usd>`): same session, raised budget, one task ceiling", async () => {
  const { env, seen, handle } = await run(["budget", "ok"]);
  const reply = await handle(msg(DEV_REQUEST));
  expect(reply).toContain("spending limit was reached");
  expect(status(env)).toEqual([
    { status: "failed_resumable", kind: "single", parent_turn_id: null },
  ]);
  expect(await handle(msg("/go"))).toContain("/go +<usd>"); // same budget would stop again
  expect(seen).toHaveLength(1);
  expect(await handle(msg("/go +1"))).toContain("Xong");
  expect(seen).toHaveLength(2);
  expect(seen[1].options.resume).toBe("sess-1");
  // 4.5 + 1 raise, but the first run spent 3.2 of the 6.0 task ceiling: only 2.8 is left.
  expect(seen[1].options.maxBudgetUsd).toBeCloseTo(2.8);
});

test("a failure with no saved session stays failed (nothing to resume)", async () => {
  const { env, handle } = await run(["no-session"]);
  await handle(msg(DEV_REQUEST));
  expect(status(env)).toEqual([{ status: "failed", kind: "single", parent_turn_id: null }]);
  expect(resumeQuestionOf(env.db, "th1")).toBeUndefined();
});

test("a resume whose session is gone: a clear reply, the owner starts the task again", async () => {
  const { env, handle, seen } = await run(["error", "resume-gone"]);
  await handle(msg(DEV_REQUEST));
  const reply = await handle(msg("/go"));
  expect(reply).toContain("Could not resume the task's session; start the task again.");
  expect(seen).toHaveLength(2);
  // The failed resume is NOT tagged resumable (a `/go` would fail the same way): both rows are plain `failed`.
  expect(status(env).map((r: any) => r.status)).toEqual(["failed", "failed"]);
  expect(deriveThreadState(env.db, "th1")).toBe("idle");
  expect(resumeQuestionOf(env.db, "th1")).toBeUndefined();
});

test("a location.yaml without any commit identity is no reason to refuse: the task runs and a failure is resumable like any other", async () => {
  const { env, clone } = await setup();
  addLocation(env.home, "real", {}, { path: clone }); // no gitAuthor: ignored since Rev 15
  const seen: any[] = [];
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: stubGateway(),
    queryFn: sdk(["error", "ok"], seen) as never,
    intent: intent(env.home),
  });
  expect(await handle(msg(DEV_REQUEST))).toContain("continue from where it stopped?");
  expect(await handle(msg("/go"))).toContain("Xong");
  expect(seen[1].options.resume).toBe("sess-1");
});

test("which failures qualify: the reasons table, and nothing else", () => {
  const r = (over: Partial<FlowResult>): FlowResult => ({
    text: "",
    outcome: "error",
    sessionId: undefined,
    ...over,
  });
  expect(Object.keys(RESUMABLE)).toEqual(["budget", "error"]); // no config reason any more
  expect(resumeReasonOf(r({ outcome: "error" }))).toBe("error");
  expect(resumeReasonOf(r({ outcome: "max_budget" }))).toBe("budget");
  // owner stop, restart (also `aborted`), timeout, quota, turn limit, success: never
  for (const outcome of ["aborted", "timeout", "quota", "max_turns", "success"] as const)
    expect(resumeReasonOf(r({ outcome }))).toBeUndefined();
});

test("the hold expires by task age (scratch dir removed) and a stale yes gets no resume", async () => {
  const { env, seen, handle } = await run(["error", "ok"]);
  await handle(msg(DEV_REQUEST));
  const id = taskIds(env)[0]!.id;
  const taskDir = env.paths.workspace("main").task(id).root;
  expect(existsSync(taskDir)).toBe(true);
  expect(resumeQuestionOf(env.db, "th1")).toContain("continue from where it stopped");
  const home = env.config.agentHome;
  const day = 86_400_000;
  expect(expireHeldTasks(env.db, home, Date.now() + (HELD_TASK_DAYS - 1) * day)).toEqual([]);
  expect(existsSync(taskDir)).toBe(true);
  expect(expireHeldTasks(env.db, home, Date.now() + (HELD_TASK_DAYS + 1) * day)).toEqual([id]);
  expect(existsSync(taskDir)).toBe(false);
  expect(status(env)).toEqual([{ status: "failed", kind: "single", parent_turn_id: null }]);
  expect(resumeQuestionOf(env.db, "th1")).toBeUndefined();
  await handle(msg("continue")); // a stale yes: nothing is resumed (it is read as a new request)
  expect(seen.some((a) => a.options.resume === "sess-1")).toBe(false);
});

test("a resume that cannot start keeps the hold (task cap reached)", async () => {
  const { env, seen, handle } = await run(["error", "ok"]);
  await handle(msg(DEV_REQUEST));
  for (const id of Array.from({ length: MAX_CAPPED_TASKS }, (_, n) => `cap${n}`))
    insertTurn(env.db, { id, threadId: id, source: "t", location: "real", role: "dev" });
  expect(await handle(msg("/go"))).toContain("handling other work");
  expect(seen).toHaveLength(1);
  expect(resumeQuestionOf(env.db, "th1")).toBeDefined();
  expect(env.db.query("SELECT status FROM turns WHERE thread_id = 'th1'").all()).toEqual([
    { status: "failed_resumable" },
  ]);
});

test("`/go` racing a yes resumes once: the second message meets the running task", async () => {
  const { seen, handle } = await run(["error", "ok"]);
  await handle(msg(DEV_REQUEST));
  const replies = await Promise.all([handle(msg("/go")), handle(msg("continue"))]);
  expect(replies.filter((r) => r?.includes("Xong"))).toHaveLength(1);
  expect(seen).toHaveLength(2);
});

test("a run cut short by a restart (interrupted) resumes its own session: `/go` (the Resume button) continues it in the location", async () => {
  const { env, clone, seen, handle } = await run(["error", "ok"]);
  await handle(msg(DEV_REQUEST));
  // What a restart does to a running dev run: the task is `interrupted` (its session and cwd were saved at init).
  env.db.query("UPDATE turns SET status = 'interrupted'").run();
  expect(await handle(msg("/go"))).toContain("Xong");
  const second = seen[1];
  expect(second.options.cwd).toBe(realpathSync(clone));
  expect(second.options.resume).toBe("sess-1");
  expect(status(env).map((r: any) => [r.status, r.kind])).toEqual([
    ["cancelled", "single"], // taken over: no second restart notice
    ["done", "resume"],
  ]);
});

test("hold expiry: a non-uuid id is skipped for rm but still failed; a throwing rm does not stop the next id", () => {
  const env = makeEnv();
  const ids = ["not-a-uuid", crypto.randomUUID(), crypto.randomUUID()];
  for (const id of ids) {
    insertTurn(env.db, { id, threadId: id, source: "t", location: "real", role: "dev" });
    env.db
      .query("UPDATE turns SET status = 'failed_resumable', started_at = 1 WHERE id = ?")
      .run(id);
  }
  const removed: string[] = [];
  const rm = (dir: string) => {
    if (dir.includes(ids[1]!)) throw new Error("EACCES");
    removed.push(dir);
  };
  expect(expireHeldTasks(env.db, env.config.agentHome, Date.now(), rm).sort()).toEqual(
    [...ids].sort(),
  );
  const st = env.db.query("SELECT id, status FROM turns").all() as { id: string; status: string }[];
  expect(st.every((r) => r.status === "failed")).toBe(true);
  expect(removed.length).toBeGreaterThan(0);
  expect(removed.every((d) => d.includes(ids[2]!))).toBe(true); // the uuid after the failing one was still processed
});

test("a dev run that delivers nothing: its own reply + one neutral line, turn done, task waits; `/go` continues it, no auto re-run", async () => {
  const { env, seen, handle } = await run(["answer", "ok"]);
  const cap = captureLogs();
  const reply = await handle(msg(DEV_REQUEST));
  cap.stop();
  expect(reply).toContain("Only an answer");
  expect(reply).toContain(NO_DELIVERY_NOTE);
  expect(seen).toHaveLength(1); // no auto re-run
  expect(status(env)).toEqual([{ status: "done", kind: "single", parent_turn_id: null }]);
  const task = activeOwnedTask(env.db, "th1")!;
  expect(task).toMatchObject({ status: "waiting_user", ownerAgentId: "dev" });
  const out = cap.lines.filter((l) => l.event === "execution.outcome");
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ status: "partial", recoveryHint: "continue" });
  expect(JSON.stringify(out[0])).not.toContain("Only an answer");
  // `/go` continues the same task in its own session with the generic continue prompt.
  const again = await handle(msg("/go"));
  expect(seen).toHaveLength(2);
  expect(seen[1].options.resume).toBe("sess-1");
  expect(seen[1].promptText).toBe(CONTINUE_PROMPT);
  expect(again).toContain("Xong");
  // Same task (the fake agent commits outside any recorded Bash call, so it still shows no evidence).
  expect(activeOwnedTask(env.db, "th1")?.taskId).toBe(task.taskId);
  expect(getOwnedTask(env.db, task.taskId)?.version).toBeGreaterThan(task.version);
});
