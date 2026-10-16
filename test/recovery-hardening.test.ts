import { expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTaskLogs } from "../src/lifecycle/startup";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { createRunLimiter } from "../src/orchestrator/turns/run-limiter";
import { finishRun } from "../src/orchestrator/turns/turn-result";
import { getRole } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import { insertTurn, interruptRunningTurns, setTurnStatus } from "../src/storage/run-store";
import { getSession, setSession } from "../src/storage/session-store";
import { fakeQuery, initMsg, makeEnv, resultMsg, stubGateway, TEST_CHANNEL } from "./helpers";
import { devLeadQuery, workersDone } from "./lead-harness";

/** A message the fake lead dispatches to a detached dev worker. */
const task = (text: string, threadId = "th1") => ({
  source: "test",
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId,
  text,
});
/** Handler over a fake query; the worker runs detached, so tests wait with `workersDone`. */
const devHandler = (env: ReturnType<typeof makeEnv>, queryFn: unknown) =>
  createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: stubGateway(),
    limiter: createRunLimiter(10),
    queryFn: devLeadQuery(queryFn),
    leadTiming: { debounceMs: 10, announceWindowMs: 20 },
  });

/** Run the agent against a fake query and return its result. */
const go = (env: ReturnType<typeof makeEnv>, q: ReturnType<typeof fakeQuery>) =>
  runAgent({
    prompt: "q",
    turnId: "T",
    role: getRole("lead"),
    cwd: env.home,
    config: env.config,
    db: env.db,
    abortController: new AbortController(),
    queryFn: q,
  });

// ---- Early session persistence + interrupted status + Resume ----

test("session id is recorded on the task row at init; `sessions` keeps the previous good session", async () => {
  const env = makeEnv();
  setSession(env.db, { threadId: "th1", sessionId: "GOOD", location: "*", cwd: env.location });
  // The stream dies after init: no result message ever arrives (error outcome).
  const q = fakeQuery([initMsg], new Error("boom"));
  await devHandler(env, q)(task("hi"));
  await workersDone(env.db);
  const row = env.db
    .query<{ session_id: string }, []>("SELECT * FROM turns WHERE role = 'developer'")
    .get();
  expect(row).toMatchObject({ session_id: "sess-1" });
  expect(getSession(env.db, "th1")?.session_id).toBe("GOOD");
});

test("quota/error runs never replace the stored session either", async () => {
  const env = makeEnv();
  setSession(env.db, { threadId: "th1", sessionId: "GOOD", location: "*", cwd: env.location });
  const m = resultMsg({
    subtype: "error_during_execution",
    is_error: true,
    errors: ["API Error: 429 rate_limit_error"],
  });
  await devHandler(env, fakeQuery([initMsg, m]))(task("hi"));
  await workersDone(env.db);
  expect(getSession(env.db, "th1")?.session_id).toBe("GOOD");
});

test("restart marks running tasks interrupted", () => {
  const { db } = makeEnv();
  insertTurn(db, { id: "a", threadId: "th", source: "d", location: "r", role: "lead" });
  insertTurn(db, { id: "b", threadId: "th", source: "d", location: "r", role: "developer" });
  setTurnStatus(db, "b", "waiting_approval");
  insertTurn(db, { id: "c", threadId: "other", source: "d", location: "r", role: "lead" });
  setTurnStatus(db, "c", "done");
  interruptRunningTurns(db);
  const st = db.query<{ status: string }, []>("SELECT status FROM turns WHERE id='a'").get();
  expect(st?.status).toBe("interrupted");
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
  const reply = finishRun(env.db, { turnId: "T", threadId: "th" }, r, "en");
  expect(reply).toContain("service is limiting requests");
  expect(reply).toContain(new Date(reset * 1000).toISOString());
});

test("quota: a limit that only surfaces as a thrown error is classified too", async () => {
  const env = makeEnv();
  const r = await go(env, fakeQuery([initMsg], new Error("Claude AI usage limit reached")));
  expect(r.outcome).toBe("quota");
});

test("not quota: location names and line numbers are not provider phrases", async () => {
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
    errors: [`weird internal failure sk-ant-${"x".repeat(30)}`],
  });
  const r = await go(env, fakeQuery([initMsg, m]));
  expect(r.outcome).toBe("error");
  const reply = finishRun(env.db, { turnId: "T", threadId: "th" }, r, "en");
  expect(reply).toBe("I did not finish your request. You can try again.");
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
