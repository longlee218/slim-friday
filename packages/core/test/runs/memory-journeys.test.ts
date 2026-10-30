import { expect, test } from "bun:test";
import {
  type Bot,
  CORE_DEFAULTS,
  GROUP_SESSION_KINDS,
  type Memory,
  type MemoryOwner,
  openRunSession,
  type WakeRow,
} from "../../src";
import type { HubContext } from "../../src/hub/hub-context";
import type { SessionScope } from "../../src/hub/session-scope";
import { buildRunTurn } from "../../src/runs/run-turn";
import { FakeClock } from "../fakes/fake-clock";
import { FakeRuntime, type FakeSession } from "../fakes/fake-runtime";
import { FakeStore } from "../fakes/fake-store";
import { expectTurnShows } from "./journey-grader";

const bot = { id: "ann", name: "Ann", title: "", instructions: "", tools: [] } as unknown as Bot;

/** A memory of typed notes per owner key (`bot:<id>` / `group:<id>`) and rules text per key; `readForPrompt` filters by kind. */
function journeyMemory() {
  const notes = new Map<string, { kind: string; text: string }[]>();
  const rules = new Map<string, string>();
  const key = (o: MemoryOwner) => (o.kind === "bot" ? `bot:${o.botId}` : `group:${o.groupId}`);
  const lines = (o: MemoryOwner, kinds?: readonly string[]) =>
    (notes.get(key(o)) ?? [])
      .filter((n) => !kinds || kinds.includes(n.kind))
      .map((n) => `- ${n.text}`)
      .join("\n");
  const memory: Memory = {
    read: async (o) => lines(o),
    readForPrompt: async (o, _max, kinds) => {
      const text = lines(o, kinds);
      return { text, hidden: 0, chars: text.length };
    },
    readRules: async (o) => rules.get(key(o)) ?? "",
    save: async () => {},
    edit: async () => {},
  };
  return { memory, notes, rules };
}

/** Real `openRunSession` + `buildRunTurn` over fakes; `run` opens a session, sends the turn and commits state like the run executor. */
function journey() {
  const store = new FakeStore();
  store.groupMap.set("g", {
    id: "g",
    name: "G",
    members: ["ann"],
    entryBot: "ann",
    workspaces: [],
    instructions: "",
  });
  store.convMap.set("dc", { id: "dc", kind: "direct", botId: "ann" });
  const runtime = new FakeRuntime();
  const mem = journeyMemory();
  const ctx = {
    deps: { store, clock: new FakeClock(5), timeZone: () => "UTC" },
    limits: CORE_DEFAULTS,
  } as unknown as HubContext;
  const direct: SessionScope = { key: "ann", bot };
  const group: SessionScope = { key: "ann@g", groupId: "g", bot };
  const run = async (scope: SessionScope) => {
    const o = await openRunSession(
      { runtime, store, memory: mem.memory, limits: CORE_DEFAULTS },
      scope,
      {
        bot,
        runKind: "owner",
        sessionKey: scope.key,
        ...(scope.groupId && { groupId: scope.groupId }),
        decide: async () => ({ behavior: "deny", reason: "test" }),
      },
    );
    const row = {
      id: "w",
      conversationId: "dc",
      targetBot: "ann",
      sender: { kind: "user" },
      intent: "request",
      hop: 0,
      text: "hi",
      scopeKey: scope.key,
    } as unknown as WakeRow;
    const turn = await buildRunTurn(ctx, row, {
      cut: false,
      ...(o.stateChanged && { stateChanged: o.stateChanged }),
    });
    (o.session as FakeSession).send(turn);
    await o.commitState();
    const spec = (o.session as FakeSession).spec;
    const prompt = [spec.rules, spec.memory, spec.groupRules, spec.groupMemory].join("\n");
    return { turn, prompt };
  };
  return { runtime, ...mem, direct, group, run };
}

test("remember then resume: the new note reaches the next turn", async () => {
  const j = journey();
  await j.run(j.direct);
  j.notes.set("bot:ann", [{ kind: "fact", text: "codeword COBALT" }]);
  const { turn, prompt } = await j.run(j.direct);
  expect(j.runtime.resumed).toHaveLength(1);
  expectTurnShows(turn, prompt, "codeword COBALT");
  // Once delivered, the next resume does not repeat it.
  expect((await j.run(j.direct)).turn.stateChanged).toBeUndefined();
});

test("supersede: an edited preference shows only the new text", async () => {
  const j = journey();
  j.notes.set("bot:ann", [{ kind: "preference", text: "answer in French" }]);
  await j.run(j.direct);
  j.notes.set("bot:ann", [{ kind: "preference", text: "answer in German" }]);
  const { turn, prompt } = await j.run(j.direct);
  expectTurnShows(turn, prompt, "answer in German");
  expect(turn.stateChanged).not.toContain("French");
});

test("isolation: a group session never shows the bot's facts", async () => {
  const j = journey();
  await j.run(j.group);
  j.notes.set("bot:ann", [
    { kind: "fact", text: "private codeword" },
    { kind: "decision", text: "private decision" },
    { kind: "preference", text: "be brief" },
    { kind: "lesson", text: "check twice" },
  ]);
  expect(GROUP_SESSION_KINDS).toEqual(["preference", "lesson"]);
  const { turn, prompt } = await j.run(j.group);
  expect(j.runtime.resumed).toHaveLength(1);
  expectTurnShows(turn, prompt, "be brief");
  expectTurnShows(turn, prompt, "check twice");
  const seen = `${prompt}\n${turn.stateChanged ?? ""}`;
  expect(seen).not.toContain("private codeword");
  expect(seen).not.toContain("private decision");
});

test("rules edit reaches a resumed session", async () => {
  const j = journey();
  j.rules.set("bot:ann", "- Be brief.");
  await j.run(j.direct);
  j.rules.set("bot:ann", "- Always cite sources.");
  const { turn, prompt } = await j.run(j.direct);
  expect(j.runtime.resumed).toHaveLength(1);
  expectTurnShows(turn, prompt, "Always cite sources.");
  expect(turn.stateChanged).not.toContain("Be brief.");
});

test("the grader fails when the note is missing", async () => {
  const j = journey();
  await j.run(j.direct);
  const { turn, prompt } = await j.run(j.direct);
  expect(turn.stateChanged).toBeUndefined();
  expect(() => expectTurnShows(turn, prompt, "codeword COBALT")).toThrow();
});
