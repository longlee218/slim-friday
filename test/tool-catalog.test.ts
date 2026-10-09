import { expect, test } from "bun:test";
import { guardFor } from "../src/guardrails/check-tool-call";
import { GIT_MCP_SERVER, GIT_TOOL, mcpServerPrefix, mcpToolName } from "../src/mcp/mcp-tool-names";
import type { StageName as ToolMode } from "../src/roles/role-registry";
import { DELEGATE_TASK_MCP_TOOL_NAME } from "../src/tools/DelegateTaskTool/constants";
import {
  AGENT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  EDIT_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_TOOL_NAME,
  SKILL_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";
import {
  autoAllowedTools,
  GIT_GROUPS,
  GIT_READ_BY_MODE,
  gitToolsFor,
  hiddenGitTools,
  SECRET_FILE_RULES,
  SUBAGENTS,
  toolOptions,
  toolsFor,
} from "../src/tools/tool-catalog";

const MODES: ToolMode[] = ["qa", "plan", "exec"];

test("Q&A: read + web + skills + subagents; nothing that writes or runs commands", () => {
  const t = toolsFor("qa");
  for (const x of [
    READ_TOOL_NAME,
    GLOB_TOOL_NAME,
    GREP_TOOL_NAME,
    WEB_SEARCH_TOOL_NAME,
    WEB_FETCH_TOOL_NAME,
    SKILL_TOOL_NAME,
    AGENT_TOOL_NAME,
  ])
    expect(t).toContain(x);
  for (const x of [
    WRITE_TOOL_NAME,
    EDIT_TOOL_NAME,
    BASH_TOOL_NAME,
    ASK_USER_QUESTION_TOOL_NAME,
    EXIT_PLAN_MODE_TOOL_NAME,
  ])
    expect(t).not.toContain(x);
});

test("code tasks: plan and exec share one full toolset", () => {
  expect(toolsFor("plan")).toEqual(toolsFor("exec"));
  for (const x of [
    ...[
      READ_TOOL_NAME,
      GLOB_TOOL_NAME,
      GREP_TOOL_NAME,
      WRITE_TOOL_NAME,
      EDIT_TOOL_NAME,
      BASH_TOOL_NAME,
      SKILL_TOOL_NAME,
      AGENT_TOOL_NAME,
      ASK_USER_QUESTION_TOOL_NAME,
    ],
    ...[
      TODO_WRITE_TOOL_NAME,
      TASK_CREATE_TOOL_NAME,
      TASK_UPDATE_TOOL_NAME,
      TASK_LIST_TOOL_NAME,
      EXIT_PLAN_MODE_TOOL_NAME,
      ENTER_PLAN_MODE_TOOL_NAME,
      TOOL_SEARCH_TOOL_NAME,
    ],
  ]) {
    expect(toolsFor("exec")).toContain(x);
  }
  expect(toolsFor("exec")).not.toContain(WEB_FETCH_TOOL_NAME); // web stays Q&A-only
});

test("no tool is listed twice", () => {
  for (const m of MODES) expect(new Set(toolsFor(m)).size).toBe(toolsFor(m).length);
});

test("auto-allowed tools are a subset of the mode's tools and never include writes, shell or questions", () => {
  for (const m of MODES) {
    // `DelegateTask` is an MCP tool (not in the built-in `tools` list) allowed in qa only.
    for (const t of autoAllowedTools(m).filter((x) => x !== DELEGATE_TASK_MCP_TOOL_NAME))
      expect(toolsFor(m)).toContain(t);
    for (const t of [
      WRITE_TOOL_NAME,
      EDIT_TOOL_NAME,
      BASH_TOOL_NAME,
      ASK_USER_QUESTION_TOOL_NAME,
      EXIT_PLAN_MODE_TOOL_NAME,
      AGENT_TOOL_NAME,
      READ_TOOL_NAME,
    ]) {
      expect(autoAllowedTools(m)).not.toContain(t);
    }
  }
  expect(autoAllowedTools("qa")).toEqual([
    WEB_SEARCH_TOOL_NAME,
    WEB_FETCH_TOOL_NAME,
    SKILL_TOOL_NAME,
    DELEGATE_TASK_MCP_TOOL_NAME,
  ]);
  expect(autoAllowedTools("plan")).not.toContain(DELEGATE_TASK_MCP_TOOL_NAME);
  expect(autoAllowedTools("exec")).not.toContain(DELEGATE_TASK_MCP_TOOL_NAME);
  expect(autoAllowedTools("exec")).toContain(ENTER_PLAN_MODE_TOOL_NAME);
});

test("DelegateTask is auto-allowed in qa only when the run registers it", () => {
  expect(autoAllowedTools("qa", { delegate: false })).not.toContain(DELEGATE_TASK_MCP_TOOL_NAME);
  expect(autoAllowedTools("qa", { delegate: true })).toContain(DELEGATE_TASK_MCP_TOOL_NAME);
  expect(autoAllowedTools("exec", { delegate: true })).not.toContain(DELEGATE_TASK_MCP_TOOL_NAME);
});

test("git tools: reads everywhere, commit/change only in exec, hidden = the complement", () => {
  expect(gitToolsFor("qa")).toEqual(gitToolsFor("plan"));
  for (const t of [...GIT_GROUPS.read, ...Object.keys(GIT_READ_BY_MODE)])
    expect(gitToolsFor("qa")).toContain(t);
  for (const t of [...GIT_GROUPS.commit, ...GIT_GROUPS.change]) {
    expect(gitToolsFor("qa")).not.toContain(t);
    expect(gitToolsFor("exec")).toContain(t);
  }
  for (const m of MODES) {
    const hidden = hiddenGitTools(m);
    for (const t of gitToolsFor(m)) expect(hidden).not.toContain(mcpToolName(GIT_MCP_SERVER, t));
    for (const t of [
      GIT_TOOL.PUSH,
      GIT_TOOL.PULL,
      GIT_TOOL.FETCH,
      GIT_TOOL.WORKTREE,
      GIT_TOOL.CLONE,
      GIT_TOOL.CLEAN,
      GIT_TOOL.MERGE,
      GIT_TOOL.REBASE,
    ]) {
      expect(hidden).toContain(mcpToolName(GIT_MCP_SERVER, t)); // the app's tools: never offered to agents
    }
  }
  expect(hiddenGitTools("qa")).toContain(mcpToolName(GIT_MCP_SERVER, GIT_TOOL.COMMIT));
  expect(hiddenGitTools("exec")).not.toContain(mcpToolName(GIT_MCP_SERVER, GIT_TOOL.COMMIT));
});

test("guardFor: one builder per mode, auto-allowed tools and subagents from the catalog", () => {
  const qa = guardFor("qa", { readPaths: ["/r"], gitReadRepos: ["/r"] });
  expect(qa.allowTools).toEqual(autoAllowedTools("qa"));
  expect(qa.allowedSubagents).toEqual(Object.keys(SUBAGENTS));
  expect(qa.writePaths).toBeUndefined(); // Q&A writes nothing
  expect(qa.gitWriteRepo).toBeUndefined();
  const exec = guardFor("exec", {
    writePaths: ["/wt"],
    readPaths: ["/wt"],
    gitWriteRepo: "/wt",
    allowedCommands: ["bun test"],
  });
  expect(exec).toMatchObject({
    writePaths: ["/wt"],
    gitWriteRepo: "/wt",
    allowedCommands: ["bun test"],
  });
  expect(exec.allowTools).toEqual(autoAllowedTools("exec"));
});

test("options: tools from the catalog, no allowedTools, strict MCP", () => {
  const o = toolOptions("qa") as Record<string, unknown>;
  expect(o.tools).toEqual([
    READ_TOOL_NAME,
    GLOB_TOOL_NAME,
    GREP_TOOL_NAME,
    WEB_SEARCH_TOOL_NAME,
    WEB_FETCH_TOOL_NAME,
    SKILL_TOOL_NAME,
    AGENT_TOOL_NAME,
  ]);
  expect("allowedTools" in o).toBe(false); // would bypass canUseTool
  expect(o.strictMcpConfig).toBe(true);
});

test("disallowedTools only carries what `tools` cannot express: secret-file rules and other modes' git tools", () => {
  for (const mode of ["qa", "plan", "exec"] as const) {
    for (const d of toolOptions(mode).disallowedTools) {
      expect(SECRET_FILE_RULES.includes(d) || d.startsWith(mcpServerPrefix(GIT_MCP_SERVER))).toBe(
        true,
      );
    }
  }
});

test("secret-file deny rules are part of disallowedTools", () => {
  const d = toolOptions("qa").disallowedTools;
  for (const r of [
    `${READ_TOOL_NAME}(**/.env*)`,
    `${READ_TOOL_NAME}(**/*.pem)`,
    `${READ_TOOL_NAME}(**/*.key)`,
    `${READ_TOOL_NAME}(**/id_rsa*)`,
    `${READ_TOOL_NAME}(**/credentials*)`,
  ]) {
    expect(SECRET_FILE_RULES).toContain(r);
    expect(d).toContain(r);
  }
});
