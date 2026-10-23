import { expect, test } from "bun:test";
import { createRunSupervisor, type RunControlEvent } from "../src/runtime/run-supervisor";

const issue = (code: string, tool = "MemorySearch") =>
  ({ kind: "trusted_tool_issue", tool, code }) as RunControlEvent;
const result = (outcome: string, resumable = true): RunControlEvent => ({
  kind: "run_result",
  outcome,
  resumable,
});
const sup = (o: { maxTurns?: number; alreadyRecovered?: boolean } = {}) =>
  createRunSupervisor({
    maxTurns: o.maxTurns ?? 30,
    alreadyRecovered: o.alreadyRecovered ?? false,
  });

test("one recoverable issue does nothing, even at the result", () => {
  const s = sup();
  expect(s.observe(issue("temporarily_busy"))).toEqual({ kind: "continue" });
  expect(s.observe(result("success"))).toEqual({ kind: "continue" });
  const s2 = sup();
  s2.observe(issue("temporarily_busy"));
  expect(s2.observe(result("error")).kind).toBe("report_incomplete");
});

test("the same trusted issue twice requests ONE recovery, only after a result", () => {
  const s = sup();
  expect(s.observe(issue("limit"))).toEqual({ kind: "continue" });
  expect(s.observe(issue("limit"))).toEqual({ kind: "continue" }); // never mid-run
  expect(s.snapshot().recommendation).toBe("recover_after_result");
  expect(s.observe(result("error"))).toEqual({
    kind: "recover_after_result",
    reason: "repeated_issue",
    issueCode: "limit",
  });
  // a second result does not ask again
  expect(s.observe(result("error")).kind).not.toBe("recover_after_result");
});

test("max_turns after a result asks for one recovery; a success never does", () => {
  const s = sup({ maxTurns: 3 });
  for (const n of [1, 2, 3]) s.observe({ kind: "model_turn", turn: n });
  expect(s.snapshot().turns).toBe(3);
  expect(s.observe(result("max_turns"))).toEqual({
    kind: "recover_after_result",
    reason: "turn_limit",
  });
  const ok = sup();
  ok.observe(issue("limit"));
  ok.observe(issue("limit"));
  expect(ok.observe(result("success"))).toEqual({ kind: "continue" });
});

test("unknown raw text cannot create a trusted issue", () => {
  const s = sup();
  s.observe({ kind: "trusted_tool_issue", tool: "Bash", code: "permission denied" } as never);
  s.observe({ kind: "trusted_tool_issue", tool: "Bash", code: "permission denied" } as never);
  expect(s.snapshot().issues).toEqual({});
  expect(s.observe(result("error")).kind).toBe("report_incomplete");
});

test("a guard denial is recorded but never becomes an allow or a recovery", () => {
  const s = sup();
  expect(
    s.observe({ kind: "guard_denied", tool: "Write", reasonCode: "outside_location" }),
  ).toEqual({
    kind: "continue",
  });
  expect(s.snapshot().guardDenied).toBe(true);
  const d = s.observe(result("error"));
  expect(d.kind).toBe("report_incomplete");
  expect(JSON.stringify(s.snapshot())).not.toContain("allow");
});

test("an owner stop suppresses recovery", () => {
  const s = sup();
  s.observe(issue("limit"));
  s.observe(issue("limit"));
  s.observe({ kind: "owner_stop" });
  expect(s.observe(result("aborted"))).toEqual({ kind: "report_incomplete", reason: "owner_stop" });
});

test("owner steer queued is not delivered until an echo event says so", () => {
  const s = sup();
  s.observe({ kind: "owner_steer_state", state: "queued" });
  expect(s.snapshot().steer).toBe("queued");
  s.observe({ kind: "owner_steer_state", state: "held" });
  expect(s.snapshot().steer).toBe("held");
  s.observe({ kind: "owner_steer_state", state: "delivered" });
  expect(s.snapshot().steer).toBe("delivered");
  s.observe({ kind: "owner_steer_state", state: "dropped" });
  expect(s.snapshot().steer).toBe("dropped");
});

test("already recovered: no second recovery, an honest incomplete outcome", () => {
  const s = sup({ alreadyRecovered: true });
  s.observe(issue("limit"));
  s.observe(issue("limit"));
  expect(s.observe(result("error"))).toEqual({
    kind: "report_incomplete",
    reason: "recovery_exhausted",
  });
});

test("quota and aborted results are never recovered", () => {
  // max_budget too: the owner decides a budget raise (`go +usd`), the app never spends more on its own
  for (const outcome of ["quota", "aborted", "max_budget"]) {
    const s = sup();
    s.observe(issue("limit"));
    s.observe(issue("limit"));
    expect(s.observe(result(outcome)).kind).toBe("report_incomplete");
  }
});

/* recoverOnce: the pure selector called at the post-result boundary (plan Task 3). */
import { recoverOnce } from "../src/runtime/run-supervisor";

const snap = (issues: Record<string, number> = {}, stopped = false) => ({
  turns: 5,
  issues,
  stopped,
  guardDenied: false,
  recommendation: "none" as const,
});
const base = {
  result: { outcome: "max_turns", sessionId: "s1" },
  snapshot: snap(),
  alreadyReran: false,
  remainingBudgetUsd: 2,
  uncertainPartialWrite: false,
  approvalWaiting: false,
};

test("recoverOnce: max_turns or a repeated trusted issue resumes once with a fixed internal hint", () => {
  const a = recoverOnce(base);
  expect(a.kind).toBe("resume");
  const b = recoverOnce({
    ...base,
    result: { outcome: "error", sessionId: "s1" },
    snapshot: snap({ limit: 2 }),
  });
  expect(b.kind).toBe("resume");
  if (b.kind === "resume") expect(b.hint).toContain("limit");
});

test("recoverOnce is suppressed without a session, without budget, after a partial write, while waiting for approval, after a prior retry, after a stop", () => {
  const none = (o: object) => expect(recoverOnce({ ...base, ...o })).toEqual({ kind: "none" });
  none({ result: { outcome: "max_turns", sessionId: undefined } });
  none({ remainingBudgetUsd: 0.05 });
  none({ uncertainPartialWrite: true });
  none({ approvalWaiting: true });
  none({ alreadyReran: true });
  none({ snapshot: snap({}, true) });
});

test("recoverOnce never follows a success, an abort, a quota stop or an unknown failure", () => {
  for (const outcome of ["success", "aborted", "quota", "max_budget"])
    expect(
      recoverOnce({ ...base, result: { outcome, sessionId: "s1" }, snapshot: snap({ limit: 3 }) }),
    ).toEqual({ kind: "none" });
  // an unknown tool failure: no repeated trusted issue and not max_turns
  expect(recoverOnce({ ...base, result: { outcome: "error", sessionId: "s1" } })).toEqual({
    kind: "none",
  });
});

/* Task 4: outcome and audit. The audit (`run.control`) keeps the technical reason; Discord text stays plain. */
import { captureLogs } from "../src/observability/logger";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";
import { until } from "./teammate-harness";

const HINT_WORDS = /Internal note|recovery|supervisor|turn_limit|repeated_issue|run\.control/i;

/** Teammate handler whose queries answer from `script` (one entry per query); records every prompt. The teammate posts its reply through `notify`. */
function teammateRun(script: Record<string, unknown>[]) {
  const env = makeEnv();
  let n = 0;
  const prompts: string[] = [];
  const query = (a: any) => {
    prompts.push(String(a.prompt));
    const r = script[Math.min(n++, script.length - 1)]!;
    return (async function* () {
      yield resultMsg(r);
    })();
  };
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: query as never,
    teammateTiming: { debounceMs: 10, announceWindowMs: 20 },
  });
  const posts: string[] = [];
  /** Send the owner message and return the teammate's posted reply (the handler itself returns nothing). */
  const ask = async () => {
    await handle({
      source: "t",
      channelId: TEST_CHANNEL,
      userId: "u",
      threadId: "th-ctl",
      text: "where is the TTL?",
      notify: async (m: string) => void posts.push(m),
    });
    await until(() => posts.length > 0);
    return posts[0];
  };
  return { ask, prompts, runs: () => n };
}
const MAX_TURNS_RESULT = {
  subtype: "error_max_turns",
  is_error: true,
  result: undefined,
  errors: [],
};

test("audit: a successful recovery logs run.control recover (reason turn_limit); the reply is the answer, with no internal text", async () => {
  const cap = captureLogs();
  const r = teammateRun([MAX_TURNS_RESULT, { result: "it is 60s, src/cache.ts:42" }]);
  const reply = await r.ask();
  cap.stop();
  expect(r.runs()).toBe(2);
  expect(reply).toContain("60s");
  expect(reply).not.toMatch(HINT_WORDS);
  const ctl = cap.lines.filter((l) => l.event === "run.control");
  expect(ctl).toContainEqual(expect.objectContaining({ action: "recover", reason: "turn_limit" }));
  for (const l of ctl) expect(JSON.stringify(l)).not.toMatch(/Internal note|where is the TTL/);
});

test("audit: an exhausted recovery logs the technical reason; Discord text says plainly what did not finish", async () => {
  const cap = captureLogs();
  const r = teammateRun([MAX_TURNS_RESULT, MAX_TURNS_RESULT, MAX_TURNS_RESULT]);
  const reply = await r.ask();
  cap.stop();
  expect(r.runs()).toBe(2); // ONE automatic recovery, never more
  expect(reply).toMatch(/didn't finish|couldn't finish|chưa xong|chưa làm xong/i);
  expect(reply).not.toMatch(HINT_WORDS);
  const ctl = cap.lines.filter((l) => l.event === "run.control");
  expect(ctl.map((l) => l.action)).toEqual(["recover", "report_incomplete"]);
  expect(ctl.at(-1)).toMatchObject({ reason: "recovery_exhausted" });
});

test("audit: a success logs nothing (no control action, no noise)", async () => {
  const cap = captureLogs();
  const r = teammateRun([{ result: "fine" }]);
  await r.ask();
  cap.stop();
  expect(cap.lines.some((l) => l.event === "run.control")).toBe(false);
});
