import { expect, test } from "bun:test";
import type { WakeRow } from "../../src";
import { replyGuidance } from "../../src/runs/reply-guidance";
import { isAutomatedTurn, runKindOf, silenceAllowed } from "../../src/runs/run-kind";

/** A wake row with only the fields the run kind reads. */
const row = (over: Partial<WakeRow>): WakeRow =>
  ({ sender: { kind: "user" }, intent: "request", ...over }) as WakeRow;
const ann = { kind: "bot", botId: "ann" } as const;

test("runKindOf: intro, ticket, bot and owner", () => {
  expect(runKindOf(row({ intro: true, sender: { kind: "system" } }))).toBe("intro");
  expect(runKindOf(row({ ticketId: "FRI-1" }))).toBe("ticket");
  expect(runKindOf(row({ ticketId: "FRI-1", sender: ann }))).toBe("ticket");
  expect(runKindOf(row({ sender: ann }))).toBe("bot");
  expect(runKindOf(row({}))).toBe("owner");
});

test("runKindOf: continuations and card resumes are owner runs", () => {
  expect(runKindOf(row({ dedupeKey: "cont:w1" }))).toBe("owner");
  expect(runKindOf(row({ cardId: "card1" }))).toBe("owner");
  expect(runKindOf(row({ sender: { kind: "system" } }))).toBe("owner");
});

test("silenceAllowed: ticket runs and a bot fyi that answers no request", () => {
  const cases: [Partial<WakeRow>, boolean][] = [
    [{ ticketId: "FRI-1" }, true],
    [{ sender: ann, intent: "fyi" }, true],
    [{ sender: ann, intent: "fyi", parentWakeId: "w0" }, false],
    [{ sender: ann, intent: "result" }, false],
    [{ sender: ann, intent: "status" }, false],
    [{ sender: ann, intent: "request" }, false],
    [{ sender: ann, intent: "question" }, false],
    [{}, false],
    [{ dedupeKey: "cont:w1" }, false],
    [{ intro: true, sender: { kind: "system" } }, false],
  ];
  for (const [over, want] of cases) {
    const r = row(over);
    expect(silenceAllowed(r, runKindOf(r))).toBe(want);
  }
});

test("replyGuidance: an owner message and an intro run get none (the progress rule is in the system prompt)", () => {
  expect(replyGuidance(row({}), "owner", "owner")).toBeUndefined();
  expect(replyGuidance(row({ intro: true }), "intro", "system")).toBeUndefined();
});

test("replyGuidance: one text per bot intent", () => {
  const g = (over: Partial<WakeRow>) => {
    const r = row({ sender: ann, ...over });
    return replyGuidance(r, runKindOf(r), "Ann") ?? "";
  };
  expect(g({ intent: "request" })).toContain(
    "This is a request. Complete it. Your final written response is automatically returned to Ann",
  );
  expect(g({ intent: "result" })).toContain(
    "Relay it to the owner now, and include the actual substance",
  );
  expect(g({ intent: "status" })).toContain("This is a status for work you delegated.");
  expect(g({ intent: "question" })).toContain("Answer it if you can, then continue");
  expect(g({ intent: "fyi" })).toContain("staying silent is fine. Do not send an acknowledgement.");
  expect(g({ intent: "request", handoff: true })).toContain("Ann handed this step to you.");
});

test("replyGuidance: a ticket run reports on the board and leaves the final reply empty", () => {
  const text = replyGuidance(row({ ticketId: "FRI-1" }), "ticket", "owner") ?? "";
  expect(text).toStartWith("Ticket work is reported on the board, not in chat.");
  expect(text).toContain("TicketComment");
  expect(text).toEndWith("Leave the final reply empty.");
});

test("isAutomatedTurn: continuations, card resumes and system senders, never an owner or bot message", () => {
  expect(isAutomatedTurn(row({ dedupeKey: "cont:w1" }), false)).toBe(true);
  expect(isAutomatedTurn(row({ cardId: "c1" }), true)).toBe(true);
  expect(isAutomatedTurn(row({ sender: { kind: "system" } }), false)).toBe(true);
  expect(isAutomatedTurn(row({}), false)).toBe(false);
  expect(isAutomatedTurn(row({ sender: ann }), false)).toBe(false);
  expect(isAutomatedTurn(row({ dedupeKey: "x" }), false)).toBe(false);
});
