import { expect, test } from "bun:test";
import type { WakeRow } from "../../src";
import { CORE_DEFAULTS } from "../../src";
import type { HubContext } from "../../src/hub/hub-context";
import { CONTINUATION_KEY, CONTINUATION_PROMPT } from "../../src/runs/run-steering";
import { buildRunTurn } from "../../src/runs/run-turn";
import { FakeClock } from "../fakes/fake-clock";
import { FakeStore } from "../fakes/fake-store";

/** A hub context with only what `buildRunTurn` reads: a store with direct chat "dc", a clock and a zone. */
function ctx(): HubContext {
  const store = new FakeStore();
  store.convMap.set("dc", { id: "dc", kind: "direct", botId: "ann" });
  return {
    deps: { store, clock: new FakeClock(5), timeZone: () => "Europe/Paris" },
    limits: CORE_DEFAULTS,
  } as unknown as HubContext;
}
const row = (over: Partial<WakeRow>): WakeRow =>
  ({
    id: "w1",
    conversationId: "dc",
    targetBot: "ann",
    sender: { kind: "user" },
    intent: "request",
    hop: 0,
    text: "hi",
    scopeKey: "ann",
    ...over,
  }) as WakeRow;

test("a continuation turn comes from the system and is labelled automated", async () => {
  const t = await buildRunTurn(
    ctx(),
    row({ text: CONTINUATION_PROMPT, dedupeKey: `${CONTINUATION_KEY}w0` }),
    { cut: false },
  );
  expect(t.from).toEqual({ kind: "system" });
  expect(t.automated).toBe(true);
  expect(t.now).toBe(5);
  expect(t.timeZone).toBe("Europe/Paris");
});

test("a card resume comes from the system; an owner message keeps its sender", async () => {
  const resumed = await buildRunTurn(ctx(), row({ cardId: "c1" }), { cut: false, resume: "ok" });
  expect(resumed.from).toEqual({ kind: "system" });
  expect(resumed.automated).toBe(true);
  const plain = await buildRunTurn(ctx(), row({}), { cut: false });
  expect(plain.from).toEqual({ kind: "user" });
  expect(plain.automated).toBeUndefined();
});
