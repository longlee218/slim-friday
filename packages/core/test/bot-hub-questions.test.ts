import { expect, test } from "bun:test";
import { flush, makeHub } from "./bot-hub-harness";

const card = {
  botId: "",
  botName: "",
  question: "Color?",
  kind: "single" as const,
  options: [],
  allowText: true,
};

test("a bot's question becomes a stored card with its name; with no task open the run parks", async () => {
  const { runtime, surface, store } = makeHub();
  surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  const a = await runtime.nth(0).spec.ask?.([card]);
  const shown = surface.shown[0];
  expect(shown?.botName).toBe("Editor");
  expect(shown?.card).toMatchObject({
    kind: "question",
    conversationId: "dc",
    question: { botId: "editor", botName: "Editor", question: "Color?" },
  });
  expect(a).toEqual({ behavior: "park", cardId: shown?.card.id ?? "" });
  await flush();
  expect([...store.wakeMap.values()][0]).toMatchObject({
    status: "waiting_input",
    cardId: shown?.card.id,
  });
});

test("ask between turns is refused without asking", async () => {
  const { runtime, surface } = makeHub();
  surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect((await runtime.nth(0).spec.ask?.([card]))?.behavior).toBe("refused");
  expect(surface.shown).toHaveLength(0);
});

test("the approval card names the bot id", async () => {
  const { runtime, surface } = makeHub();
  surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  void runtime.nth(0).spec.decide({ tool: "Bash", input: { command: "ls" } });
  await flush();
  expect(surface.shown[0]?.card.botId).toBe("editor");
});
