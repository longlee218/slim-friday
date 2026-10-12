import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IntentDeps } from "../src/intent/decide-intent";
import type { IntentResult } from "../src/intent/intent-types";
import { loadLexicon } from "../src/intent/load-lexicon";
import { createRoleTagRouter } from "../src/intent/role-tag";
import { DAY_MS, expireClones } from "../src/lifecycle/clone-retention";
import { createGitMcp } from "../src/mcp/git-mcp";
import { resumeQuestionOf } from "../src/orchestrator/dispatch/resume-failed-task";
import { RESUME_NOTE } from "../src/orchestrator/engine/resume-exec";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { deriveThreadState } from "../src/orchestrator/thread/thread-state";
import { type FlowResult, RESUMABLE, resumeReasonOf } from "../src/orchestrator/turns/turn-result";
import { ROLES } from "../src/roles/role-registry";
import { countFollowUps, insertTurn } from "../src/storage/run-store";
import { listStages } from "../src/storage/stage-store";
import { getWorktreeByThread, listKeptClones } from "../src/storage/worktree-store";
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

/* Rev 12 D: `failed_resumable`. A task that fails after the approved plan keeps its clone, plan and session; `/go` or a
   yes to the resume question runs exec again from the approved plan in the same clone (old session first, else fresh). */

const git = createGitMcp();
afterAll(() => git.close());

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

/** A handler whose exec runs follow `steps`; the plan is approved, the PR offer declined. */
async function run(steps: ExecStep[]) {
  const { env, clone } = await setup();
  const seen: any[] = [];
  const handle = createTurnHandler({
    git,
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

test("a transient error at exec -> failed_resumable: clone, plan and reason kept; the reply asks to continue; thread is idle", async () => {
  const { env, handle } = await run(["error"]);
  const reply = await handle(msg(DEV_REQUEST));
  expect(reply).toContain("stopped at exec: agent error");
  expect(reply).toContain("Continue with the approved plan?");
  const wt = getWorktreeByThread(env.db, "th1")!;
  expect(wt.status).toBe("active");
  expect(existsSync(wt.path)).toBe(true);
  expect(existsSync(env.paths.workspace("main").task(wt.taskId).plan)).toBe(true);
  expect(status(env)).toEqual([{ status: "failed_resumable", parent_turn_id: null }]);
  const exec = listStages(env.db, wt.taskId).find((s) => s.name !== "plan")!;
  expect(exec.verdict).toBe("error");
  expect(deriveThreadState(env.db, "th1")).toBe("idle");
  expect(resumeQuestionOf(env.db, "th1")).toBe(
    `Task ${wt.taskId.slice(0, 8)} stopped at exec: ${RESUMABLE.error}. Continue with the approved plan?`,
  );
});

test("/go resumes in the same clone with the approved plan and the old session; no new clone; the held row is closed", async () => {
  const { env, seen, handle } = await run(["error", "ok"]);
  await handle(msg(DEV_REQUEST));
  const wt = getWorktreeByThread(env.db, "th1")!;
  const reply = await handle(msg("/go"));
  expect(reply).toContain("Xong");
  const [first, second] = execRuns(seen);
  expect(second.options.cwd).toBe(realpathSync(wt.path));
  expect(second.options.resume).toBe("sess-exec"); // the old session is tried first
  expect(second.promptText).toContain("add b.txt"); // the approved plan
  expect(second.promptText).toContain(RESUME_NOTE);
  expect(first.options.cwd).toBe(second.options.cwd);
  expect(env.db.query("SELECT COUNT(*) AS n FROM worktrees").get()).toEqual({ n: 1 });
  expect(seen.filter((a) => a.options.permissionMode === "plan")).toHaveLength(1); // no new plan
  expect(status(env)).toEqual([
    { status: "failed", parent_turn_id: null },
    { status: "done", parent_turn_id: wt.taskId },
  ]);
  expect(readFileSync(join(wt.path, "b.txt"), "utf8")).toBe("two\n");
});

test('a yes read by L3 ("continue") resumes the same way', async () => {
  const { env, seen, handle } = await run(["error", "ok"]);
  await handle(msg(DEV_REQUEST));
  expect(await handle(msg("continue"))).toContain("Xong");
  expect(execRuns(seen)).toHaveLength(2);
  expect(execRuns(seen)[1].options.resume).toBe("sess-exec");
  expect(env.db.query("SELECT COUNT(*) AS n FROM worktrees").get()).toEqual({ n: 1 });
});

test("the old session is gone -> a fresh session seeded with the approved plan", async () => {
  const { seen, handle } = await run(["error", "resume-gone", "ok"]);
  await handle(msg(DEV_REQUEST));
  expect(await handle(msg("/go"))).toContain("Xong");
  const execs = execRuns(seen);
  expect(execs.map((a) => a.options.resume)).toEqual([undefined, "sess-exec", undefined]);
  expect(execs[2].promptText).toContain("add b.txt");
});

test("an unrelated NEW request starts a new task; the held clone is not resumed", async () => {
  const { env, seen, handle } = await run(["error", "ok"]);
  await handle(msg(DEV_REQUEST));
  const held = getWorktreeByThread(env.db, "th1")!;
  await handle(msg("other thing entirely: add c.txt with three please"));
  // a second plan ran (not a resume); the first row stays held, the second clone is its own
  expect(seen.filter((a) => a.options.permissionMode === "plan")).toHaveLength(2);
  expect(env.db.query("SELECT COUNT(*) AS n FROM worktrees").get()).toEqual({ n: 2 });
  expect(existsSync(held.path)).toBe(true);
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
    git,
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

test("no commit identity at the stage switch (no clone yet) is resumable: after the config fix `/go` makes the clone and runs exec from the approved plan, no new plan", async () => {
  const { env, clone } = await setup();
  addRepo(env.home, "real", {}, { path: clone }); // same clone, no gitAuthor
  const seen: any[] = [];
  const handle = createTurnHandler({
    git,
    db: env.db,
    config: env.config,
    approvals: stubGateway({ confirm: async () => ({ approved: false, reason: "declined" }) }),
    queryFn: sdk(["ok"], seen) as never,
    intent: intent(env.home),
  });
  const reply = await handle(msg(DEV_REQUEST));
  expect(reply).toContain("No commit identity");
  expect(reply).toContain("Continue with the approved plan?");
  expect(status(env)).toEqual([{ status: "failed_resumable", parent_turn_id: null }]);
  expect(getWorktreeByThread(env.db, "th1")).toBeNull(); // nothing to keep but the plan
  // the owner fixes the config and says "continue"
  addRepo(env.home, "real", { gitAuthor: "Test User <test@example.com>" }, { path: clone });
  expect(await handle(msg("/go"))).toContain("Xong");
  expect(seen.filter((a) => a.options.permissionMode === "plan")).toHaveLength(1); // no new plan
  const wt = getWorktreeByThread(env.db, "th1")!;
  expect(readFileSync(join(wt.path, "b.txt"), "utf8")).toBe("two\n");
  expect(execRuns(seen)[0].promptText).toContain("add b.txt");
  expect(status(env)).toEqual([
    { status: "failed", parent_turn_id: null },
    { status: "done", parent_turn_id: null },
  ]);
});

test("/cleanup of a held task that never got a clone drops the hold", async () => {
  const { env, clone } = await setup();
  addRepo(env.home, "real", {}, { path: clone }); // no gitAuthor
  const handle = createTurnHandler({
    git,
    db: env.db,
    config: env.config,
    approvals: stubGateway(),
    queryFn: sdk([], []) as never,
    intent: intent(env.home),
  });
  await handle(msg(DEV_REQUEST));
  expect(await handle(msg("/cleanup"))).toContain("Dropped the held task");
  expect(status(env)).toEqual([{ status: "failed", parent_turn_id: null }]);
  expect(resumeQuestionOf(env.db, "th1")).toBeUndefined();
});

test("which failures qualify: the reasons table, and nothing else", () => {
  const r = (over: Partial<FlowResult>): FlowResult => ({
    text: "",
    outcome: "error",
    sessionId: undefined,
    ...over,
  });
  expect(resumeReasonOf(r({ outcome: "error" }))).toBe("error");
  expect(resumeReasonOf(r({ outcome: "error", configRefusal: true }))).toBe("config");
  expect(resumeReasonOf(r({ outcome: "max_budget" }))).toBe("budget");
  // owner stop, restart (also `aborted`), timeout, quota, turn limit, success: never
  for (const outcome of ["aborted", "timeout", "quota", "max_turns", "success"] as const)
    expect(resumeReasonOf(r({ outcome }))).toBeUndefined();
});

test("/cleanup of a held clone removes it and turns the row to failed", async () => {
  const { env, handle } = await run(["error"]);
  await handle(msg(DEV_REQUEST));
  const wt = getWorktreeByThread(env.db, "th1")!;
  expect(listKeptClones(env.db, "main")).toHaveLength(0); // MAX_KEPT_CLONES does not count it
  expect(await handle(msg("/cleanup"))).toContain("Removed");
  expect(existsSync(wt.path)).toBe(false);
  expect(status(env)).toEqual([{ status: "failed", parent_turn_id: null }]);
  expect(resumeQuestionOf(env.db, "th1")).toBeUndefined(); // nothing left to continue
});

test("retention: a held clone expires after CLONE_RETENTION_DAYS idle and its task becomes failed; recent ones stay", async () => {
  const { env, handle } = await run(["error"]);
  await handle(msg(DEV_REQUEST));
  const wt = getWorktreeByThread(env.db, "th1")!;
  const home = env.config.agentHome;
  // 13 days idle: kept
  const t13 = Date.now() + 13 * DAY_MS;
  expect(expireClones(env.db, home, 14, t13)).toEqual([]);
  expect(existsSync(wt.path)).toBe(true);
  expect(status(env)).toEqual([{ status: "failed_resumable", parent_turn_id: null }]);
  // 15 days idle: removed
  const t15 = Date.now() + 15 * DAY_MS;
  expect(expireClones(env.db, home, 14, t15)).toEqual([wt.taskId]);
  expect(existsSync(wt.path)).toBe(false);
  expect(status(env)).toEqual([{ status: "failed", parent_turn_id: null }]);
});

/** A handler whose repo has no commit identity: the failure is at the stage switch, before any clone. */
async function noIdentity(steps: ExecStep[] = []) {
  const { env, clone } = await setup();
  addRepo(env.home, "real", {}, { path: clone });
  const seen: any[] = [];
  const handle = createTurnHandler({
    git,
    db: env.db,
    config: env.config,
    approvals: stubGateway({ confirm: async () => ({ approved: false, reason: "declined" }) }),
    queryFn: sdk(steps, seen) as never,
    intent: intent(env.home),
  });
  return { env, clone, seen, handle };
}

test("a resume is not a fix round: after a resume both real fix rounds still run", async () => {
  const { env, seen, handle } = await run(["error", "ok", "ok", "ok"]);
  await handle(msg(DEV_REQUEST));
  const wt = getWorktreeByThread(env.db, "th1")!;
  await handle(msg("/go"));
  expect(env.db.query("SELECT kind FROM turns WHERE parent_turn_id IS NOT NULL").all()).toEqual([
    { kind: "resume" },
  ]);
  expect(countFollowUps(env.db, wt.taskId)).toBe(0);
  const before = execRuns(seen).length;
  await handle(msg("[dev] also add c"));
  await handle(msg("[dev] also add d"));
  expect(execRuns(seen)).toHaveLength(before + 2);
  expect(countFollowUps(env.db, wt.taskId)).toBe(2);
});

test("clone-less hold: the question names the real reason; it expires by task age (plan file removed) and a stale yes gets no resume", async () => {
  const { env, seen, handle } = await noIdentity(["ok"]);
  await handle(msg(DEV_REQUEST));
  const id = env.db.query<{ id: string }, []>("SELECT id FROM turns").get()!.id;
  const planFile = env.paths.workspace("main").task(id).plan;
  expect(existsSync(planFile)).toBe(true);
  expect(resumeQuestionOf(env.db, "th1")).toContain(RESUMABLE.config);
  const home = env.config.agentHome;
  expect(expireClones(env.db, home, 14, Date.now() + 13 * DAY_MS)).toEqual([]);
  expect(existsSync(planFile)).toBe(true);
  expect(expireClones(env.db, home, 14, Date.now() + 15 * DAY_MS)).toEqual([id]);
  expect(existsSync(planFile)).toBe(false);
  expect(status(env)).toEqual([{ status: "failed", parent_turn_id: null }]);
  expect(resumeQuestionOf(env.db, "th1")).toBeUndefined();
  await handle(msg("continue")); // a stale yes: nothing is resumed (it is read as a new request)
  expect(seen.some((a) => String(a.promptText).includes(RESUME_NOTE))).toBe(false);
});

test("a newer task releases the held clone to the normal retention path", async () => {
  const { env, handle } = await run(["error", "ok"]);
  await handle(msg(DEV_REQUEST));
  const held = getWorktreeByThread(env.db, "th1")!;
  await handle(msg("other thing entirely: add c.txt with three please"));
  const newer = getWorktreeByThread(env.db, "th1")!;
  expect(newer.taskId).not.toBe(held.taskId);
  const removed = expireClones(env.db, env.config.agentHome, 14, Date.now() + 15 * DAY_MS);
  expect(removed).toContain(held.taskId); // no longer held forever (the newer clone follows the kept path)
  expect(existsSync(held.path)).toBe(false);
});

test("a resume that cannot start keeps the hold (task cap reached)", async () => {
  const { env, seen, handle } = await run(["error", "ok"]);
  await handle(msg(DEV_REQUEST));
  for (const id of ["x1", "x2"])
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
