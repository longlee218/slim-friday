import { expect, test } from "bun:test";
import type { FridayEvent } from "@friday/contracts";
import type { CardRow } from "@friday/core";
import { FakeClock } from "../../core/test/fakes/fake-clock";
import { CardDesk } from "../src/card-desk";
import { EventBus } from "../src/event-bus";

/** A stored open approval card. */
const approval = (id: string, summary = "ls", conversationId = "bot:a"): CardRow => ({
  id,
  kind: "approval",
  wakeId: "w1",
  botId: "a",
  conversationId,
  scopeKey: "a",
  approval: {
    tool: "Bash",
    input: { command: "ls" },
    inputHash: "h",
    summary,
    scope: { cmd: "ls" },
    offerAlways: true,
  },
  status: "open",
  createdAt: 1,
});
/** A stored open question card. */
const question = (id: string): CardRow => ({
  id,
  kind: "question",
  wakeId: "w1",
  botId: "a",
  conversationId: "bot:a",
  scopeKey: "a",
  question: {
    botId: "a",
    botName: "Ann",
    question: "Color?",
    kind: "single",
    options: [{ value: "Red", label: "Red" }],
    allowText: false,
  },
  status: "open",
  createdAt: 1,
});

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

test("a stored approval is published with the card's id and listed until closed", () => {
  const { desk, events } = setup();
  desk.open(approval("c1"), "Ann");
  desk.open(approval("c1"), "Ann");
  expect(events).toEqual([
    {
      type: "approval.opened",
      card: {
        cardId: "c1",
        conversationId: "bot:a",
        botId: "a",
        botName: "Ann",
        tool: "Bash",
        summary: "ls",
        scope: { cmd: "ls" },
        offerAlways: true,
      },
    },
  ]);
  expect(desk.openedAt("c1")).toBe(1000);
  desk.close({ ...approval("c1"), status: "answered", answer: "once" });
  expect(events.at(-1)).toEqual({ type: "approval.closed", cardId: "c1", answer: "once" });
  expect(desk.pendingApprovals()).toEqual([]);
});

test("a question opens and a withdrawn one closes with no answer", () => {
  const { desk, events } = setup();
  desk.open(question("q1"), "Ann");
  expect(desk.pendingQuestions().map((c) => c.question)).toEqual(["Color?"]);
  expect(desk.openIn("bot:a")).toBe(1);
  desk.close({ ...question("q1"), status: "withdrawn" });
  expect(events.at(-1)).toEqual({ type: "question.closed", cardId: "q1", answer: null });
  expect(desk.openIn("bot:a")).toBe(0);
});

test("openIn counts the open cards of one conversation", () => {
  const { desk } = setup();
  desk.open(approval("a1"), "Ann");
  desk.open(approval("a2", "ls", "bot:b"), "Ann");
  desk.open(question("q1"), "Ann");
  expect(desk.openIn("bot:a")).toBe(2);
  expect(desk.openIn("bot:b")).toBe(1);
});

test("a summary with backticks and newlines is flattened and cut", () => {
  const { desk } = setup();
  desk.open(approval("c1", "a`b\r\nc"), "Ann");
  expect(desk.pendingApprovals()[0]?.summary).toBe("a b c");
  desk.open(approval("c2", "x".repeat(1300)), "Ann");
  expect(desk.pendingApprovals()[1]?.summary).toBe(`${"x".repeat(1200)} [CUT: 100 more chars]`);
});

test("the cut is by code points: an emoji at the boundary stays whole", () => {
  const { desk } = setup();
  desk.open(approval("c1", `${"x".repeat(1199)}😀tail`), "Ann");
  expect(desk.pendingApprovals()[0]?.summary).toBe(`${"x".repeat(1199)}😀 [CUT: 4 more chars]`);
});

test("closing an unknown card publishes nothing", () => {
  const { desk, events } = setup();
  desk.close({ ...approval("nope"), status: "answered", answer: "once" });
  expect(events).toEqual([]);
});
