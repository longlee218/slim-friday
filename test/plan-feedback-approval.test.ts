import { expect, test } from "bun:test";
import { type Pending, settleWithFeedback, toResult } from "../src/approvals/approval-buttons";

/* Typed feedback on the open plan request = the Reject button with the owner's words as the reason (Rev 11, H-c). */

/** A pending request with recording callbacks. */
function pendingOf(over: Partial<Pending> = {}) {
  const seen: string[] = [];
  const p: Pending = {
    turnId: "t1",
    threadId: "th",
    tool: "ExitPlanMode",
    settle: (v) => void seen.push(`settle:${v}`),
    timer: setTimeout(() => {}, 60_000),
    finish: (d) => void seen.push(`finish:${d}`),
    edit: async (c) => void seen.push(`edit:${c.split("\n\n").at(-1)}`),
    content: "the plan",
    ...over,
  };
  return { p, seen };
}

test("feedback settles the thread's open plan request as a rejection carrying the text; buttons dropped", () => {
  const { p, seen } = pendingOf();
  const map = new Map([["a1", p]]);
  expect(
    settleWithFeedback(map, "th", "ExitPlanMode", `make it smaller ghp_${"a".repeat(36)}`),
  ).toBe(true);
  expect(map.size).toBe(0);
  expect(seen).toEqual([
    "finish:denied",
    "edit:Owner sent feedback",
    expect.stringMatching(/^settle:feedback:make it smaller/),
  ]);
  const settled = seen[2]!.slice("settle:".length);
  const r = toResult(settled, "owner rejected plan");
  expect(r.approved).toBe(false);
  expect(r.reason).toContain("make it smaller");
  expect(r.reason).not.toContain("ghp_"); // redacted before it reaches the model
  expect(toResult("deny", "owner rejected plan").reason).toBe("owner rejected plan"); // the button stays as it was
});

test("no request of that thread / tool waiting: false, nothing touched; a long feedback is clipped", () => {
  const { p, seen } = pendingOf({ tool: "AskUserQuestion" });
  const map = new Map([["a1", p]]);
  expect(settleWithFeedback(map, "th", "ExitPlanMode", "x")).toBe(false); // other tool
  expect(settleWithFeedback(map, "other", "AskUserQuestion", "x")).toBe(false); // other thread
  expect(map.size).toBe(1);
  expect(seen).toEqual([]);
  expect(toResult(`feedback:${"y".repeat(5000)}`, "d").reason!.length).toBeLessThan(1100);
});
