import { expect, test } from "bun:test";
import type { BotId } from "../../src";
import { flush, makeHub } from "../bot-hub-harness";

/** A hub whose computer release is recorded (and throws when `fail`). */
function hubWithRelease(fail = false) {
  const released: BotId[] = [];
  const h = makeHub(undefined, {
    computerRelease: async (botId) => {
      released.push(botId);
      if (fail) throw new Error("docker gone");
    },
  });
  return { ...h, released };
}

const onlyRun = (h: ReturnType<typeof makeHub>) => [...h.store.wakeMap.values()][0];

test("a done run releases the bot's computer once", async () => {
  const h = hubWithRelease();
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  expect(h.released).toEqual([]);
  h.runtime.last().emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(onlyRun(h)?.status).toBe("done");
  expect(h.released).toEqual(["editor"]);
});

test("a failed run releases the bot's computer once", async () => {
  const h = hubWithRelease();
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  h.runtime.last().emit({ type: "error", message: "broken", retryable: false });
  await flush();
  expect(onlyRun(h)?.status).toBe("failed");
  expect(h.released).toEqual(["editor"]);
});

test("a throwing release is logged and the run still finishes", async () => {
  const h = hubWithRelease(true);
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  h.runtime.last().emit({ type: "text", text: "ok" });
  h.runtime.last().emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(onlyRun(h)?.status).toBe("done");
  expect(h.surface.posts.at(-1)?.message.text).toBe("ok");
  expect(h.released).toEqual(["editor"]);
  expect(h.log.of("computer.release_failed")[0]?.fields).toMatchObject({
    botId: "editor",
    err: "docker gone",
  });
});

test("the computer facts reach the spec of a bot with a computer", async () => {
  const h = makeHub(undefined, { computerSlotsText: () => "1 slot, limited by memory" });
  h.store.botMap.set("editor", { ...h.editor, computer: "home" });
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  expect(h.runtime.last().spec.computerContext).toContain('named "home"');
  expect(h.runtime.last().spec.computerContext).toContain("1 slot, limited by memory");
});

test("a bot without a computer gets no computer facts", async () => {
  const h = makeHub(undefined, { computerSlotsText: () => "1 slot" });
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  expect(h.runtime.last().spec.computerContext).toBeUndefined();
});
