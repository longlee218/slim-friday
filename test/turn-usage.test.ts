import { expect, test } from "bun:test";
import { createTurnUsage } from "../src/observability/turn-usage";

/** An assistant message with the usage fields the SDK gives. */
const asst = (id: string | undefined, over: Record<string, unknown> = {}, usage?: object) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: {
    id,
    model: "claude-sonnet-5-5",
    usage: usage ?? {
      input_tokens: 10,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 10,
      output_tokens: 16,
    },
  },
  ...over,
});

test("messages sharing a message.id count once; a new id is the next turn with a running total", () => {
  const t = createTurnUsage();
  const first = t.onMessage(asst("m1"));
  expect(first).toEqual({
    turn: 1,
    in: 100,
    cacheRead: 80,
    cacheCreate: 10,
    outApprox: 16,
    ctxTotal: 100,
    model: "claude-sonnet-5-5",
  });
  expect(t.onMessage(asst("m1"))).toBeUndefined(); // parallel tool_use block of the same call
  expect(t.onMessage(asst("m2"))?.turn).toBe(2);
  expect(t.onMessage(asst("m3"))?.ctxTotal).toBe(300);
});

test("non-assistant, no usage, no id: ignored; missing usage fields count as 0", () => {
  const t = createTurnUsage();
  expect(t.onMessage({ type: "user", message: { id: "x", usage: {} } })).toBeUndefined();
  expect(t.onMessage({ type: "assistant", message: { id: "x" } })).toBeUndefined();
  expect(t.onMessage(asst("m1", {}, {}))).toMatchObject({ turn: 1, in: 0, outApprox: 0 });
  expect(t.onMessage(null)).toBeUndefined();
});

test("subagent turn: sub flag from parent_tool_use_id, agentId when present; main turn has neither", () => {
  const t = createTurnUsage();
  const main = t.onMessage(asst("m1"));
  expect(main).not.toHaveProperty("sub");
  expect(main).not.toHaveProperty("agentId");
  const sub = t.onMessage(asst("m2", { parent_tool_use_id: "toolu_1", agent_id: "a1b2" }));
  expect(sub).toMatchObject({ sub: true, agentId: "a1b2" });
});

test("assistant message with usage but no message.id counts as its own turn (no dedupe)", () => {
  const t = createTurnUsage();
  expect(t.onMessage(asst(undefined))?.turn).toBe(1);
  expect(t.onMessage(asst(undefined))?.turn).toBe(2);
});
