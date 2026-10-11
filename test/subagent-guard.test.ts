import { expect, test } from "bun:test";
import { checkToolCall, type GuardrailContext, guardFor } from "../src/guardrails/check-tool-call";
import { GIT_MCP_SERVER, GIT_TOOL, mcpToolName } from "../src/mcp/mcp-tool-names";
import { SUBAGENTS } from "../src/roles/subagents/subagent-registry";
import { sdkEnv } from "../src/runtime/sdk-env";
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

const WT = "/ws/repo";
/** Guard of the dev exec stage (explorer, implementer and task-reviewer). */
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
  expect(Object.keys(SUBAGENTS)).toEqual(["explorer", "implementer", "task-reviewer"]);
  expect(exec.allowedSubagents).toEqual(["explorer", "implementer", "task-reviewer"]);
  expect(Object.keys(exec.subagentScopes ?? {})).toEqual([
    "explorer",
    "implementer",
    "task-reviewer",
  ]);
  // plan and qa stay explorer-only
  expect(guardFor("plan", { readPaths: [WT] }).allowedSubagents).toEqual(["explorer"]);
  expect(guardFor("qa", { readPaths: [WT] }).allowedSubagents).toEqual(["explorer"]);
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
  for (const key of ["mode", "isolation", "effort", "team_name", "resume"])
    expect(spawn({ ...ok, [key]: "x" }).decision).toBe("deny");
});

test("the child env always disables background tasks and caps the spawn depth at 1", () => {
  const env = sdkEnv(makeEnv({}).config, { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0" });
  expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
  expect(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe("1");
});
