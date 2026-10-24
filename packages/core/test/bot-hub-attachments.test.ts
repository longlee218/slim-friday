import { expect, test } from "bun:test";
import { flush, makeHub } from "./bot-hub-harness";

const file = { name: "1-a.png", mimeType: "image/png", path: "/inbox/gc/1/1-a.png", size: 3 };

test("files from the user reach the turn that answers that message, and no hand-off", async () => {
  const { runtime, surface } = makeHub();
  surface.deliver({ conversationId: "gc", text: "look", attachments: [file] });
  await flush();
  expect(runtime.nth(0).sent[0]?.attachments).toEqual([file]);
  runtime.opened[0]?.emit({ type: "text", text: "@editor please check" });
  await flush();
  const handoff = runtime.opened[1]?.sent[0];
  expect(handoff?.hop).toBe(1);
  expect(handoff?.attachments).toBeUndefined();
});

test("a queued message keeps its own files; a plain message carries none", async () => {
  const { runtime, surface } = makeHub();
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  surface.deliver({ conversationId: "dc", text: "two", attachments: [file] });
  await flush();
  expect(runtime.nth(0).sent).toHaveLength(1);
  expect(runtime.nth(0).sent[0]?.attachments).toBeUndefined();
  runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(runtime.nth(0).sent[1]?.attachments).toEqual([file]);
});
