import { expect, test } from "bun:test";
import { flush, makeHub } from "./bot-hub-harness";

const file = { name: "1-a.png", mimeType: "image/png", path: "/inbox/gc/1/1-a.png", size: 3 };

test("files from the user reach the turn that answers that message, and no hand-off", async () => {
  const { runtime, surface, hub } = makeHub();
  surface.deliver({ conversationId: "gc", text: "look", attachments: [file] });
  await flush();
  expect(runtime.nth(0).sent[0]?.attachments).toEqual([file]);
  await hub.send("writer@g", { to: "editor", text: "please check", intent: "request" });
  await flush();
  const handoff = runtime.opened[1]?.sent[0];
  expect(handoff?.hop).toBe(1);
  expect(handoff?.attachments).toBeUndefined();
});

test("a message to a busy run keeps its own files as steering; a plain message carries none", async () => {
  const { runtime, surface, store } = makeHub();
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  surface.deliver({ conversationId: "dc", text: "two", attachments: [file] });
  await flush();
  expect(runtime.nth(0).sent).toHaveLength(1);
  expect(runtime.nth(0).sent[0]?.attachments).toBeUndefined();
  // Steering into the busy run (Task 9 delivers it with its files).
  expect([...store.steerMap.values()][0]).toMatchObject({ text: "two", attachments: [file] });
});
