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
  for (const outcome of ["quota", "aborted"]) {
    const s = sup();
    s.observe(issue("limit"));
    s.observe(issue("limit"));
    expect(s.observe(result(outcome)).kind).toBe("report_incomplete");
  }
});
