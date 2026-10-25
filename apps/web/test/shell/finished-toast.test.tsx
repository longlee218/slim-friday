import { expect, test } from "vitest";
import { reduceEvent } from "../../src/events/event-reducer";

const finished = {
  type: "run.finished" as const,
  conversationId: "bot:pia",
  botId: "pia",
  preview: "All done.",
};

test("run.finished toasts when another conversation is open", () => {
  const fx = reduceEvent(finished, { activeConversationId: "bot:dev", visible: true, now: 1 });
  expect(fx).toEqual([
    { op: "notify", conversationId: "bot:pia", botId: "pia", title: "pia", text: "All done." },
  ]);
});

test("run.finished toasts when no conversation is open or the tab is hidden", () => {
  expect(reduceEvent(finished, { activeConversationId: null, visible: true, now: 1 })).toHaveLength(
    1,
  );
  expect(
    reduceEvent(finished, { activeConversationId: "bot:pia", visible: false, now: 1 }),
  ).toHaveLength(1);
});

test("run.finished does not toast for the open conversation", () => {
  expect(reduceEvent(finished, { activeConversationId: "bot:pia", visible: true, now: 1 })).toEqual(
    [],
  );
});
