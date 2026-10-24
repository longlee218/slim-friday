import { expect, test } from "bun:test";
import { flush, makeHub } from "./bot-hub-harness";

test("SetEffort survives into the next run's session", async () => {
  const h = makeHub();
  // The real runtime puts `apply` on the spec's holder at open; the fake does the same with a no-op.
  const open = h.runtime.open.bind(h.runtime);
  h.runtime.open = async (spec) => {
    if (spec.effortControl) spec.effortControl.apply = async () => {};
    return open(spec);
  };
  h.surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  const first = h.runtime.nth(0);
  await first.spec.effortControl?.apply?.("max");
  // The level is on the scope row (the db), not only in this process.
  expect((await h.store.scopes.get("editor"))?.effort).toBe("max");
  first.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  h.surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  expect(h.runtime.created.at(-1)?.spec.bot.effort).toBe("max");
});
