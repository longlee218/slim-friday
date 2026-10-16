import { expect, test } from "bun:test";
import type { Logger } from "pino";
import { guardFor } from "../src/policy/check-tool-call";
import { newSubagentLimit } from "../src/policy/subagent-limit";
import { getRole } from "../src/roles/role-registry";
import { guardHook, subagentPostHooks } from "../src/runtime/guard-hook";
import { AGENT_TOOL_NAME } from "../src/tools/sdk-tool-names";

// Generic parallel cap on subagents: no type, name or total count is involved.
const log = { warn() {}, info() {}, error() {}, debug() {} } as unknown as Logger;

function setup() {
  const limit = newSubagentLimit();
  const hook = guardHook(
    { turnId: "t", threadId: "th", guard: guardFor(getRole("developer"), {}) },
    new Map(),
    log,
    limit,
  );
  const post = subagentPostHooks(limit);
  const pre = async (id: string) =>
    (await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: AGENT_TOOL_NAME,
        tool_input: { prompt: "p" },
        tool_use_id: id,
      } as never,
      "id",
      { signal: new AbortController().signal },
    )) as {
      continue?: boolean;
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
  const finish = async (event: "PostToolUse" | "PostToolUseFailure", id: string) =>
    post[event]?.[0]?.hooks[0]?.(
      { hook_event_name: event, tool_name: AGENT_TOOL_NAME, tool_use_id: id } as never,
      id,
      { signal: new AbortController().signal },
    );
  return { pre, finish };
}

test("the 51st concurrent subagent is denied; a finished or failed one frees its slot", async () => {
  const { pre, finish } = setup();
  for (let n = 0; n < 50; n++) expect((await pre(`a${n}`)).continue).toBe(true);
  const over = await pre("a50");
  expect(over.hookSpecificOutput?.permissionDecision).toBe("deny");
  expect(over.hookSpecificOutput?.permissionDecisionReason).toContain("at most 50 subagents");
  await finish("PostToolUse", "a0");
  expect((await pre("b1")).continue).toBe(true);
  expect((await pre("b2")).hookSpecificOutput?.permissionDecision).toBe("deny");
  await finish("PostToolUseFailure", "a1");
  expect((await pre("b3")).continue).toBe(true);
});
