import { expect, test } from "bun:test";
import { guardFor } from "../src/guardrails/check-tool-call";
import { DEVELOPER_ROLE } from "../src/roles/builtin/developer-role";
import { LEAD_ROLE } from "../src/roles/builtin/lead-role";
import { SCOUT_ROLE } from "../src/roles/builtin/scout-role";
import * as sdkNames from "../src/tools/sdk-tool-names";
import {
  AGENT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LIST_AGENTS_TOOL_NAME,
  LSP_TOOL_NAME,
  MONITOR_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  READ_TOOL_NAME,
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
  appMcpToolsFor,
  autoAllowedTools,
  CAPABILITY_TOOLS,
  SECRET_FILE_RULES,
  toolOptions,
  toolsFor,
} from "../src/tools/tool-catalog";

const ROLES = [LEAD_ROLE, SCOUT_ROLE, DEVELOPER_ROLE];
/** The read-only worker: read + web + skills, no shell. */
const qaRole = SCOUT_ROLE;
const dev = DEVELOPER_ROLE;

test("scout: read + web + skills; nothing that writes or runs commands; depth 1 (no subagents)", () => {
  const t = toolsFor(qaRole);
  for (const x of [
    READ_TOOL_NAME,
    GLOB_TOOL_NAME,
    GREP_TOOL_NAME,
    WEB_SEARCH_TOOL_NAME,
    WEB_FETCH_TOOL_NAME,
    SKILL_TOOL_NAME,
  ])
    expect(t).toContain(x);
  for (const x of [WRITE_TOOL_NAME, EDIT_TOOL_NAME, ASK_USER_QUESTION_TOOL_NAME])
    expect(t).not.toContain(x);
  expect(t).not.toContain(AGENT_TOOL_NAME);
  // The scout has a read-only shell (role data `shellMode: read`, allowlist in the guard).
  for (const x of [BASH_TOOL_NAME, MONITOR_TOOL_NAME]) expect(t).toContain(x);
});

test("dev gets the full toolset (no plan-mode tools); a role without `noSubagents` gets Agent and SendMessage", () => {
  expect(toolsFor(dev)).toEqual(expect.arrayContaining([AGENT_TOOL_NAME, SEND_MESSAGE_TOOL_NAME]));
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
  expect(toolsFor(dev)).not.toContain(WEB_FETCH_TOOL_NAME); // web stays the scout's
});

test("every role without `noSubagents` gets the subagent tools (Agent, SendMessage, ListAgents) from toolsFor, whatever its capabilities", () => {
  for (const m of ROLES.filter((r) => !r.noSubagents))
    expect(toolsFor(m)).toEqual(expect.arrayContaining([...CAPABILITY_TOOLS.subagents]));
  for (const m of ROLES.filter((r) => r.noSubagents))
    for (const t of CAPABILITY_TOOLS.subagents) expect(toolsFor(m)).not.toContain(t);
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

test("guardFor: one builder per role, auto-allowed tools from the catalog", () => {
  const qa = guardFor(qaRole, { readPaths: ["/r"] });
  // the scout lists the worker server (its ReportResult tool): allowed next to the auto tools
  expect(qa.allowTools).toEqual([...autoAllowedTools(qaRole), ...appMcpToolsFor(qaRole)]);
  expect(qa.writePaths).toBeUndefined(); // a read-only role writes nothing
  const exec = guardFor(dev, {
    writePaths: ["/location", "/ws/worktrees"],
    readPaths: ["/location"],
    worktreeDirs: ["/ws/worktrees"],
  });
  expect(exec).toMatchObject({
    writePaths: ["/location", "/ws/worktrees"],
    worktreeDirs: ["/ws/worktrees"],
  });
  // dev lists the worker server in its data (its ReportResult tool): allowed next to the auto tools
  expect(exec.allowTools).toEqual([...autoAllowedTools(dev), ...appMcpToolsFor(dev)]);
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
    BASH_TOOL_NAME, // read-only shell of the scout (role data `shellMode`)
    MONITOR_TOOL_NAME,
    SKILL_TOOL_NAME,
  ]);
  expect("allowedTools" in o).toBe(false); // would bypass canUseTool
  expect(o.strictMcpConfig).toBe(true);
});

test("disallowedTools only carries what `tools` cannot express: the secret-file rules", () => {
  for (const role of ROLES) expect(toolOptions(role).disallowedTools).toEqual(SECRET_FILE_RULES);
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
  // Names that are not capability tools: EnterWorktree (never offered; the guard only checks it).
  const aliases = new Set<string>([sdkNames.ENTER_WORKTREE_TOOL_NAME]);
  const owners = new Map<string, number>();
  for (const tools of Object.values(CAPABILITY_TOOLS))
    for (const t of tools) owners.set(t, (owners.get(t) ?? 0) + 1);
  for (const name of Object.values(sdkNames)) {
    if (aliases.has(name)) continue;
    expect([name, owners.get(name)]).toEqual([name, 1]);
  }
  for (const t of owners.keys()) expect(Object.values<string>(sdkNames)).toContain(t);
});

test("the scout has no write, feedback or task tools (a read-only shell only); dev gets the full set", () => {
  const qa = toolsFor(qaRole);
  for (const t of [
    MULTI_EDIT_TOOL_NAME,
    NOTEBOOK_EDIT_TOOL_NAME,
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
