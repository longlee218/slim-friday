import { expect, test } from "bun:test";
import type { FridayEvent } from "@friday/contracts";
import type { ApprovalCard, QuestionCard } from "@friday/core";
import { FakeClock } from "../../core/test/fakes/fake-clock";
import { CardDesk } from "../src/card-desk";
import { EventBus } from "../src/event-bus";

const card: ApprovalCard = {
  botId: "a",
  botName: "Ann",
  tool: "Bash",
  summary: "ls",
  scope: { cmd: "ls" },
  offerAlways: true,
  timeoutMs: 600_000,
};
const q: QuestionCard = {
  botId: "a",
  botName: "Ann",
  question: "Color?",
  kind: "single",
  options: [
    { value: "Red", label: "Red" },
    { value: "Blue", label: "Blue" },
  ],
  allowText: false,
  timeoutMs: 600_000,
};

/** A desk with a fake clock and the events its bus saw. */
function setup() {
  const bus = new EventBus(500);
  const events: FridayEvent[] = [];
  const orig = bus.publish.bind(bus);
  bus.publish = (e) => {
    events.push(e);
    return orig(e);
  };
  const clock = new FakeClock(1000);
  return { desk: new CardDesk(bus, clock), clock, events };
}

test("bad answers are refused and the card stays open", () => {
  const { desk } = setup();
  void desk.askQuestion("bot:a", q);
  const id = desk.pendingQuestions()[0]?.cardId as string;
  expect(desk.answerQuestion(id, { choices: ["Purple"] })).toBe("bad_answer");
  expect(desk.answerQuestion(id, { choices: ["Red", "Blue"] })).toBe("bad_answer");
  expect(desk.answerQuestion(id, { choices: [] })).toBe("bad_answer");
  expect(desk.answerQuestion(id, { choices: ["Red"], text: "x" })).toBe("bad_answer");
  expect(desk.pendingQuestions()).toHaveLength(1);
});

test("first answer wins, the second is CONFLICT, unknown is NOT_FOUND", async () => {
  const { desk, events } = setup();
  const p = desk.askApproval("bot:a", card);
  const dto = desk.pendingApprovals()[0];
  expect(dto?.botId).toBe("a");
  expect(dto?.expiresAt).toBe(601_000);
  const id = dto?.cardId as string;
  expect(desk.answerApproval(id, "always")).toBe("ok");
  expect(desk.answerApproval(id, "deny")).toBe("conflict");
  expect(await p).toBe("always");
  expect(desk.answerApproval("nope", "once")).toBe("not_found");
  expect(events.map((e) => e.type)).toEqual(["approval.opened", "approval.closed"]);
  expect(desk.pendingApprovals()).toHaveLength(0);
});

test("approval timeout is deny with a closed event; a late answer is CONFLICT", async () => {
  const { desk, clock, events } = setup();
  const p = desk.askApproval("bot:a", card);
  const id = desk.pendingApprovals()[0]?.cardId as string;
  clock.advance(600_000);
  expect(await p).toBe("deny");
  expect(events[1]).toEqual({ type: "approval.closed", cardId: id, answer: "deny" });
  expect(desk.answerApproval(id, "once")).toBe("conflict");
});

test("an answered card clears its timer", async () => {
  const { desk, clock, events } = setup();
  const p = desk.askApproval("bot:a", card);
  desk.answerApproval(desk.pendingApprovals()[0]?.cardId as string, "once");
  await p;
  clock.advance(600_000);
  expect(events.filter((e) => e.type === "approval.closed")).toHaveLength(1);
});

test("question timeout resolves null and publishes question.closed answer null", async () => {
  const { desk, clock, events } = setup();
  const p = desk.askQuestion("bot:a", q);
  const id = desk.pendingQuestions()[0]?.cardId as string;
  clock.advance(600_000);
  expect(await p).toBeNull();
  expect(events[1]).toEqual({ type: "question.closed", cardId: id, answer: null });
  expect(desk.answerQuestion(id, { choices: ["Red"] })).toBe("conflict");
});

test("a valid question answer settles; openIn counts per conversation", async () => {
  const { desk } = setup();
  const p = desk.askQuestion("bot:a", q);
  void desk.askApproval("bot:a", card);
  void desk.askApproval("bot:b", card);
  expect(desk.openIn("bot:a")).toBe(2);
  const id = desk.pendingQuestions()[0]?.cardId as string;
  expect(desk.answerQuestion(id, { choices: ["Blue"] })).toBe("ok");
  expect(await p).toEqual({ choices: ["Blue"] });
  expect(desk.openIn("bot:a")).toBe(1);
});

test("cancelAll denies approvals and nulls questions", async () => {
  const { desk, events } = setup();
  const a = desk.askApproval("bot:a", card);
  const b = desk.askQuestion("bot:a", q);
  desk.cancelAll();
  expect(await a).toBe("deny");
  expect(await b).toBeNull();
  expect(events.filter((e) => e.type.endsWith(".closed"))).toHaveLength(2);
  expect(desk.openIn("bot:a")).toBe(0);
});

test("a summary with backticks and newlines is flattened and cut", () => {
  const { desk } = setup();
  void desk.askApproval("bot:a", { ...card, summary: "a`b\r\nc" });
  expect(desk.pendingApprovals()[0]?.summary).toBe("a b c");
  void desk.askApproval("bot:a", { ...card, summary: "x".repeat(1300) });
  expect(desk.pendingApprovals()[1]?.summary).toBe(`${"x".repeat(1200)} [CUT: 100 more chars]`);
});

test("closed ids are remembered for the last 500 only", () => {
  const { desk } = setup();
  const ids: string[] = [];
  for (let i = 0; i < 501; i++) {
    void desk.askApproval("bot:a", card);
    const id = desk.pendingApprovals()[0]?.cardId as string;
    ids.push(id);
    desk.answerApproval(id, "once");
  }
  expect(desk.answerApproval(ids[0] as string, "once")).toBe("not_found");
  expect(desk.answerApproval(ids[500] as string, "once")).toBe("conflict");
});
