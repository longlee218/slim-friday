import { expect, test } from "bun:test";
import type { FridayEvent } from "@friday/contracts";
import type { CardRow } from "@friday/core";
import { FakeStore } from "../../core/test/fakes/fake-store";
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

/** A desk over a fake store (with bot `a` named Ann) and the events its bus saw. */
function setup() {
  const bus = new EventBus(500);
  const events: FridayEvent[] = [];
  const orig = bus.publish.bind(bus);
  bus.publish = (e) => {
    events.push(e);
    return orig(e);
  };
  const store = new FakeStore();
  return { desk: new CardDesk(bus, store), store, events };
}

test("a stored approval is published with the card's id and the exact input", () => {
  const { desk, events } = setup();
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
        input: '{\n  "command": "ls"\n}',
        inputCut: false,
      },
    },
  ]);
  desk.close({ ...approval("c1"), status: "answered", answer: "once" });
  expect(events.at(-1)).toEqual({ type: "approval.closed", cardId: "c1", answer: "once" });
});

test("cards listed after a restart: a new desk over the same store lists the open ones", async () => {
  const { store } = setup();
  await store.cards.insert(approval("c1"));
  await store.cards.insert(question("q1"));
  const again = new CardDesk(new EventBus(500), store);
  // The name is learned again when the app shows the stored card at start; until then the id stands in.
  expect((await again.pendingApprovals()).map((c) => c.botName)).toEqual(["a"]);
  again.open(approval("c1"), "Ann");
  expect((await again.pendingApprovals()).map((c) => c.botName)).toEqual(["Ann"]);
  expect((await again.pendingQuestions()).map((c) => c.question)).toEqual(["Color?"]);
  expect(await again.openedAt("c1")).toBe(1);
  await store.cards.answer("c1", "once", 5);
  expect(await again.pendingApprovals()).toEqual([]);
  expect(await again.openedAt("c1")).toBeUndefined();
});

test("a withdrawn question closes with no answer", async () => {
  const { desk, store, events } = setup();
  await store.cards.insert(question("q1"));
  expect(await desk.openIn("bot:a")).toBe(1);
  await store.cards.setStatus("q1", "open", "withdrawn");
  desk.close({ ...question("q1"), status: "withdrawn" });
  expect(events.at(-1)).toEqual({ type: "question.closed", cardId: "q1", answer: null });
  expect(await desk.openIn("bot:a")).toBe(0);
});

test("openIn counts the open cards of one conversation", async () => {
  const { desk, store } = setup();
  await store.cards.insert(approval("a1"));
  await store.cards.insert(approval("a2", "ls", "bot:b"));
  await store.cards.insert(question("q1"));
  expect(await desk.openIn("bot:a")).toBe(2);
  expect(await desk.openIn("bot:b")).toBe(1);
});

test("a summary with backticks and newlines is flattened and cut", async () => {
  const { desk, store } = setup();
  await store.cards.insert(approval("c1", "a`b\r\nc"));
  await store.cards.insert({ ...approval("c2", "x".repeat(1300)), createdAt: 2 });
  const [first, second] = await desk.pendingApprovals();
  expect(first?.summary).toBe("a b c");
  expect(second?.summary).toBe(`${"x".repeat(1200)} [CUT: 100 more chars]`);
});

test("the cut is by code points: an emoji at the boundary stays whole", async () => {
  const { desk, store } = setup();
  await store.cards.insert(approval("c1", `${"x".repeat(1199)}😀tail`));
  expect((await desk.pendingApprovals())[0]?.summary).toBe(
    `${"x".repeat(1199)}😀 [CUT: 4 more chars]`,
  );
});

test("a long input is cut and says how much", async () => {
  const { desk, store } = setup();
  const card = approval("c1");
  await store.cards.insert({
    ...card,
    approval: {
      ...(card.approval as NonNullable<CardRow["approval"]>),
      input: { c: "y".repeat(30000) },
    },
  });
  const dto = (await desk.pendingApprovals())[0];
  expect(dto?.input).toMatch(/\[CUT: \d+ more chars\]$/);
  expect(dto?.input.startsWith('{\n  "c": "yyy')).toBe(true);
  expect(dto?.inputCut).toBe(true);
  expect(await desk.inputCut("c1")).toBe(true);
});

test("a whole input is not cut", async () => {
  const { desk, store } = setup();
  await store.cards.insert(approval("c1"));
  expect((await desk.pendingApprovals())[0]?.inputCut).toBe(false);
  expect(await desk.inputCut("c1")).toBe(false);
});

test("a withdrawn approval closes with no answer, not a denial", () => {
  const { desk, events } = setup();
  desk.close({ ...approval("c1"), status: "withdrawn" });
  expect(events.at(-1)).toEqual({ type: "approval.closed", cardId: "c1", answer: null });
});
