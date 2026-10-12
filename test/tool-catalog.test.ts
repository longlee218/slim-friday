import { expect, test } from "bun:test";
import { guardFor } from "../src/guardrails/check-tool-call";
import { GIT_MCP_SERVER, GIT_TOOL, mcpServerPrefix, mcpToolName } from "../src/mcp/mcp-tool-names";
import { ASSISTANT_ROLE } from "../src/roles/builtin/assistant-role";
import { DEV_ROLE } from "../src/roles/builtin/dev-role";
import * as sdkNames from "../src/tools/sdk-tool-names";
import {
  AGENT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LIST_AGENTS_TOOL_NAME,
  LIST_MCP_RESOURCES_TOOL_NAME,
  LSP_TOOL_NAME,
  MONITOR_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  READ_MCP_RESOURCE_DIR_TOOL_NAME,
  READ_MCP_RESOURCE_TOOL_NAME,
  READ_TOOL_NAME,
  REFRESH_MCP_TOOLS_TOOL_NAME,
  SEND_FEEDBACK_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SKILL_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  WAIT_FOR_MCP_SERVERS_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";
import {
  autoAllowedTools,
  CAPABILITY_TOOLS,
  GIT_GROUPS,
  GIT_READ_BY_MODE,
  gitToolsFor,
  hiddenGitTools,
  SECRET_FILE_RULES,
  toolOptions,
  toolsFor,
} from "../src/tools/tool-catalog";

const ROLES = [ASSISTANT_ROLE, DEV_ROLE];
const qaRole = ASSISTANT_ROLE;
const dev = DEV_ROLE;

test("Q&A: read + web + skills + subagents; nothing that writes or runs commands", () => {
  const t = toolsFor(qaRole);
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
  for (const x of [WRITE_TOOL_NAME, EDIT_TOOL_NAME, BASH_TOOL_NAME, ASK_USER_QUESTION_TOOL_NAME])
    expect(t).not.toContain(x);
});

test("dev gets the full toolset (no plan-mode tools); every role gets Agent and SendMessage", () => {
  for (const role of ROLES)
    expect(toolsFor(role)).toEqual(
      expect.arrayContaining([AGENT_TOOL_NAME, SEND_MESSAGE_TOOL_NAME]),
    );
  expect(toolsFor(dev)).not.toContain("ExitPlanMode");
  expect(toolsFor(dev)).not.toContain("EnterPlanMode");
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
      TOOL_SEARCH_TOOL_NAME,
    ],
  ]) {
    expect(toolsFor(dev)).toContain(x);
  }
  expect(toolsFor(dev)).not.toContain(WEB_FETCH_TOOL_NAME); // web stays the assistant's
});

test("every role gets the subagent tools (Agent, SendMessage, ListAgents) from toolsFor, whatever its capabilities", () => {
  for (const m of ROLES)
    expect(toolsFor(m)).toEqual(expect.arrayContaining([...CAPABILITY_TOOLS.subagents]));
  expect(CAPABILITY_TOOLS.subagents).toEqual([
    AGENT_TOOL_NAME,
    SEND_MESSAGE_TOOL_NAME,
    LIST_AGENTS_TOOL_NAME,
  ]);
  expect(toolsFor(qaRole)).toContain(LSP_TOOL_NAME); // read capability
  expect(CAPABILITY_TOOLS.mcp).toContain(WAIT_FOR_MCP_SERVERS_TOOL_NAME);
  // No PowerShell tool: the prompt carries the OS and the agent picks its shell (owner decision).
  for (const m of ROLES) expect(toolsFor(m)).not.toContain("PowerShell");
});

test("no tool is listed twice", () => {
  for (const m of ROLES) expect(new Set(toolsFor(m)).size).toBe(toolsFor(m).length);
});

test("auto-allowed tools are a subset of the role's tools and never include writes, shell or questions", () => {
  for (const m of ROLES) {
    for (const t of autoAllowedTools(m)) expect(toolsFor(m)).toContain(t);
    for (const t of [
      WRITE_TOOL_NAME,
      EDIT_TOOL_NAME,
      BASH_TOOL_NAME,
      ASK_USER_QUESTION_TOOL_NAME,
      READ_TOOL_NAME,
    ]) {
      expect(autoAllowedTools(m)).not.toContain(t);
    }
  }
  expect(autoAllowedTools(qaRole)).toEqual([
    WEB_SEARCH_TOOL_NAME,
    WEB_FETCH_TOOL_NAME,
    SKILL_TOOL_NAME,
    LIST_MCP_RESOURCES_TOOL_NAME,
    READ_MCP_RESOURCE_TOOL_NAME,
    READ_MCP_RESOURCE_DIR_TOOL_NAME,
    REFRESH_MCP_TOOLS_TOOL_NAME,
    WAIT_FOR_MCP_SERVERS_TOOL_NAME,
    AGENT_TOOL_NAME,
    SEND_MESSAGE_TOOL_NAME,
    LIST_AGENTS_TOOL_NAME,
  ]);
  expect(autoAllowedTools(dev)).toContain(TASK_GET_TOOL_NAME);
  // Owner / guard decide these: never auto-allowed.
  for (const t of [
    TASK_STOP_TOOL_NAME,
    SEND_FEEDBACK_TOOL_NAME,
    MONITOR_TOOL_NAME,
    MULTI_EDIT_TOOL_NAME,
    NOTEBOOK_EDIT_TOOL_NAME,
  ])
    expect(autoAllowedTools(dev)).not.toContain(t);
});

test("git tools: only reads (group read + by-mode reads), hidden = the complement; no role gets add/commit", () => {
  expect(Object.keys(GIT_GROUPS)).toEqual(["read"]);
  for (const t of [...GIT_GROUPS.read, ...Object.keys(GIT_READ_BY_MODE)])
    expect(gitToolsFor(qaRole)).toContain(t);
  expect(gitToolsFor(dev)).toEqual(Object.keys(GIT_READ_BY_MODE)); // dev lists no git groups
  for (const m of ROLES) {
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
  for (const m of ROLES) {
    expect(hiddenGitTools(m)).toContain(mcpToolName(GIT_MCP_SERVER, GIT_TOOL.COMMIT));
    expect(hiddenGitTools(m)).toContain(mcpToolName(GIT_MCP_SERVER, GIT_TOOL.ADD));
  }
});

test("guardFor: one builder per role, auto-allowed tools from the catalog", () => {
  const qa = guardFor(qaRole, { readPaths: ["/r"], gitReadRepos: ["/r"] });
  expect(qa.allowTools).toEqual(autoAllowedTools(qaRole));
  expect(qa.writePaths).toBeUndefined(); // Q&A writes nothing
  const exec = guardFor(dev, {
    writePaths: ["/repo", "/ws/worktrees"],
    readPaths: ["/repo"],
    worktreeDirs: ["/ws/worktrees"],
  });
  expect(exec).toMatchObject({
    writePaths: ["/repo", "/ws/worktrees"],
    worktreeDirs: ["/ws/worktrees"],
  });
  expect(exec.allowTools).toEqual(autoAllowedTools(dev));
});

test("options: tools from the catalog, no allowedTools, strict MCP", () => {
  const o = toolOptions(qaRole) as Record<string, unknown>;
  expect(o.tools).toEqual([
    READ_TOOL_NAME,
    GLOB_TOOL_NAME,
    GREP_TOOL_NAME,
    LSP_TOOL_NAME,
    WEB_SEARCH_TOOL_NAME,
    WEB_FETCH_TOOL_NAME,
    SKILL_TOOL_NAME,
    LIST_MCP_RESOURCES_TOOL_NAME,
    READ_MCP_RESOURCE_TOOL_NAME,
    READ_MCP_RESOURCE_DIR_TOOL_NAME,
    REFRESH_MCP_TOOLS_TOOL_NAME,
    WAIT_FOR_MCP_SERVERS_TOOL_NAME,
    AGENT_TOOL_NAME,
    SEND_MESSAGE_TOOL_NAME,
    LIST_AGENTS_TOOL_NAME,
  ]);
  expect("allowedTools" in o).toBe(false); // would bypass canUseTool
  expect(o.strictMcpConfig).toBe(true);
});

test("disallowedTools only carries what `tools` cannot express: secret-file rules and other roles' git tools", () => {
  for (const role of ROLES) {
    for (const d of toolOptions(role).disallowedTools) {
      expect(SECRET_FILE_RULES.includes(d) || d.startsWith(mcpServerPrefix(GIT_MCP_SERVER))).toBe(
        true,
      );
    }
  }
});

test("secret-file deny rules are part of disallowedTools", () => {
  const d = toolOptions(qaRole).disallowedTools;
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

test("every declared SDK tool name belongs to exactly one capability (a new constant cannot be forgotten)", () => {
  // Names that are not capability tools: the legacy alias of Agent, and EnterWorktree (never offered; the guard only checks it).
  const aliases = new Set<string>([
    sdkNames.LEGACY_AGENT_TOOL_NAME,
    sdkNames.ENTER_WORKTREE_TOOL_NAME,
  ]);
  const owners = new Map<string, number>();
  for (const tools of Object.values(CAPABILITY_TOOLS))
    for (const t of tools) owners.set(t, (owners.get(t) ?? 0) + 1);
  for (const name of Object.values(sdkNames)) {
    if (aliases.has(name)) continue;
    expect([name, owners.get(name)]).toEqual([name, 1]);
  }
  for (const t of owners.keys()) expect(Object.values<string>(sdkNames)).toContain(t);
});

test("the assistant stays read-only: no write, shell, feedback or task tools; dev gets the full set", () => {
  const qa = toolsFor(qaRole);
  for (const t of [
    MULTI_EDIT_TOOL_NAME,
    NOTEBOOK_EDIT_TOOL_NAME,
    MONITOR_TOOL_NAME,
    TASK_GET_TOOL_NAME,
    TASK_STOP_TOOL_NAME,
    SEND_FEEDBACK_TOOL_NAME,
  ])
    expect(qa).not.toContain(t);
  for (const t of [
    MULTI_EDIT_TOOL_NAME,
    NOTEBOOK_EDIT_TOOL_NAME,
    MONITOR_TOOL_NAME,
    TASK_GET_TOOL_NAME,
    TASK_STOP_TOOL_NAME,
    SEND_FEEDBACK_TOOL_NAME,
  ])
    expect(toolsFor(dev)).toContain(t);
});
