import { expect, test } from "bun:test";
import {
  type Bot,
  CORE_DEFAULTS,
  type Memory,
  type MemoryOwner,
  openRunSession,
  type RunSessionDeps,
} from "../../src";
import type { SessionScope } from "../../src/hub/session-scope";
import { FakeLog } from "../fakes/fake-log";
import { FakeRuntime } from "../fakes/fake-runtime";
import { FakeStore } from "../fakes/fake-store";

const bot = {
  id: "ann",
  name: "Ann",
  title: "Helper",
  instructions: "",
  tools: [],
} as unknown as Bot;

/**
 * A memory whose texts the test sets by owner key (`bot:<id>` / `group:<id>`; rules under `rules:<key>`); keys in
 * `fail` throw.
 */
function fakeMemory() {
  const texts = new Map<string, string>();
  const fail = new Set<string>();
  const key = (o: MemoryOwner) => (o.kind === "bot" ? `bot:${o.botId}` : `group:${o.groupId}`);
  const get = async (k: string) => {
    if (fail.has(k)) throw new Error("disk");
    return texts.get(k) ?? "";
  };
  const memory: Memory = {
    read: (o) => get(key(o)),
    readRules: (o) => get(`rules:${key(o)}`),
    save: async () => {},
    edit: async () => {},
  };
  return { memory, texts, fail };
}

/**
 * Deps, a direct and a group scope, an `open` that opens the given scope once, and a `run` that opens it and
 * delivers the turn (commits the state hashes).
 */
function harness() {
  const store = new FakeStore();
  store.groupMap.set("g", {
    id: "g",
    name: "G",
    members: ["ann"],
    entryBot: "ann",
    workspaces: [],
    instructions: "",
  });
  const runtime = new FakeRuntime();
  const log = new FakeLog();
  const mem = fakeMemory();
  const d: RunSessionDeps = { runtime, store, memory: mem.memory, limits: CORE_DEFAULTS, log };
  const direct: SessionScope = { key: "ann", bot };
  const group: SessionScope = { key: "ann@g", groupId: "g", bot };
  const open = (scope: SessionScope, resumesCard = false) =>
    openRunSession(
      d,
      scope,
      {
        bot,
        runKind: "owner",
        sessionKey: scope.key,
        ...(scope.groupId && { groupId: scope.groupId }),
        decide: async () => ({ behavior: "deny", reason: "test" }),
      },
      resumesCard,
    );
  const run = async (scope: SessionScope, resumesCard = false) => {
    const o = await open(scope, resumesCard);
    await o.commitState();
    return o;
  };
  return { store, runtime, log, ...mem, direct, group, open, run };
}

test("a fresh session sends no state block and stores its hashes once its turn is delivered", async () => {
  const h = harness();
  h.texts.set("bot:ann", "- codeword AMBER");
  const o = await h.open(h.direct);
  expect(o.stateChanged).toBeUndefined();
  expect(h.runtime.opened).toHaveLength(1);
  expect(await h.store.sessions.stateGet("ann")).toBeUndefined();
  await o.commitState();
  expect((await h.store.sessions.stateGet("ann"))?.memory).toMatch(/^[0-9a-f]{16}$/);
});

test("a resumed session with edited memory gets the new note in stateChanged", async () => {
  const h = harness();
  h.texts.set("bot:ann", "- codeword AMBER");
  await h.run(h.direct);
  h.texts.set("bot:ann", "- codeword COBALT");
  const o = await h.run(h.direct);
  expect(h.runtime.resumed).toHaveLength(1);
  expect(o.stateChanged).toContain("<state_changed>");
  expect(o.stateChanged).toContain("- codeword COBALT");
  expect(o.stateChanged).not.toContain("AMBER");
  expect(h.log.of("session.state_changed")).toEqual([
    {
      level: "info",
      fields: { scope: "ann", parts: ["memory"], chars: o.stateChanged?.length },
      msg: "session.state_changed",
    },
  ]);
  // The new hash is stored: the next open with the same memory sends nothing.
  expect((await h.run(h.direct)).stateChanged).toBeUndefined();
});

test("a resumed session with nothing changed gets none", async () => {
  const h = harness();
  h.texts.set("bot:ann", "- likes tea");
  await h.run(h.direct);
  const o = await h.run(h.direct);
  expect(h.runtime.resumed).toHaveLength(1);
  expect(o.stateChanged).toBeUndefined();
});

test("a card resume also gets changed state", async () => {
  const h = harness();
  h.texts.set("bot:ann", "- old");
  await h.run(h.direct);
  h.texts.set("bot:ann", "- new");
  const o = await h.run(h.direct, true);
  expect(h.runtime.resumed).toHaveLength(1);
  expect(o.stateChanged).toContain("- new");
});

test("a failed memory read sends no memory change and keeps the old hash", async () => {
  const h = harness();
  h.texts.set("bot:ann", "- likes tea");
  await h.run(h.direct);
  const seen = await h.store.sessions.stateGet("ann");
  h.fail.add("bot:ann");
  const o = await h.run(h.direct);
  expect(o.stateChanged).toBeUndefined();
  expect((await h.store.sessions.stateGet("ann"))?.memory).toBe(seen?.memory as string);
  h.fail.delete("bot:ann");
  expect((await h.run(h.direct)).stateChanged).toBeUndefined();
});

test("a group session reports group memory changes and never the bot's facts", async () => {
  const h = harness();
  h.texts.set("group:g", "- team uses bun");
  await h.run(h.group);
  h.texts.set("group:g", "- team uses deno");
  h.texts.set("bot:ann", "- (fact) private codeword");
  const o = await h.run(h.group);
  expect(h.runtime.resumed).toHaveLength(1);
  expect(o.stateChanged).toContain("## Group memory");
  expect(o.stateChanged).toContain("- team uses deno");
  expect(o.stateChanged).not.toContain("private codeword");
});

test("a turn that was never delivered keeps the old hashes: the next open sends the block again", async () => {
  const h = harness();
  h.texts.set("bot:ann", "- codeword AMBER");
  await h.run(h.direct);
  h.texts.set("bot:ann", "- codeword COBALT");
  // The run stopped (or the turn failed to build) before the turn reached the session: no commit.
  expect((await h.open(h.direct)).stateChanged).toContain("- codeword COBALT");
  expect((await h.run(h.direct)).stateChanged).toContain("- codeword COBALT");
  expect((await h.run(h.direct)).stateChanged).toBeUndefined();
});

test("rules the owner cleared are reported as now empty", async () => {
  const h = harness();
  h.texts.set("rules:bot:ann", "- Be brief.");
  await h.run(h.direct);
  h.texts.delete("rules:bot:ann");
  const o = await h.run(h.direct);
  expect(o.stateChanged).toContain("## Your rules");
  expect(o.stateChanged).toContain("(now empty)");
});

test("a failed rules or group rules read is not reported and keeps the old hash", async () => {
  const h = harness();
  h.texts.set("rules:bot:ann", "- Be brief.");
  h.texts.set("rules:group:g", "- Team rule.");
  await h.run(h.group);
  h.fail.add("rules:bot:ann");
  h.fail.add("rules:group:g");
  expect((await h.run(h.group)).stateChanged).toBeUndefined();
  h.fail.clear();
  expect((await h.run(h.group)).stateChanged).toBeUndefined();
});
