import { expect, test } from "bun:test";
import { flush, makeHub } from "../bot-hub-harness";

/** A direct chat with `editor`, whose owner text the test changes in the store; `sendTurn` sends and ends one turn. */
async function setup(preface: string) {
  const h = makeHub();
  h.store.botMap.set("editor", { ...h.editor, ownerPreface: preface });
  const sendTurn = async (text: string) => {
    h.surface.deliver({ conversationId: "dc", text });
    await flush();
    h.runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
    await flush();
  };
  const setOwner = (text: string) =>
    h.store.botMap.set("editor", { ...h.editor, ownerPreface: text });
  return { ...h, sendTurn, setOwner };
}

test("owner text unchanged since open is not sent; a change goes once, replacing the old", async () => {
  const h = await setup("Be warm.");
  await h.sendTurn("one");
  const s = h.runtime.nth(0);
  expect(s.sent[0]?.ownerFiles).toBeUndefined();
  h.setOwner("Be terse.");
  await h.sendTurn("two");
  expect(s.sent[1]?.ownerFiles).toBe("Be terse.");
  await h.sendTurn("three");
  expect(s.sent[2]?.ownerFiles).toBeUndefined();
});

test("both owner files emptied sends (none) once", async () => {
  const h = await setup("Be warm.");
  await h.sendTurn("one");
  h.setOwner("");
  await h.sendTurn("two");
  expect(h.runtime.nth(0).sent[1]?.ownerFiles).toBe("(none)");
  await h.sendTurn("three");
  expect(h.runtime.nth(0).sent[2]?.ownerFiles).toBeUndefined();
});

test("a compaction falls back to the text of the system prompt and sends the current one again", async () => {
  const h = await setup("Be warm.");
  await h.sendTurn("one");
  h.setOwner("Be terse.");
  await h.sendTurn("two");
  h.runtime.nth(0).emit({ type: "compacted" } as never);
  await flush();
  await h.sendTurn("three");
  expect(h.runtime.nth(0).sent[2]?.ownerFiles).toBe("Be terse.");
});

test("a failed send puts the owner text back, so the next turn carries it", async () => {
  const h = await setup("Be warm.");
  await h.sendTurn("one");
  const s = h.runtime.nth(0);
  h.setOwner("Be terse.");
  const send = s.send.bind(s);
  s.send = () => {
    throw new Error("cannot read attachment");
  };
  h.surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  s.send = send;
  await h.sendTurn("three");
  expect(s.sent.at(-1)?.ownerFiles).toBe("Be terse.");
});
