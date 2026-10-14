import { expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTaskLogs } from "../src/lifecycle/startup";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { RESUME_PROMPT } from "../src/orchestrator/message-commands";
import { resolveCommand } from "../src/orchestrator/message-routing";
import { finishRun } from "../src/orchestrator/turns/turn-result";
import { getRole } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import {
  ackInterrupted,
  insertTurn,
  interruptRunningTurns,
  listInterruptedThreads,
  setTurnSession,
  setTurnStatus,
} from "../src/storage/run-store";
import { getSession, setSession } from "../src/storage/session-store";
import {
  addLocation,
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
    turnId: "T",
    role: getRole("assistant"),
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
  insertTurn(env.db, { id, threadId, source: "d", location: "*", role });
  setTurnSession(env.db, id, "OLD", cwd);
  interruptRunningTurns(env.db);
}

test("session id is recorded on the task row at init; `sessions` keeps the previous good session", async () => {
  const env = makeEnv();
  setSession(env.db, { threadId: "th1", sessionId: "GOOD", location: "*", cwd: env.location });
  // The stream dies after init: no result message ever arrives (error outcome).
  const q = fakeQuery([initMsg], new Error("boom"));
  await createTurnHandler({ db: env.db, config: env.config, queryFn: q as never })(task("hi"));
  const row = env.db
    .query<{ session_id: string; session_cwd: string }, []>("SELECT * FROM turns")
    .get();
  expect(row).toMatchObject({ session_id: "sess-1", session_cwd: env.location });
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
  await createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: fakeQuery([initMsg, m]) as never,
  })(task("hi"));
  expect(getSession(env.db, "th1")?.session_id).toBe("GOOD");
});

test("restart marks running tasks interrupted; ack makes them cancelled (one notice)", () => {
  const { db } = makeEnv();
  insertTurn(db, { id: "a", threadId: "th", source: "d", location: "r", role: "assistant" });
  insertTurn(db, { id: "b", threadId: "th", source: "d", location: "r", role: "dev" });
  setTurnStatus(db, "b", "waiting_approval");
  insertTurn(db, { id: "c", threadId: "other", source: "d", location: "r", role: "assistant" });
  setTurnStatus(db, "c", "done");
  interruptRunningTurns(db);
  expect(listInterruptedThreads(db)).toEqual(["th"]);
  ackInterrupted(db, "th");
  expect(listInterruptedThreads(db)).toEqual([]);
  const st = db.query<{ status: string }, []>("SELECT status FROM turns WHERE id='a'").get();
  expect(st?.status).toBe("cancelled");
});

test("Resume: Q&A thread resumes the interrupted task's session with the fixed prompt", async () => {
  const env = makeEnv();
  interrupted(env, "th1", env.location);
  let seen: any;
  const q = (a: any) => {
    seen = a;
    return (async function* () {
      yield initMsg;
      yield resultMsg({ result: "continued" });
    })();
  };
  const handle = createTurnHandler({ db: env.db, config: env.config, queryFn: q as never });
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
  const reply = await createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: q as never,
  })(task(RESUME_PROMPT, "empty"));
  expect(reply).toContain("Cannot resume");
  expect(ran).toBe(false);
});

test("Resume of a dev run whose session cannot be resumed: tells the owner to start again", async () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const location = addLocation(env.home, "real", { gitAuthor: "T <t@e.com>" }); // fake managed clone: code tasks are allowed
  interrupted(env, "pl", location, "T1", "dev");
  const q = fakeQuery([
    resultMsg({
      subtype: "error_during_execution",
      is_error: true,
      errors: ["No conversation found with session ID: OLD"],
    }),
  ]);
  const reply = await createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: q as never,
    approvals: stubGateway(),
  })(task(RESUME_PROMPT, "pl"));
  expect(reply).toContain("start the task again");
  // The failed resume task has no session: another Resume is refused (not offered forever).
  expect(
    resolveCommand(
      { db: env.db, agentHome: env.home, workspace: "main", locations: [] },
      { kind: "resume" },
      "pl",
    ),
  ).toHaveProperty("reply");
});

test("resolveCommand: a dev run resumes its own session in its cwd; Q&A cwd ok; unusable cwd, stale, none refused", () => {
  const env = makeEnv();
  const locations = [{ name: "location", path: env.location, description: "" }] as never;
  const deps = { db: env.db, agentHome: env.home, workspace: "main", locations };
  const resume = (t: string) => resolveCommand(deps, { kind: "resume" }, t);
  interrupted(env, "p", env.location, "A", "dev");
  expect(resume("p")).toMatchObject({
    cmd: { kind: "message", role: "dev", text: RESUME_PROMPT },
    resume: { sessionId: "OLD", cwd: env.location, of: "A" },
  });

  interrupted(env, "q", env.location, "B");
  expect(resume("q")).toMatchObject({ cmd: { kind: "message", text: RESUME_PROMPT } });

  // A dev session whose dir is gone cannot be continued (a fresh session would have no context).
  interrupted(env, "g", join(env.home, "gone-dir"), "G", "dev");
  expect(resume("g")).toMatchObject({ reason: "cannot_resume" });

  // cwd outside the home cwd dir / registered locations: a fresh session would have no context.
  interrupted(env, "x", "/elsewhere", "C");
  expect(resume("x")).toHaveProperty("reply");

  // A newer finished task makes the Resume stale.
  insertTurn(env.db, { id: "N", threadId: "q", source: "d", location: "*", role: "assistant" });
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
