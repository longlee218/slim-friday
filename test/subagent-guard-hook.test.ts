import { expect, test } from "bun:test";
import { checkToolCall, type GuardrailContext, guardFor } from "../src/guardrails/check-tool-call";
import { GIT_MCP_SERVER, GIT_TOOL, mcpToolName } from "../src/mcp/mcp-tool-names";
import { captureLogs } from "../src/observability/logger";
import { buildToolPermissions } from "../src/runtime/tool-permissions";
import {
  AGENT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  READ_TOOL_NAME,
  SKILL_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";

// Guard hook with recorded hook-input shapes: subagent identity, asks as denies, logs, fail-closed identity.

const SIG = { signal: new AbortController().signal };
const WT = "/ws/repo";
const exec = guardFor("exec", { cwd: WT, writePaths: [WT], readPaths: [WT], gitWriteRepo: WT });
const decide = (tool: string, input: Record<string, unknown>, ctx: GuardrailContext) =>
  checkToolCall(tool, input, ctx);
/** A subagent that may use Bash, Skill and an unknown tool: to prove asks become denies. */
const worker: GuardrailContext = {
  ...exec,
  subagentScopes: {
    worker: {
      readOnly: false,
      canCommit: true,
      tools: [
        BASH_TOOL_NAME,
        SKILL_TOOL_NAME,
        "WeirdTool",
        mcpToolName(GIT_MCP_SERVER, GIT_TOOL.CHECKOUT),
      ],
    },
  },
  agent: { id: "w1", type: "worker" },
};

/** Run the guard hook with a real hook-input shape (main agent: no agent fields; subagent: agent_id + agent_type). */
async function hook(guard: GuardrailContext, tool: string, input: object, agent?: object) {
  const perms = buildToolPermissions({
    taskId: "t",
    threadId: "th",
    guard,
    bypassMode: { active: true },
  });
  const cap = captureLogs();
  const out: any = await perms.hooks[0]!.hooks[0]!(
    {
      hook_event_name: "PreToolUse",
      tool_use_id: "u1",
      tool_name: tool,
      tool_input: input,
      ...agent,
    } as never,
    "u1",
    SIG,
  );
  cap.stop();
  return { out, lines: cap.lines, perms };
}
const SUB = { agent_id: "a982bfd6ad035924e", agent_type: "explorer" };

test("hook, bypass: a subagent ask is a hard deny (not run), a main-agent ask still runs", async () => {
  const sub = await hook(
    worker,
    BASH_TOOL_NAME,
    { command: "make" },
    { agent_id: "w1", agent_type: "worker" },
  );
  expect(sub.out.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(sub.perms.decisions.has("u1")).toBe(false);
  const main = await hook(exec, BASH_TOOL_NAME, { command: "make" });
  expect(main.out).toEqual({ continue: true });
  expect(main.perms.decisions.get("u1")?.decision).toBe("bypass");
});

test("hook: AskUserQuestion from a subagent is denied BEFORE the plan-flow early return", async () => {
  const sub = await hook(exec, ASK_USER_QUESTION_TOOL_NAME, { questions: [] }, SUB);
  expect(sub.out.hookSpecificOutput.permissionDecision).toBe("deny");
  const main = await hook(exec, ASK_USER_QUESTION_TOOL_NAME, { questions: [] });
  expect(main.out).toEqual({ continue: true });
});

test("hook: tool.denied carries agentId and agentType; the main agent's line has neither", async () => {
  const sub = await hook(exec, WRITE_TOOL_NAME, { file_path: `${WT}/a.ts`, content: "x" }, SUB);
  const line = sub.lines.find((l) => l.event === "tool.denied");
  expect(line?.agentId).toBe(SUB.agent_id);
  expect(line?.agentType).toBe("explorer");
  const main = await hook(exec, READ_TOOL_NAME, { file_path: "/etc/passwd" });
  const mainLine = main.lines.find((l) => l.event === "tool.denied");
  expect(mainLine).toBeDefined();
  expect(mainLine?.agentId).toBeUndefined();
  expect(mainLine?.agentType).toBeUndefined();
});

test("hook: a subagent with agent_id but no agent_type is denied (fail closed) and logged", async () => {
  const r = await hook(exec, READ_TOOL_NAME, { file_path: `${WT}/a.ts` }, { agent_id: "z9" });
  expect(r.out.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(r.lines.find((l) => l.event === "tool.denied")?.agentId).toBe("z9");
});

test("R4: any run_in_background value other than absent/false is denied", () => {
  const ok = { description: "d", prompt: "p", subagent_type: "explorer" };
  for (const v of [true, "true", 1, "false", null])
    expect(decide(AGENT_TOOL_NAME, { ...ok, run_in_background: v }, exec).decision).toBe("deny");
});

test("a stage with an empty subagents list denies every Agent spawn", () => {
  const none = guardFor("exec", { writePaths: [WT] });
  const bare: GuardrailContext = { ...none, allowedSubagents: [], subagentScopes: {} };
  const input = { description: "d", prompt: "p", subagent_type: "explorer" };
  expect(decide(AGENT_TOOL_NAME, input, bare).decision).toBe("deny");
});

test("hook: empty-string agent_id is a subagent (fail closed); null agent_id is the main agent", async () => {
  const empty = await hook(exec, ASK_USER_QUESTION_TOOL_NAME, {}, { agent_id: "" });
  expect(empty.out.hookSpecificOutput.permissionDecision).toBe("deny");
  const main = await hook(
    exec,
    ASK_USER_QUESTION_TOOL_NAME,
    {},
    { agent_id: null, agent_type: null },
  );
  expect(main.out).toEqual({ continue: true });
});

test("hook: agent_type present but not in the stage's scope table is denied", async () => {
  const r = await hook(
    exec,
    READ_TOOL_NAME,
    { file_path: `${WT}/a.ts` },
    { agent_id: "q1", agent_type: "general-purpose" },
  );
  expect(r.out.hookSpecificOutput.permissionDecision).toBe("deny");
});
