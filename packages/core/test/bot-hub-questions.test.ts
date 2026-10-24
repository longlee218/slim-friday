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

test.todo("a bot's question reaches the surface with its name and timeout and comes back (restored in Task 8)", async () => {
  const { runtime, surface } = makeHub();
  surface.answerQuestionWith({ choices: ["Blue"] });
  surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  const a = await runtime.nth(0).spec.ask?.(card);
  expect(surface.questions[0]).toMatchObject({
    conversationId: "dc",
    card: { botId: "editor", botName: "Editor", timeoutMs: 600_000 },
  });
  expect(a).toEqual({ choices: ["Blue"] });
});

test.todo("ask between turns resolves null without asking (restored in Task 8)", async () => {
  const { runtime, surface } = makeHub();
  surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(await runtime.nth(0).spec.ask?.(card)).toBeNull();
  expect(surface.questions).toHaveLength(0);
});

test.todo("the approval card names the bot id (restored in Task 8)", async () => {
  const { runtime, surface } = makeHub();
  surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  void runtime.nth(0).spec.decide({ tool: "Bash", input: { command: "ls" } });
  await flush();
  expect(surface.approvals[0]?.card.botId).toBe("editor");
});
