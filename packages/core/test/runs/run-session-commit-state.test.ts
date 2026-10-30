import { expect, test } from "bun:test";
import { type Bot, CORE_DEFAULTS, type Memory, openRunSession } from "../../src";
import { FakeLog } from "../fakes/fake-log";
import { FakeRuntime } from "../fakes/fake-runtime";
import { FakeStore } from "../fakes/fake-store";

const bot = { id: "ann", name: "Ann", title: "", instructions: "", tools: [] } as unknown as Bot;

/** Open Ann's direct session over fakes; `text` is her memory, `log` gets the session's log lines. */
function harness() {
  const store = new FakeStore();
  const runtime = new FakeRuntime();
  const log = new FakeLog();
  let text = "- codeword AMBER";
  const memory: Memory = { read: async () => text, save: async () => {}, edit: async () => {} };
  let saves = 0;
  const stateSet = store.sessions.stateSet;
  store.sessions.stateSet = async (key, hashes) => {
    saves++;
    return stateSet(key, hashes);
  };
  const open = () =>
    openRunSession(
      { runtime, store, memory, limits: CORE_DEFAULTS, log },
      { key: "ann", bot },
      {
        bot,
        runKind: "owner",
        sessionKey: "ann",
        decide: async () => ({ behavior: "deny", reason: "test" }),
      },
    );
  return { log, open, setText: (t: string) => (text = t), saves: () => saves };
}

test("commitState saves the hashes once, however often it is called", async () => {
  const h = harness();
  const o = await h.open();
  await o.commitState();
  await o.commitState();
  expect(h.saves()).toBe(1);
});
