import { expect, test } from "bun:test";
import { makeHub } from "../bot-hub-harness";

test("queueIntroRun stores one intro run in the bot's direct chat; a second call adds none", async () => {
  const h = makeHub();
  await h.hub.queueIntroRun("editor");
  await h.hub.queueIntroRun("editor");
  const rows = [...h.store.wakeMap.values()];
  expect(rows).toHaveLength(1);
  const [r] = rows;
  expect(r?.intro).toBe(true);
  expect(r?.sender).toEqual({ kind: "system" });
  expect(r?.conversationId).toBe("dc");
  expect(r?.targetBot).toBe("editor");
  expect(r?.dedupeKey).toBe("intro:editor");
  expect(r?.text).toContain("Call AskUserQuestion right away, with no text before it");
  expect(r?.text).toContain("UpdateProfile");
});

test("a bot with no direct conversation gets no intro run and nothing throws", async () => {
  const h = makeHub();
  await h.hub.queueIntroRun("writer");
  expect(h.store.wakeMap.size).toBe(0);
});
