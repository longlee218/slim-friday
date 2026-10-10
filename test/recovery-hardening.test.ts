import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkWorktrees, cleanupTaskLogs } from "../src/lifecycle/startup";
import { createTaskHandler } from "../src/orchestrator/handle-task";
import { RESUME_PROMPT } from "../src/orchestrator/task-commands";
import { resolveCommand } from "../src/orchestrator/task-routing";
import { finishRun } from "../src/orchestrator/tasks/task-result";
import { getStage } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import {
  ackInterrupted,
  insertTask,
  interruptRunningTasks,
  listInterruptedThreads,
  setTaskSession,
  setTaskStatus,
} from "../src/storage/run-store";
import { getSession, setSession } from "../src/storage/session-store";
import { insertWorktree, listWorktrees } from "../src/storage/worktree-store";
import {
  addRepo,
  clearWorkspaces,
  fakeQuery,
  initMsg,
  makeEnv,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";

const task = (text: string, threadId = "th1") => ({
  source: "test",
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId,
  text,
});

/** Run the agent against a fake query and return its result. */
const go = (env: ReturnType<typeof makeEnv>, q: ReturnType<typeof fakeQuery>) =>
  runAgent({
    prompt: "q",
    taskId: "T",
    stage: getStage("assistant", "qa"),
    cwd: env.home,
    config: env.config,
    db: env.db,
    abortController: new AbortController(),
    queryFn: q,
  });

// ---- Early session persistence + interrupted status + Resume ----

/** Task row of a thread that was cut short with a recorded session (what a restart leaves behind). */
function interrupted(
  env: ReturnType<typeof makeEnv>,
  threadId: string,
  cwd: string,
  id = "T0",
  role = "assistant",
) {
  insertTask(env.db, { id, threadId, source: "d", repo: "*", role });
  setTaskSession(env.db, id, "OLD", cwd);
  interruptRunningTasks(env.db);
}

test("session id is recorded on the task row at init; `sessions` keeps the previous good session", async () => {
  const env = makeEnv();
  setSession(env.db, { threadId: "th1", sessionId: "GOOD", repo: "*", cwd: env.repo });
  // The stream dies after init: no result message ever arrives (error outcome).
  const q = fakeQuery([initMsg], new Error("boom"));
  await createTaskHandler({ db: env.db, config: env.config, queryFn: q as never })(task("hi"));
  const row = env.db
    .query<{ session_id: string; session_cwd: string }, []>("SELECT * FROM tasks")
    .get();
  expect(row).toMatchObject({ session_id: "sess-1", session_cwd: env.repo });
  expect(getSession(env.db, "th1")?.session_id).toBe("GOOD");
});

test("quota/error runs never replace the stored session either", async () => {
  const env = makeEnv();
  setSession(env.db, { threadId: "th1", sessionId: "GOOD", repo: "*", cwd: env.repo });
  const m = resultMsg({
    subtype: "error_during_execution",
    is_error: true,
    errors: ["API Error: 429 rate_limit_error"],
  });
  await createTaskHandler({
    db: env.db,
    config: env.config,
    queryFn: fakeQuery([initMsg, m]) as never,
  })(task("hi"));
  expect(getSession(env.db, "th1")?.session_id).toBe("GOOD");
});

test("restart marks running tasks interrupted; ack makes them cancelled (one notice)", () => {
  const { db } = makeEnv();
  insertTask(db, { id: "a", threadId: "th", source: "d", repo: "r", role: "assistant" });
  insertTask(db, { id: "b", threadId: "th", source: "d", repo: "r", role: "dev" });
  setTaskStatus(db, "b", "waiting_approval");
  insertTask(db, { id: "c", threadId: "other", source: "d", repo: "r", role: "assistant" });
  setTaskStatus(db, "c", "done");
  interruptRunningTasks(db);
  expect(listInterruptedThreads(db)).toEqual(["th"]);
  ackInterrupted(db, "th");
  expect(listInterruptedThreads(db)).toEqual([]);
  const st = db.query<{ status: string }, []>("SELECT status FROM tasks WHERE id='a'").get();
  expect(st?.status).toBe("cancelled");
});

test("Resume: Q&A thread resumes the interrupted task's session with the fixed prompt", async () => {
  const env = makeEnv();
  interrupted(env, "th1", env.repo);
  let seen: any;
  const q = (a: any) => {
    seen = a;
    return (async function* () {
      yield initMsg;
      yield resultMsg({ result: "continued" });
    })();
  };
  const handle = createTaskHandler({ db: env.db, config: env.config, queryFn: q as never });
  expect(await handle(task(RESUME_PROMPT))).toBe("continued");
  expect(seen.prompt).toBe(RESUME_PROMPT);
  expect(seen.options.resume).toBe("OLD");
  // The thread moved on (task finished): a second Resume click is out of date.
  expect(await handle(task(RESUME_PROMPT))).toContain("out of date");
});

test("Resume without a saved session replies it cannot resume (no run)", async () => {
  const env = makeEnv();
  let ran = false;
  const q = () => {
    ran = true;
    return (async function* () {})();
  };
  const reply = await createTaskHandler({
    db: env.db,
    config: env.config,
    queryFn: q as never,
  })(task(RESUME_PROMPT, "empty"));
  expect(reply).toContain("Cannot resume");
  expect(ran).toBe(false);
});

test("Resume of a plan stage whose session cannot be resumed: tells the owner to start again", async () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  addRepo(env.home, "real", { gitAuthor: "T <t@e.com>" }); // fake managed clone: code tasks are allowed
  const scratch = join(realpathSync(env.home), "workspaces", "main", "tasks", "T1", "scratch");
  mkdirSync(scratch, { recursive: true });
  interrupted(env, "pl", scratch);
  const q = fakeQuery([
    resultMsg({
      subtype: "error_during_execution",
      is_error: true,
      errors: ["No conversation found with session ID: OLD"],
    }),
  ]);
  const reply = await createTaskHandler({
    db: env.db,
    config: env.config,
    queryFn: q as never,
    approvals: stubGateway(),
  })(task(RESUME_PROMPT, "pl"));
  expect(reply).toContain("start the task again");
  // The failed resume task has no session: another Resume is refused (not offered forever).
  expect(
    resolveCommand(
      { db: env.db, agentHome: env.home, workspace: "main", repos: [] },
      { kind: "resume" },
      "pl",
    ),
  ).toHaveProperty("reply");
});

test("resolveCommand: plan stage / worktree / Q&A cwd ok; unusable cwd, stale, none refused", () => {
  const env = makeEnv();
  const repos = [{ name: "repo", path: env.repo, description: "" }] as never;
  const deps = { db: env.db, agentHome: env.home, workspace: "main", repos };
  const resume = (t: string) => resolveCommand(deps, { kind: "resume" }, t);
  const scratch = join(realpathSync(env.home), "workspaces", "main", "tasks", "T1", "scratch");
  mkdirSync(scratch, { recursive: true });
  interrupted(env, "p", scratch, "A", "dev");
  expect(resume("p")).toMatchObject({
    cmd: { kind: "task", role: "dev" },
    planResume: { sessionId: "OLD", cwd: scratch },
  });

  interrupted(env, "q", env.repo, "B");
  expect(resume("q")).toMatchObject({ cmd: { kind: "task", text: RESUME_PROMPT } });

  // cwd outside the home cwd dir / registered repos: a fresh session would have no context.
  interrupted(env, "x", "/elsewhere", "C");
  expect(resume("x")).toHaveProperty("reply");

  const wtPath = join(env.home, "wt");
  mkdirSync(wtPath);
  insertWorktree(env.db, {
    taskId: "T2",
    threadId: "w",
    repo: "repo",
    repoPath: env.repo,
    path: wtPath,
    branch: "b",
    base: "main",
  });
  interrupted(env, "w", realpathSync(wtPath), "D");
  expect(resume("w")).toMatchObject({ cmd: { kind: "task" } });
  interrupted(env, "w2", "/elsewhere", "E");
  insertWorktree(env.db, {
    taskId: "T3",
    threadId: "w2",
    repo: "repo",
    repoPath: env.repo,
    path: wtPath,
    branch: "b2",
    base: "main",
  });
  expect(resume("w2")).toHaveProperty("reply");

  // A newer finished task makes the Resume stale.
  insertTask(env.db, { id: "N", threadId: "q", source: "d", repo: "*", role: "assistant" });
  expect(resume("q")).toMatchObject({ reason: "stale_resume" });
});

// ---- Quota / error classification ----

test("quota: error result with rate-limit text -> outcome quota, no text, no retry", async () => {
  const env = makeEnv();
  const m = resultMsg({
    subtype: "error_during_execution",
    is_error: true,
    errors: ["API Error: 429 rate_limit_error"],
  });
  const r = await go(env, fakeQuery([initMsg, m]));
  expect(r.outcome).toBe("quota");
  expect(r.text).toBe("");
});

test("quota: rejected rate_limit_event + assistant error gives reset time in the reply", async () => {
  const env = makeEnv();
  const reset = 1_900_000_000; // epoch seconds
  const msgs = [
    initMsg,
    { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: reset } },
    { type: "assistant", error: "rate_limit", message: { content: [] } },
    resultMsg({ subtype: "error_during_execution", is_error: true, errors: ["limit"] }),
  ];
  const r = await go(env, fakeQuery(msgs as never));
  expect(r.outcome).toBe("quota");
  expect(r.resetsAt).toBe(reset * 1000);
  const reply = finishRun(env.db, { taskId: "T", threadId: "th" }, r);
  expect(reply).toContain("Quota exhausted / rate limited");
  expect(reply).toContain(new Date(reset * 1000).toISOString());
});

test("quota: a limit that only surfaces as a thrown error is classified too", async () => {
  const env = makeEnv();
  const r = await go(env, fakeQuery([initMsg], new Error("Claude AI usage limit reached")));
  expect(r.outcome).toBe("quota");
});

test("not quota: repo names and line numbers are not provider phrases", async () => {
  const env = makeEnv();
  const m = resultMsg({
    subtype: "error_during_execution",
    is_error: true,
    errors: ["Cannot read billing-service/src/a.ts line 429 quota.ts:529"],
  });
  expect((await go(env, fakeQuery([initMsg, m]))).outcome).toBe("error");
});

test("quota: an assistant error cleared by a later good assistant message is not quota", async () => {
  const env = makeEnv();
  const msgs = [
    initMsg,
    { type: "assistant", error: "rate_limit", message: { content: [] } },
    { type: "assistant", message: { content: [] } }, // SDK retry succeeded
    resultMsg({ subtype: "error_during_execution", is_error: true, errors: ["weird"] }),
  ];
  expect((await go(env, fakeQuery(msgs as never))).outcome).toBe("error");
});

test("unknown error: generic reply, raw error not shown to the user", async () => {
  const env = makeEnv();
  const m = resultMsg({
    subtype: "error_during_execution",
    is_error: true,
    errors: ["weird internal failure sk-ant-" + "x".repeat(30)],
  });
  const r = await go(env, fakeQuery([initMsg, m]));
  expect(r.outcome).toBe("error");
  const reply = finishRun(env.db, { taskId: "T", threadId: "th" }, r);
  expect(reply).toBe("Agent failed. Check the logs.");
});

// ---- Startup hygiene ----

test("cleanupTaskLogs deletes *.jsonl older than 30 days (single logs dir), keeps newer", () => {
  const env = makeEnv();
  const now = Date.now();
  const day = 86_400_000;
  const dirs = [env.paths.taskLog("x").replace(/x\.jsonl$/, "")];
  const files: string[] = [];
  for (const d of dirs) {
    mkdirSync(d, { recursive: true });
    for (const [name, age] of [
      ["old", 31],
      ["new", 5],
    ] as const) {
      const f = join(d, `${name}.jsonl`);
      writeFileSync(f, "{}");
      utimesSync(f, new Date(now - age * day), new Date(now - age * day));
      files.push(f);
    }
  }
  writeFileSync(join(dirs[0]!, "old.txt"), "keep"); // not a jsonl
  utimesSync(join(dirs[0]!, "old.txt"), new Date(now - 90 * day), new Date(now - 90 * day));
  expect(cleanupTaskLogs(env.home, now)).toBe(1);
  const exists = (f: string) => Bun.file(f).size > 0;
  expect(files.filter(exists).map((f) => f.endsWith("new.jsonl"))).toEqual([true]);
  expect(exists(join(dirs[0]!, "old.txt"))).toBe(true);
});

test("checkWorktrees: dir without row is reported; row without dir is deleted", () => {
  const env = makeEnv();
  const root = env.paths.workspace("main").repo("repo").worktrees;
  const kept = join(root, "KEEP");
  const orphan = join(root, "ORPHAN");
  mkdirSync(kept, { recursive: true });
  mkdirSync(orphan, { recursive: true });
  const base = { threadId: "t", repo: "repo", repoPath: env.repo, branch: "b", base: "main" };
  insertWorktree(env.db, { ...base, taskId: "KEEP", path: kept });
  insertWorktree(env.db, { ...base, taskId: "GONE", path: join(root, "GONE") });
  const r = checkWorktrees(env.db, env.home);
  expect(r.noRow).toEqual([orphan]);
  expect(r.missingDir).toEqual(["GONE"]);
  expect(listWorktrees(env.db).map((w) => w.taskId)).toEqual(["KEEP"]);
});

test("cleanupTaskLogs skips a directory named *.jsonl and still cleans the rest", () => {
  const env = makeEnv();
  const now = Date.now();
  const dir = env.paths.taskLog("x").replace(/x\.jsonl$/, "");
  mkdirSync(join(dir, "weird.jsonl"), { recursive: true });
  const old = join(dir, "old.jsonl");
  writeFileSync(old, "{}");
  const t = new Date(now - 40 * 86_400_000);
  utimesSync(join(dir, "weird.jsonl"), t, t);
  utimesSync(old, t, t);
  expect(cleanupTaskLogs(env.home, now)).toBe(1);
  expect(Bun.file(old).size).toBe(0);
});

test("checkWorktrees keeps rows when the worktrees root itself is missing (transient)", () => {
  const env = makeEnv();
  const path = join(env.paths.workspace("main").repo("repo").worktrees, "T");
  insertWorktree(env.db, {
    taskId: "T",
    threadId: "t",
    repo: "repo",
    repoPath: env.repo,
    path,
    branch: "b",
    base: "main",
  });
  expect(checkWorktrees(env.db, env.home).missingDir).toEqual(["T"]);
  expect(listWorktrees(env.db)).toHaveLength(1);
});
