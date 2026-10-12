import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IntentDeps } from "../src/intent/decide-intent";
import type { IntentResult } from "../src/intent/intent-types";
import { loadLexicon } from "../src/intent/load-lexicon";
import { createRoleTagRouter } from "../src/intent/role-tag";
import { expireHeldTasks, HELD_TASK_DAYS } from "../src/lifecycle/startup";
import { resumeQuestionOf } from "../src/orchestrator/dispatch/resume-failed-task";
import { MAX_CAPPED_TASKS } from "../src/orchestrator/dispatch/task-repo";
import { RESUME_NOTE } from "../src/orchestrator/engine/resume-exec";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { deriveThreadState } from "../src/orchestrator/thread/thread-state";
import { type FlowResult, RESUMABLE, resumeReasonOf } from "../src/orchestrator/turns/turn-result";
import { ROLES } from "../src/roles/role-registry";
import { insertTurn } from "../src/storage/run-store";
import { listStages } from "../src/storage/stage-store";
import { EXIT_PLAN_MODE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { g, makeRepo } from "./git-fixture";
import {
  addRepo,
  clearWorkspaces,
  DEV_REQUEST,
  initMsg,
  makeEnv,
  promptText,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";

/* Rev 12 D: `failed_resumable`. A task that fails after the approved plan keeps its plan on disk; `/go` or a yes to the
   resume question runs exec again from the approved plan (Rev 15 phase 3: in the repo, a fresh session and a note that
   the checkout may hold part of the work). */

async function setup() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeRepo("main");
  const clone = workspacePaths(env.home).workspace("main").repo("real").clone;
  addRepo(env.home, "real", { gitAuthor: "Test User <test@example.com>" }, { path: clone });
  await g(env.home, "clone", "-q", src.repo, clone);
  await g(clone, "config", "user.email", "test@example.com");
  await g(clone, "config", "user.name", "t");
  return { env, clone };
}

import { workspacePaths } from "../src/config/workspace-paths";

const msg = (text: string) => ({
  source: "t",
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId: "th1",
  text,
});

/** What one exec run does: fail (`error` / `budget`), or write + commit b.txt. */
type ExecStep = "error" | "budget" | "resume-gone" | "ok";

/** Fake SDK: the plan stage submits a plan; each exec run follows the next step. */
function sdk(steps: ExecStep[], seen: any[]) {
  let n = 0;
  return (a: any) => {
    const o = a.options;
    return (async function* () {
      a.promptText = await promptText(a.prompt);
      seen.push(a);
      if (o.permissionMode === "plan") {
        const r = await o.canUseTool(
          EXIT_PLAN_MODE_TOOL_NAME,
          { plan: "repo: real\nadd b.txt" },
          {},
        );
        if (r.behavior === "allow") throw new Error("process aborted");
        yield resultMsg({ result: "plan rejected" });
        return;
      }
      const step = steps[n++] ?? "ok";
      yield { ...initMsg, session_id: "sess-exec" } as never;
      const fail = (errors?: string[], subtype = "error_during_execution") =>
        resultMsg({ subtype, is_error: true, ...(errors && { errors }) });
      if (step === "error") {
        yield fail(["boom"]);
        return;
      }
      if (step === "budget") {
        yield fail(undefined, "error_max_budget_usd");
        return;
      }
      if (step === "resume-gone") {
        yield fail(["No conversation found with session ID: sess-exec"]);
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
      yield resultMsg({ result: "Xong", session_id: "sess-exec" });
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

/** A handler whose exec runs follow `steps`; the plan is approved. */
async function run(steps: ExecStep[]) {
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
  env.db.query("SELECT status, parent_turn_id FROM turns ORDER BY started_at, rowid").all();
const execRuns = (seen: any[]) => seen.filter((a) => a.options.permissionMode !== "plan");
const taskIds = (env: { db: ReturnType<typeof makeEnv>["db"] }) =>
  env.db.query<{ id: string }, []>("SELECT id FROM turns ORDER BY started_at, rowid").all();

test("a transient error at exec -> failed_resumable: plan and reason kept; the reply asks to continue; thread is idle", async () => {
  const { env, clone, handle } = await run(["error"]);
  const reply = await handle(msg(DEV_REQUEST));
  expect(reply).toContain("stopped at exec: agent error");
  expect(reply).toContain("Continue with the approved plan?");
  const id = taskIds(env)[0]!.id;
  expect(existsSync(env.paths.workspace("main").task(id).plan)).toBe(true);
  expect(env.db.query("SELECT repo FROM turns").get()).toEqual({ repo: "real" }); // `/go` needs the repo
  expect(status(env)).toEqual([{ status: "failed_resumable", parent_turn_id: null }]);
  const exec = listStages(env.db, id).find((s) => s.name !== "plan")!;
  expect(exec.verdict).toBe("error");
  expect(deriveThreadState(env.db, "th1")).toBe("idle");
  expect(resumeQuestionOf(env.db, "th1")).toBe(
    `Task ${id.slice(0, 8)} stopped at exec: ${RESUMABLE.error}. Continue with the approved plan?`,
  );
  expect(existsSync(clone)).toBe(true);
});

test("/go runs exec again in the repo from the approved plan: fresh session, resume note, no new plan; the held row is closed", async () => {
  const { env, clone, seen, handle } = await run(["error", "ok"]);
  await handle(msg(DEV_REQUEST));
  const reply = await handle(msg("/go"));
  expect(reply).toContain("Xong");
  const [first, second] = execRuns(seen);
  expect(second.options.cwd).toBe(realpathSync(clone));
  expect(second.options.resume).toBeUndefined(); // no clone, no stored session to continue: a fresh one
  expect(second.promptText).toContain("add b.txt"); // the approved plan
  expect(second.promptText).toContain(RESUME_NOTE);
  expect(first.options.cwd).toBe(second.options.cwd);
  expect(first.promptText).not.toContain(RESUME_NOTE); // the first run is a normal exec
  expect(env.db.query("SELECT COUNT(*) AS n FROM worktrees").get()).toEqual({ n: 0 });
  expect(seen.filter((a) => a.options.permissionMode === "plan")).toHaveLength(1); // no new plan
  expect(status(env)).toEqual([
    { status: "failed", parent_turn_id: null },
    { status: "done", parent_turn_id: null },
  ]);
  expect(readFileSync(join(clone, "b.txt"), "utf8")).toBe("two\n");
});

test('a yes read by L3 ("continue") resumes the same way', async () => {
  const { seen, handle } = await run(["error", "ok"]);
  await handle(msg(DEV_REQUEST));
  expect(await handle(msg("continue"))).toContain("Xong");
  expect(execRuns(seen)).toHaveLength(2);
  expect(execRuns(seen)[1].promptText).toContain(RESUME_NOTE);
});

test("an unrelated NEW request starts a new task with its own plan; the held task is not resumed", async () => {
  const { env, seen, handle } = await run(["error", "ok"]);
  await handle(msg(DEV_REQUEST));
  await handle(msg("other thing entirely: add c.txt with three please"));
  expect(seen.filter((a) => a.options.permissionMode === "plan")).toHaveLength(2); // a second plan ran
  expect(execRuns(seen)[1].promptText).not.toContain(RESUME_NOTE);
  expect(status(env)[0]).toEqual({ status: "failed_resumable", parent_turn_id: null });
});

test("budget stop at exec is resumable, but only with a raise (`/go +<usd>`)", async () => {
  const { env, seen, handle } = await run(["budget", "ok"]);
  const reply = await handle(msg(DEV_REQUEST));
  expect(reply).toContain("budget reached");
  expect(status(env)).toEqual([{ status: "failed_resumable", parent_turn_id: null }]);
  expect(await handle(msg("/go"))).toContain("/go +<usd>"); // same budget would stop again
  expect(execRuns(seen)).toHaveLength(1);
  expect(await handle(msg("/go +1"))).toContain("Xong");
  expect(execRuns(seen)).toHaveLength(2);
});

test("a failure before the plan is approved stays failed (nothing to resume)", async () => {
  const { env } = await setup();
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: stubGateway({ requestPlan: async () => ({ approved: false, reason: "no" }) }),
    queryFn: (() =>
      (async function* () {
        yield resultMsg({ subtype: "error_during_execution", is_error: true, errors: ["boom"] });
      })()) as never,
    intent: intent(env.home),
  });
  await handle(msg(DEV_REQUEST));
  expect(status(env)).toEqual([{ status: "failed", parent_turn_id: null }]);
  expect(resumeQuestionOf(env.db, "th1")).toBeUndefined();
});

test("a repo.yaml without any commit identity is no reason to refuse: the task runs and a failure is resumable like any other", async () => {
  const { env, clone } = await setup();
  addRepo(env.home, "real", {}, { path: clone }); // no gitAuthor: ignored since Rev 15
  const seen: any[] = [];
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: stubGateway(),
    queryFn: sdk(["error", "ok"], seen) as never,
    intent: intent(env.home),
  });
  expect(await handle(msg(DEV_REQUEST))).toContain("Continue with the approved plan?");
  expect(await handle(msg("/go"))).toContain("Xong");
  expect(seen.filter((a) => a.options.permissionMode === "plan")).toHaveLength(1);
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

test("the hold expires by task age (plan file removed) and a stale yes gets no resume", async () => {
  const { env, seen, handle } = await run(["error", "ok"]);
  await handle(msg(DEV_REQUEST));
  const id = taskIds(env)[0]!.id;
  const planFile = env.paths.workspace("main").task(id).plan;
  expect(existsSync(planFile)).toBe(true);
  expect(resumeQuestionOf(env.db, "th1")).toContain(RESUMABLE.error);
  const home = env.config.agentHome;
  const day = 86_400_000;
  expect(expireHeldTasks(env.db, home, Date.now() + (HELD_TASK_DAYS - 1) * day)).toEqual([]);
  expect(existsSync(planFile)).toBe(true);
  expect(expireHeldTasks(env.db, home, Date.now() + (HELD_TASK_DAYS + 1) * day)).toEqual([id]);
  expect(existsSync(planFile)).toBe(false);
  expect(status(env)).toEqual([{ status: "failed", parent_turn_id: null }]);
  expect(resumeQuestionOf(env.db, "th1")).toBeUndefined();
  await handle(msg("continue")); // a stale yes: nothing is resumed (it is read as a new request)
  expect(seen.some((a) => String(a.promptText).includes(RESUME_NOTE))).toBe(false);
});

test("a resume that cannot start keeps the hold (task cap reached)", async () => {
  const { env, seen, handle } = await run(["error", "ok"]);
  await handle(msg(DEV_REQUEST));
  for (const id of Array.from({ length: MAX_CAPPED_TASKS }, (_, n) => `cap${n}`))
    insertTurn(env.db, { id, threadId: id, source: "t", repo: "real", role: "dev" });
  expect(await handle(msg("/go"))).toContain("busy");
  expect(execRuns(seen)).toHaveLength(1);
  expect(resumeQuestionOf(env.db, "th1")).toBeDefined();
  expect(env.db.query("SELECT status FROM turns WHERE thread_id = 'th1'").all()).toEqual([
    { status: "failed_resumable" },
  ]);
});

test("`/go` racing a yes resumes once: the second message meets the running task", async () => {
  const { seen, handle } = await run(["error", "ok"]);
  await handle(msg(DEV_REQUEST));
  const replies = await Promise.all([handle(msg("/go")), handle(msg("continue"))]);
  expect(replies.filter((r) => r.includes("Xong"))).toHaveLength(1);
  expect(execRuns(seen)).toHaveLength(2);
});

test("an exec cut short by a restart (interrupted) with an approved plan resumes like a failed one: `/go` runs it from the plan, fresh session, resume note", async () => {
  const { env, clone, seen, handle } = await run(["error", "ok"]);
  await handle(msg(DEV_REQUEST));
  // What a restart does to a running exec: the task is `interrupted` (the plan and the repo were saved at the switch).
  env.db.query("UPDATE turns SET status = 'interrupted'").run();
  expect(await handle(msg("/go"))).toContain("Xong");
  const [, second] = execRuns(seen);
  expect(second.options.cwd).toBe(realpathSync(clone));
  expect(second.options.resume).toBeUndefined();
  expect(second.promptText).toContain("add b.txt");
  expect(second.promptText).toContain(RESUME_NOTE);
  expect(seen.filter((a) => a.options.permissionMode === "plan")).toHaveLength(1); // no new plan
  expect(status(env)).toEqual([
    { status: "cancelled", parent_turn_id: null }, // taken over: no second restart notice
    { status: "done", parent_turn_id: null },
  ]);
});

test("hold expiry: a non-uuid id is skipped for rm but still failed; a throwing rm does not stop the next id", () => {
  const env = makeEnv();
  const ids = ["not-a-uuid", crypto.randomUUID(), crypto.randomUUID()];
  for (const id of ids) {
    insertTurn(env.db, { id, threadId: id, source: "t", repo: "real", role: "dev" });
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
