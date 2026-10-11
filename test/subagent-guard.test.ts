import { expect, test } from "bun:test";
import { checkToolCall, type GuardrailContext, guardFor } from "../src/guardrails/check-tool-call";
import { GIT_MCP_SERVER, GIT_TOOL, mcpToolName } from "../src/mcp/mcp-tool-names";
import { captureLogs } from "../src/observability/logger";
import { SUBAGENTS } from "../src/roles/subagents/subagent-registry";
import { sdkEnv } from "../src/runtime/sdk-env";
import { buildToolPermissions } from "../src/runtime/tool-permissions";
import {
  AGENT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  EDIT_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  GLOB_TOOL_NAME,
  LEGACY_AGENT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  READ_TOOL_NAME,
  SKILL_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";
import { makeEnv } from "./helpers";

const SIG = { signal: new AbortController().signal };
const WT = "/ws/repo";
/** Guard of the dev exec stage (explorer is its only subagent today). */
const exec = guardFor("exec", { cwd: WT, writePaths: [WT], readPaths: [WT], gitWriteRepo: WT });
/** Same ctx for a call made by the explorer (hook input `agent_id`/`agent_type`). */
const explorer: GuardrailContext = { ...exec, agent: { id: "a1", type: "explorer" } };
const decide = (tool: string, input: Record<string, unknown>, ctx = explorer) =>
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

test("registry: explorer is data (tools, haiku, 15 turns, read-only scope); the stage lists it", () => {
  const e = SUBAGENTS.explorer;
  expect(e?.tools).toEqual([READ_TOOL_NAME, GLOB_TOOL_NAME, "Grep"]);
  expect(e?.model).toBe("haiku");
  expect(e?.maxTurns).toBe(15);
  expect(e?.scope).toEqual({ readOnly: true, canCommit: false });
  expect(Object.keys(SUBAGENTS)).toEqual(["explorer"]);
  expect(exec.allowedSubagents).toEqual(["explorer"]);
  expect(Object.keys(exec.subagentScopes ?? {})).toEqual(["explorer"]);
});

test("explorer: reads inside the read paths run; reads outside are denied", () => {
  expect(decide(READ_TOOL_NAME, { file_path: `${WT}/a.ts` }).decision).toBe("allow");
  expect(decide(READ_TOOL_NAME, { file_path: "/etc/passwd" }).decision).toBe("deny");
});

test("scope: a read-only subagent never writes, runs a shell or touches git state", () => {
  for (const [tool, input] of [
    [WRITE_TOOL_NAME, { file_path: `${WT}/a.ts`, content: "x" }],
    [EDIT_TOOL_NAME, { file_path: `${WT}/a.ts` }],
    [NOTEBOOK_EDIT_TOOL_NAME, { notebook_path: `${WT}/a.ipynb` }],
    [BASH_TOOL_NAME, { command: "ls" }],
    [BASH_TOOL_NAME, { command: "echo hi > a.txt" }],
    [mcpToolName(GIT_MCP_SERVER, GIT_TOOL.ADD), { path: WT }],
    [mcpToolName(GIT_MCP_SERVER, GIT_TOOL.COMMIT), { path: WT, message: "x" }],
    [mcpToolName(GIT_MCP_SERVER, GIT_TOOL.STATUS), { path: WT }], // not in the explorer's tools
  ] as const)
    expect(decide(tool, input).decision).toBe("deny");
});

test("scope data drives git: canCommit false allows reads only, true allows add in the worktree", () => {
  const readTools = [
    mcpToolName(GIT_MCP_SERVER, GIT_TOOL.STATUS),
    mcpToolName(GIT_MCP_SERVER, GIT_TOOL.ADD),
  ];
  const scoped = (canCommit: boolean): GuardrailContext => ({
    ...exec,
    subagentScopes: { r: { readOnly: true, canCommit, tools: readTools } },
    agent: { id: "r1", type: "r" },
  });
  const status = mcpToolName(GIT_MCP_SERVER, GIT_TOOL.STATUS);
  const add = mcpToolName(GIT_MCP_SERVER, GIT_TOOL.ADD);
  expect(decide(status, { path: WT }, scoped(false)).decision).toBe("allow");
  expect(decide(add, { path: WT }, scoped(false)).decision).toBe("deny");
  expect(decide(add, { path: WT }, scoped(true)).decision).toBe("allow");
});

test("fail closed: unknown type, missing type, a type the stage did not list", () => {
  for (const agent of [{ id: "x", type: "nope" }, { id: "x" }, { id: "x", type: "" }]) {
    const d = decide(READ_TOOL_NAME, { file_path: `${WT}/a.ts` }, { ...exec, agent });
    expect(d.decision).toBe("deny");
  }
  // A ctx with no scope table at all (a stage without subagents): every subagent call is denied.
  const bare: GuardrailContext = { readPaths: [WT], agent: { id: "x", type: "explorer" } };
  expect(decide(READ_TOOL_NAME, { file_path: `${WT}/a.ts` }, bare).decision).toBe("deny");
});

test("R13: a subagent may not start a subagent (Agent or legacy Task)", () => {
  for (const tool of [AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME]) {
    const d = decide(tool, { subagent_type: "explorer", description: "d", prompt: "p" });
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("may not start subagents");
  }
});

test("R12: AskUserQuestion and ExitPlanMode from a subagent are denied, from the main agent they are not", () => {
  for (const tool of [ASK_USER_QUESTION_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME]) {
    expect(decide(tool, {}).decision).toBe("deny");
    expect(decide(tool, {}, exec).decision).toBe("allow"); // main agent: handled by the approval flow
  }
});

test("R1: every guard ask inside a subagent is a deny with the NEEDS_CONTEXT hint", () => {
  const asks: [string, Record<string, unknown>][] = [
    [BASH_TOOL_NAME, { command: "echo $(date)" }],
    [BASH_TOOL_NAME, { command: "make" }],
    ["WeirdTool", {}], // unknown tool: fall-through ask
    [mcpToolName(GIT_MCP_SERVER, GIT_TOOL.CHECKOUT), { path: WT }],
  ];
  for (const [tool, input] of asks) {
    expect(decide(tool, input, { ...exec, agent: undefined }).decision).toBe("ask"); // main agent
    const d = decide(tool, input, worker);
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("NEEDS_CONTEXT");
  }
  // Allow and hard deny stay as they are.
  expect(decide(BASH_TOOL_NAME, { command: "git push origin main" }, worker).decision).toBe("deny");
});

test("R2/R3/R4: spawn from the main agent: stage allowlist, known input keys, no background", () => {
  const spawn = (input: Record<string, unknown>) => decide(AGENT_TOOL_NAME, input, exec);
  const ok = { description: "d", prompt: "p", subagent_type: "explorer" };
  expect(spawn(ok).decision).toBe("allow");
  expect(spawn({ ...ok, run_in_background: false }).decision).toBe("allow"); // seen in the spike fixture
  expect(decide(LEGACY_AGENT_TOOL_NAME, ok, exec).decision).toBe("allow");
  expect(spawn({ ...ok, subagent_type: "general-purpose" }).decision).toBe("deny");
  expect(spawn({ ...ok, subagent_type: undefined }).decision).toBe("deny");
  expect(spawn({ ...ok, run_in_background: true }).decision).toBe("deny");
  for (const key of ["model", "mode", "isolation", "name", "resume"])
    expect(spawn({ ...ok, [key]: "x" }).decision).toBe("deny");
});

test("the child env always disables background tasks and caps the spawn depth at 1", () => {
  const env = sdkEnv(makeEnv({}).config, { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0" });
  expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
  expect(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe("1");
});

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
    { agent_id: "q1", agent_type: "implementer" },
  );
  expect(r.out.hookSpecificOutput.permissionDecision).toBe("deny");
});
