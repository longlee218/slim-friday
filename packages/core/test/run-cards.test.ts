import { expect, test } from "bun:test";
import { CORE_DEFAULTS } from "../src";
import { BotHub } from "../src/hub/bot-hub";
import { inputHash } from "../src/permission/input-hash";
import { PermissionGate, WAITING_TEXT } from "../src/permission/permission-gate";
import { DENIAL_TEXT } from "../src/runs/approval-continuation";
import { flush, makeHub } from "./bot-hub-harness";
import { FakeRuntime } from "./fakes/fake-runtime";
import { FakeSurface } from "./fakes/fake-surface";
import { FakeToolCatalog } from "./fakes/fake-tool-catalog";

type Hub = ReturnType<typeof makeHub>;
const LS = { tool: "Bash", input: { command: "ls" } };
const APPROVED =
  'The owner approved: Bash {"command":"ls"}. Call exactly this request, in this order, with these arguments, and do not ask for approval again.';

/** A hub where editor may use Bash, with editor's direct run parked on an approval for `ls`. */
async function parked() {
  const h = makeHub();
  h.editor.tools = ["Bash"];
  h.surface.deliver({ conversationId: "dc", text: "list files" });
  await flush();
  const d = await h.runtime.last().spec.decide(LS);
  await flush();
  const cardId = d.behavior === "park" ? d.cardId : "";
  return { ...h, d, cardId, first: h.runtime.nth(0) };
}
const wakes = (h: Hub) => [...h.store.wakeMap.values()];

test("ask writes one card and parks the run, worker freed", async () => {
  const h = await parked();
  expect(h.d.behavior).toBe("park");
  expect(h.store.cardMap.get(h.cardId)?.status).toBe("open");
  expect(wakes(h)[0]).toMatchObject({ status: "waiting_input", cardId: h.cardId });
  expect(h.first.stopped).toBe(true);
  // Parked, not busy: the row is listed as parked.
  expect(await h.hub.status()).toMatchObject([{ botId: "editor", busy: false, parked: true }]);
  expect([...h.store.attemptMap.values()].map((a) => a.status)).toEqual(["parked"]);
});

/** Make every card insert of the store wait a few ms (a slow db), so concurrent asks overlap. */
function slowInserts(h: Hub) {
  const insert = h.store.cards.insertIfNoneOpen;
  h.store.cards.insertIfNoneOpen = async (g) => {
    await Bun.sleep(5);
    return insert(g);
  };
}

test("second ask in the same step does not open a second card", async () => {
  const h = makeHub();
  slowInserts(h);
  h.surface.deliver({ conversationId: "dc", text: "go" });
  await flush();
  const s = h.runtime.last();
  // Both calls are in flight before either card is stored; nothing hangs.
  const [a, b] = await Promise.all([
    s.spec.decide(LS),
    s.spec.decide({ tool: "Bash", input: { command: "pwd" } }),
  ]);
  expect(a.behavior).toBe("park");
  expect(b).toEqual({ behavior: "deny", reason: WAITING_TEXT });
  expect(h.store.cardMap.size).toBe(1);
  await flush();
  expect(wakes(h)[0]?.status).toBe("waiting_input");
});

test("two concurrent question calls open one card group; the other is refused", async () => {
  const h = makeHub();
  slowInserts(h);
  h.surface.deliver({ conversationId: "dc", text: "go" });
  await flush();
  const s = h.runtime.last();
  const q = {
    botId: "",
    botName: "",
    question: "Q?",
    kind: "single" as const,
    options: [],
    allowText: true,
  };
  const [a, b] = await Promise.all([s.spec.ask?.([q, q]), s.spec.ask?.([q])]);
  expect(a?.behavior).toBe("park");
  expect(b).toEqual({ behavior: "refused", reason: WAITING_TEXT });
  expect(h.store.cardMap.size).toBe(2);
});

test("a concurrent tool call while a question is being stored is denied, not carded", async () => {
  const h = makeHub();
  slowInserts(h);
  h.surface.deliver({ conversationId: "dc", text: "go" });
  await flush();
  const s = h.runtime.last();
  const q = {
    botId: "",
    botName: "",
    question: "Q?",
    kind: "single" as const,
    options: [],
    allowText: true,
  };
  const [a, b] = await Promise.all([s.spec.ask?.([q]), s.spec.decide(LS)]);
  expect(a?.behavior).toBe("park");
  expect(b).toEqual({ behavior: "deny", reason: WAITING_TEXT });
  expect(h.store.cardMap.size).toBe(1);
});

test("run with an open background task does not park until the task ends", async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "go" });
  await flush();
  const s = h.runtime.last();
  s.emit({ type: "task_started", taskId: "t1", description: "dig" });
  await flush();
  const d = s.spec.decide(LS);
  await flush();
  expect(h.surface.shown).toHaveLength(1);
  expect(wakes(h)[0]?.status).toBe("running");
  expect(s.stopped).toBe(false);
  s.emit({ type: "task_done", taskId: "t1", status: "completed", summary: "ok" });
  await flush();
  expect((await d).behavior).toBe("park");
  expect(wakes(h)[0]?.status).toBe("waiting_input");
  expect(s.stopped).toBe(true);
});

test("answer while still running applies in place", async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "go" });
  await flush();
  const s = h.runtime.last();
  s.emit({ type: "task_started", taskId: "t1", description: "dig" });
  await flush();
  const d = s.spec.decide(LS);
  await flush();
  const id = h.surface.shown[0]?.card.id ?? "";
  expect(await h.hub.answerCard(id, "once")).toBe("ok");
  expect(await d).toEqual({ behavior: "allow" });
  expect(h.store.cardMap.get(id)?.status).toBe("used");
  expect(wakes(h)[0]?.status).toBe("running");
  expect(h.runtime.created).toHaveLength(1);
});

test("approve requeues and resume allows only the exact call once", async () => {
  const h = await parked();
  expect(await h.hub.answerCard(h.cardId, "once")).toBe("ok");
  expect(await h.hub.answerCard(h.cardId, "deny")).toBe("conflict");
  await flush();
  const s = h.runtime.last();
  expect(h.runtime.resumed.map((r) => r.sessionId)).toEqual([h.first.id]);
  expect(s.sent[0]).toMatchObject({ text: APPROVED, from: { kind: "system" } });
  expect(await s.spec.decide({ tool: "Bash", input: { command: "ls" } })).toEqual({
    behavior: "allow",
  });
  expect(h.store.cardMap.get(h.cardId)?.status).toBe("used");
  // The one shot is spent: the same call again asks again.
  expect((await s.spec.decide(LS)).behavior).toBe("park");
  expect(h.store.cardMap.size).toBe(2);
});

test("parallel identical calls after approval: exactly one is allowed", async () => {
  const h = await parked();
  await h.hub.answerCard(h.cardId, "once");
  await flush();
  const s = h.runtime.last();
  const ds = await Promise.all([s.spec.decide(LS), s.spec.decide(LS)]);
  expect(ds.filter((d) => d.behavior === "allow")).toHaveLength(1);
  expect(h.store.cardMap.get(h.cardId)?.status).toBe("used");
});

test("different input after approval asks again", async () => {
  const h = await parked();
  await h.hub.answerCard(h.cardId, "once");
  await flush();
  const d = await h.runtime.last().spec.decide({ tool: "Bash", input: { command: "rm -rf x" } });
  expect(d.behavior).toBe("park");
  expect(h.store.cardMap.get(h.cardId)?.status).toBe("answered");
});

test("deny reaches the bot with the denial text", async () => {
  const h = await parked();
  await h.hub.answerCard(h.cardId, "deny");
  await flush();
  expect(h.runtime.last().sent[0]?.text).toBe(DENIAL_TEXT);
  expect((await h.runtime.last().spec.decide(LS)).behavior).toBe("park");
});

test("approved tool gone after reload", async () => {
  const h = await parked();
  // The config reload took Bash away from editor.
  h.store.botMap.set("editor", { ...h.editor, tools: [] });
  await h.hub.answerCard(h.cardId, "once");
  await flush();
  const s = h.runtime.last();
  expect(s.sent[0]?.text).toBe("The tool Bash is no longer available to you; tell the owner.");
  expect((await s.spec.decide(LS)).behavior).toBe("park");
});

test("open card survives a restart and is listed", async () => {
  const h = await parked();
  // A new boot over the same store: nothing re-asks, the card is still open and the run still parked.
  const runtime = new FakeRuntime();
  const surface = new FakeSurface();
  const gate = new PermissionGate({
    store: h.store,
    surface,
    clock: h.clock,
    catalog: new FakeToolCatalog([]),
    settings: () => ({ level: "balanced" }),
  });
  const hub = new BotHub({ runtime, surface, store: h.store, clock: h.clock, gate });
  hub.start();
  await hub.recover();
  await flush();
  expect((await h.store.cards.open()).map((c) => c.id)).toEqual([h.cardId]);
  expect(runtime.created).toHaveLength(0);
  expect(await hub.answerCard(h.cardId, "once")).toBe("ok");
  await flush();
  expect(runtime.last().sent[0]?.text).toBe(APPROVED);
});

test("reminder once after 4 h, never a cancel", async () => {
  const h = await parked();
  const reminders = () => h.surface.posts.filter((p) => p.message.text.includes("still waiting"));
  await h.hub.sweepCards();
  expect(reminders()).toHaveLength(0);
  h.clock.advance(CORE_DEFAULTS.cardReminderMs);
  await h.hub.sweepCards();
  await h.hub.sweepCards();
  expect(reminders().map((p) => p.message.text)).toEqual([
    "Editor is still waiting for you to approve Bash.",
  ]);
  h.clock.advance(CORE_DEFAULTS.cardReminderMs * 10);
  await h.hub.sweepCards();
  expect(reminders()).toHaveLength(1);
  expect(h.store.cardMap.get(h.cardId)?.status).toBe("open");
  expect(wakes(h)[0]?.status).toBe("waiting_input");
});

test("the sweep requeues a parked run whose card was answered before a crash", async () => {
  const h = await parked();
  // The answer was stored, then the process died before the requeue.
  await h.store.cards.answer(h.cardId, "once", h.clock.now());
  expect(wakes(h)[0]?.status).toBe("waiting_input");
  await h.hub.sweepCards();
  await flush();
  expect(h.runtime.last().sent[0]?.text).toBe(APPROVED);
});

test("new owner message while parked on approval starts a new run", async () => {
  const h = await parked();
  h.runtime.onTurn = (s) => {
    s.emit({ type: "text", text: "hello back" });
    s.emit({ type: "turn_end", costUsd: 0 });
  };
  h.surface.deliver({ conversationId: "dc", text: "something else" });
  await flush();
  expect(wakes(h).map((w) => w.status)).toEqual(["waiting_input", "done"]);
  expect(h.runtime.last().sent[0]?.text).toBe("something else");
  expect(h.store.cardMap.get(h.cardId)?.status).toBe("open");
});

test("a question's answer is the reply to its question on resume", async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "go" });
  await flush();
  const q = {
    botId: "",
    botName: "",
    question: "Color?",
    kind: "single" as const,
    allowText: false,
  };
  await h.runtime.last().spec.ask?.([{ ...q, options: [{ value: "Blue", label: "Blue" }] }]);
  await flush();
  const id = h.surface.shown[0]?.card.id ?? "";
  expect(await h.hub.answerCard(id, { choices: ["Red"] })).toBe("bad_answer");
  expect(await h.hub.answerCard(id, { choices: ["Blue"] })).toBe("ok");
  await flush();
  expect(h.runtime.last().sent[0]?.text).toBe('The owner answered your question "Color?": Blue');
});

test("a withdrawn question is named on resume and the owner's message follows", async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "go" });
  await flush();
  const q = { botId: "", botName: "", question: "Pick", kind: "single" as const, allowText: false };
  await h.runtime.last().spec.ask?.([{ ...q, options: [{ value: "a", label: "a" }] }]);
  await flush();
  h.surface.deliver({ conversationId: "dc", text: "never mind, do this" });
  await flush();
  const text = h.runtime.last().sent[0]?.text ?? "";
  expect(text).toContain(
    'Your question "Pick" was withdrawn because the owner wrote something else instead.',
  );
  expect(text).toContain("never mind, do this");
  expect(h.surface.closed.map((c) => c.status)).toEqual(["withdrawn"]);
});

/** The worker died after the card was written and before the park was stored: the run is `running`, lease gone. */
async function crashedAfterCard() {
  const h = makeHub();
  h.editor.tools = ["Bash"];
  h.surface.deliver({ conversationId: "dc", text: "list files" });
  await flush();
  const run = wakes(h)[0];
  const id = "card-lost";
  await h.store.cards.insert({
    id,
    kind: "approval",
    wakeId: run?.id ?? "",
    botId: "editor",
    conversationId: "dc",
    scopeKey: "editor",
    approval: {
      tool: "Bash",
      input: { command: "ls" },
      inputHash: await inputHash("Bash", { command: "ls" }),
      summary: "Bash",
      scope: {},
      offerAlways: false,
    },
    status: "open",
    createdAt: 0,
  });
  // A new boot over the same store reclaims the run (an older boot's lease is reclaimable at once).
  const runtime = new FakeRuntime();
  const surface = new FakeSurface();
  const gate = new PermissionGate({
    store: h.store,
    surface,
    clock: h.clock,
    catalog: new FakeToolCatalog([]),
    settings: () => ({ level: "balanced" }),
  });
  const hub = new BotHub({ runtime, surface, store: h.store, clock: h.clock, gate });
  hub.start();
  return { ...h, id, hub, runtime };
}

test("a reclaimed run with its own card still open parks at once: no session, no cut", async () => {
  const h = await crashedAfterCard();
  await h.hub.recover();
  await flush();
  expect(h.runtime.created).toHaveLength(0);
  expect(wakes(h)[0]).toMatchObject({ status: "waiting_input", cardId: h.id, cuts: 0 });
  // The answer finds the parked run and resumes it.
  expect(await h.hub.answerCard(h.id, "once")).toBe("ok");
  await flush();
  expect(h.runtime.last().sent[0]?.text).toBe(APPROVED);
  expect(await h.runtime.last().spec.decide(LS)).toEqual({ behavior: "allow" });
});

test("a reclaimed run whose own card was answered meanwhile resumes with the continuation", async () => {
  const h = await crashedAfterCard();
  // The owner answered while no worker held the run: there was no parked run to requeue.
  expect(await h.hub.answerCard(h.id, "deny")).toBe("ok");
  await h.hub.recover();
  await flush();
  expect(h.runtime.created).toHaveLength(1);
  expect(h.runtime.last().sent[0]?.text).toBe(DENIAL_TEXT);
  expect(wakes(h)[0]?.cardId).toBe(h.id);
});

test("several questions in one call: one card each, every answer on resume", async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "go" });
  await flush();
  const q = (question: string) => ({
    botId: "",
    botName: "",
    question,
    kind: "single" as const,
    options: [
      { value: "a", label: "a" },
      { value: "b", label: "b" },
    ],
    allowText: false,
  });
  const r = await h.runtime.last().spec.ask?.([q("One?"), q("Two?")]);
  await flush();
  expect(r?.behavior).toBe("park");
  const [c1, c2] = h.surface.shown.map((s) => s.card.id);
  expect(h.surface.shown.map((s) => s.card.question?.question)).toEqual(["One?", "Two?"]);
  await h.hub.answerCard(c2 ?? "", { choices: ["b"] });
  await flush();
  // One question still open: the run stays parked.
  expect(wakes(h)[0]?.status).toBe("waiting_input");
  await h.hub.answerCard(c1 ?? "", { choices: ["a"] });
  await flush();
  expect(h.runtime.last().sent[0]?.text).toBe(
    'The owner answered your question "One?": a\nThe owner answered your question "Two?": b',
  );
});

test("several questions answered in place come back together", async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "go" });
  await flush();
  const s = h.runtime.last();
  s.emit({ type: "task_started", taskId: "t1", description: "dig" });
  await flush();
  const q = { botId: "", botName: "", kind: "single" as const, options: [], allowText: true };
  const p = s.spec.ask?.([
    { ...q, question: "A?" },
    { ...q, question: "B?" },
  ]);
  await flush();
  const [c1, c2] = h.surface.shown.map((x) => x.card.id);
  await h.hub.answerCard(c2 ?? "", { choices: [], text: "two" });
  await h.hub.answerCard(c1 ?? "", { choices: [], text: "one" });
  expect(await p).toEqual({
    behavior: "answered",
    answers: [
      { choices: [], text: "one" },
      { choices: [], text: "two" },
    ],
  });
});

test("a question withdrawn while a task runs is refused with the withdrawn wording", async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "go" });
  await flush();
  const s = h.runtime.last();
  s.emit({ type: "task_started", taskId: "t1", description: "dig" });
  await flush();
  const q = { botId: "", botName: "", question: "Pick", kind: "single" as const, allowText: false };
  const p = s.spec.ask?.([{ ...q, options: [{ value: "a", label: "a" }] }]);
  await flush();
  h.surface.deliver({ conversationId: "dc", text: "never mind" });
  await flush();
  expect(await p).toEqual({
    behavior: "refused",
    reason: 'Your question "Pick" was withdrawn because the owner wrote something else instead.',
  });
});

const PUSH = {
  name: "Push",
  annotations: { destructiveHint: false, openWorldHint: true },
  scopeKeys: ["repo"],
};

test("always stores the grant: the resumed call and the next same call need no card; audited", async () => {
  const h = makeHub();
  h.catalog.tools.push(PUSH);
  h.editor.tools = ["Push"];
  h.surface.deliver({ conversationId: "dc", text: "push" });
  await flush();
  const d = await h.runtime.last().spec.decide({ tool: "Push", input: { repo: "a" } });
  await flush();
  const id = d.behavior === "park" ? d.cardId : "";
  expect(h.store.cardMap.get(id)?.approval?.offerAlways).toBe(true);
  expect(await h.hub.answerCard(id, "always")).toBe("ok");
  expect(h.store.grantList).toHaveLength(1);
  expect(h.store.grantList[0]).toMatchObject({
    botId: "editor",
    tool: "Push",
    scope: { repo: "a" },
  });
  expect(h.store.auditLog.at(-1)).toMatchObject({ tool: "Push", outcome: "ask", answer: "always" });
  await flush();
  const s = h.runtime.last();
  expect(await s.spec.decide({ tool: "Push", input: { repo: "a" } })).toEqual({
    behavior: "allow",
  });
  expect(await s.spec.decide({ tool: "Push", input: { repo: "a" } })).toEqual({
    behavior: "allow",
  });
  expect(h.store.cardMap.size).toBe(1);
});

test("a forged always on a card without Always allow is refused; the card stays open and once still works", async () => {
  const h = await parked();
  expect(h.store.cardMap.get(h.cardId)?.approval?.offerAlways).toBe(false);
  expect(await h.hub.answerCard(h.cardId, "always")).toBe("bad_answer");
  expect(h.store.cardMap.get(h.cardId)?.status).toBe("open");
  expect(h.store.grantList).toHaveLength(0);
  expect(await h.hub.answerCard(h.cardId, "once")).toBe("ok");
  await flush();
  const s = h.runtime.last();
  expect(s.sent[0]?.text).toBe(APPROVED);
  expect(await s.spec.decide(LS)).toEqual({ behavior: "allow" });
  expect((await s.spec.decide(LS)).behavior).toBe("park");
});
