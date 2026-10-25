import { expect, test } from "bun:test";
import { priorityOf, talksToOwner, type WakeRow } from "../../src";
import {
  replyGuidance,
  SCHEDULE_QUIET_GUIDANCE,
  SCHEDULE_REPLY_GUIDANCE,
} from "../../src/runs/reply-guidance";
import { runKindOf, silenceAllowed } from "../../src/runs/run-kind";
import { taintedAtClaim } from "../../src/runs/run-taint";

/** A scheduled wake row with only the fields the run kind reads. */
const row = (over: Partial<WakeRow> = {}): WakeRow =>
  ({
    sender: { kind: "system" },
    intent: "request",
    scheduleId: "s1",
    cuts: 0,
    ...over,
  }) as WakeRow;

test("runKindOf: a row with scheduleId is a schedule run, after intro and before ticket", () => {
  expect(runKindOf(row())).toBe("schedule");
  expect(runKindOf(row({ intro: true }))).toBe("intro");
  expect(runKindOf(row({ ticketId: "FRI-1" }))).toBe("schedule");
});

test("silenceAllowed: only a quiet schedule, and never with a card", () => {
  expect(silenceAllowed(row(), "schedule")).toBe(false);
  expect(silenceAllowed(row({ scheduleQuiet: true }), "schedule")).toBe(true);
  expect(silenceAllowed(row({ scheduleQuiet: true, cardId: "c" }), "schedule")).toBe(false);
});

test("talksToOwner: a schedule run talks to the owner", () => {
  expect(talksToOwner(row())).toBe(true);
  expect(talksToOwner(row({ scheduleQuiet: true }))).toBe(true);
});

test("replyGuidance: quiet and normal schedule strings", () => {
  expect(replyGuidance(row({ scheduleQuiet: true }), "schedule", "x")).toBe(
    "This is a scheduled run; the owner is not waiting in the chat. Reply only if there is a problem or something the owner must act on; otherwise the whole final reply is exactly NO_RESPONSE. You cannot post progress updates in this run.",
  );
  expect(replyGuidance(row(), "schedule", "x")).toBe(
    "This is a scheduled run; the owner is not waiting in the chat. Write the result as your final answer; it is posted to the chat. You cannot post progress updates in this run.",
  );
  expect(SCHEDULE_QUIET_GUIDANCE).toContain("NO_RESPONSE");
  expect(SCHEDULE_REPLY_GUIDANCE).toContain("final answer");
});

test("taintedAtClaim: a schedule run starts clean, tainted after a cut or a second attempt", () => {
  expect(taintedAtClaim(row(), 1)).toBe(false);
  expect(taintedAtClaim(row({ cuts: 1 }), 1)).toBe(true);
  expect(taintedAtClaim(row(), 2)).toBe(true);
  expect(taintedAtClaim(row({ cardId: "c" }), 1)).toBe(true);
  expect(taintedAtClaim(row({ tainted: true }), 1)).toBe(true);
});

test("priorityOf: background work is background", () => {
  expect(priorityOf({ kind: "system" }, true)).toBe("background");
  expect(priorityOf({ kind: "user" }, false)).toBe("interactive");
});
