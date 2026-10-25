import { expect, test } from "bun:test";
import { PermissionGate, postStored, TicketBoard } from "../../src";
import { inputHash } from "../../src/permission/input-hash";
import { flush, makeHub } from "../bot-hub-harness";
import { FakeClock } from "../fakes/fake-clock";
import { FakeStore } from "../fakes/fake-store";
import { FakeSurface } from "../fakes/fake-surface";
import { FakeToolCatalog } from "../fakes/fake-tool-catalog";

const SECRET = "s3cr3t-value-12345";
const secretValues = () => [SECRET];

test("postStored stores and posts [redacted] for text and run step labels", async () => {
  const store = new FakeStore();
  const surface = new FakeSurface();
  await postStored(
    { store, surface, secretValues },
    {
      conversationId: "dc",
      author: { kind: "system" },
      text: `token ${SECRET}`,
      at: 1,
      run: [
        {
          id: "t1",
          kind: "command",
          label: "Ran",
          target: `curl -H ${SECRET}`,
          state: "done",
          startedAt: 1,
        },
      ],
    },
  );
  expect(store.msgs[0]?.text).toBe("token [redacted]");
  expect(store.msgs[0]?.run?.[0]?.target).toBe("curl -H [redacted]");
  expect(surface.posts[0]?.message.text).toBe("token [redacted]");
});

test("a bot's text and a shown step never carry the secret", async () => {
  const h = makeHub(undefined, { secretValues });
  h.surface.deliver({ conversationId: "dc", text: "go" });
  await flush();
  const s = h.runtime.nth(0);
  s.emit({
    type: "tool_call",
    toolUseId: "t1",
    tool: "Bash",
    input: { command: `echo ${SECRET}` },
  });
  s.emit({ type: "text", text: `here: ${SECRET}` });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(h.surface.runs.some((r) => r.step.target?.includes(SECRET))).toBe(false);
  expect(h.surface.runs.some((r) => r.step.target?.includes("[redacted]"))).toBe(true);
  expect(h.store.msgs.some((m) => m.text.includes(SECRET))).toBe(false);
  expect(h.store.msgs.some((m) => m.text === "here: [redacted]")).toBe(true);
  expect(JSON.stringify(h.store.msgs)).not.toContain(SECRET);
});

test("an approval card shows the call redacted", async () => {
  const store = new FakeStore();
  const gate = new PermissionGate({
    store,
    surface: new FakeSurface(),
    clock: new FakeClock(0),
    catalog: new FakeToolCatalog([]),
    settings: () => ({ level: "balanced" }),
    secretValues,
  });
  const d = await gate.decide(
    { tool: "Bash", input: { command: `echo ${SECRET}` }, botId: "editor", conversationId: "dc" },
    "Editor",
    { wakeId: "w1", scopeKey: "editor", tainted: false },
  );
  expect(d.behavior).toBe("park");
  const card = [...store.cardMap.values()][0];
  expect(JSON.stringify(card)).not.toContain(SECRET);
  expect(card?.approval?.input).toEqual({ command: "echo [redacted]" });
  // The hash (what the one shot matches) is that of the REAL input, not the redacted one.
  expect(card?.approval?.inputHash).toBe(await inputHash("Bash", { command: `echo ${SECRET}` }));
  expect(card?.approval?.inputHash).not.toBe(
    await inputHash("Bash", { command: "echo [redacted]" }),
  );
  // A secret in the scope is never offered as an "always" grant.
  expect(card?.approval?.offerAlways).toBe(false);
});

test("a ticket comment is stored redacted", async () => {
  const store = new FakeStore();
  store.botMap.set("writer", {
    id: "writer",
    name: "writer",
    title: "",
    instructions: "",
    model: "m",
    tools: [],
    skills: [],
    subagents: [],
    workspaces: [],
  });
  const board = new TicketBoard({
    store,
    clock: new FakeClock(1),
    wake: async () => undefined,
    secretValues,
  });
  const actor = { kind: "bot" as const, botId: "writer" };
  const t = await board.create(actor, { title: "T" });
  if (!t.ok) throw new Error("create failed");
  const c = await board.comment(actor, { id: t.ticket.id, body: `key ${SECRET}` });
  expect(c.ok && c.comment.body).toBe("key [redacted]");
  expect((await store.tickets.comments(t.ticket.id)).at(-1)?.body).toBe("key [redacted]");
});

test("a question card shows the question and options redacted", async () => {
  const h = makeHub(undefined, { secretValues });
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  await h.runtime.nth(0).spec.ask?.([
    {
      botId: "",
      botName: "",
      question: `Use ${SECRET}?`,
      kind: "single",
      options: [{ value: "a", label: `key ${SECRET}`, description: SECRET }],
      allowText: true,
    },
  ]);
  const card = [...h.store.cardMap.values()][0];
  expect(JSON.stringify(card)).not.toContain(SECRET);
  expect(card?.question?.question).toBe("Use [redacted]?");
  expect(card?.question?.options[0]?.label).toBe("key [redacted]");
});

test("a bot-to-bot message is stored redacted (wake, relay line)", async () => {
  const h = makeHub(undefined, { secretValues });
  h.surface.deliver({ conversationId: "gc", text: "go" });
  await flush();
  const r = await h.hub.send("writer@g", {
    to: "editor",
    text: `pw ${SECRET}`,
    intent: "request",
  });
  await flush();
  expect(r.ok).toBe(true);
  expect(JSON.stringify([...h.store.wakeMap.values()])).not.toContain(SECRET);
  expect(h.store.msgs.some((m) => m.kind === "relay" && m.text === "pw [redacted]")).toBe(true);
  expect(JSON.stringify(h.store.msgs)).not.toContain(SECRET);
});
