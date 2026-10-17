import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildServers } from "../src/mcp/mcp-servers";
import {
  DISCORD_ADMIN_MCP_SERVER,
  EFFECTS_MCP_SERVER,
  MEMORY_MCP_SERVER,
  mcpServerPrefix,
  mcpToolName,
  ORCHESTRATION_MCP_SERVER,
  PLAN_MCP_SERVER,
} from "../src/mcp/mcp-tool-names";
import * as sdk from "../src/tools/sdk-tool-names";
import { ALL_TOOL_NAMES, FULL_CTX, toolsByServer } from "./mcp-ctx-fixture";

/** A role that lists every MCP tool (builds every server instance). */
const ALL_ROLE = { name: "all", mcpTools: ALL_TOOL_NAMES } as never;

// The ONLY test with tool-name literals: it pins the wire contract (SDK / MCP server names) that every
// other test and all of src/ reference through constants.

test("SDK built-in tool names are the real wire names", () => {
  expect({ ...sdk }).toEqual({
    READ_TOOL_NAME: "Read",
    GLOB_TOOL_NAME: "Glob",
    GREP_TOOL_NAME: "Grep",
    LSP_TOOL_NAME: "LSP",
    WRITE_TOOL_NAME: "Write",
    EDIT_TOOL_NAME: "Edit",
    MULTI_EDIT_TOOL_NAME: "MultiEdit",
    NOTEBOOK_EDIT_TOOL_NAME: "NotebookEdit",
    BASH_TOOL_NAME: "Bash",
    MONITOR_TOOL_NAME: "Monitor",
    WEB_SEARCH_TOOL_NAME: "WebSearch",
    WEB_FETCH_TOOL_NAME: "WebFetch",
    SKILL_TOOL_NAME: "Skill",
    AGENT_TOOL_NAME: "Agent",
    SEND_MESSAGE_TOOL_NAME: "SendMessage",
    LIST_AGENTS_TOOL_NAME: "ListAgents",
    ENTER_WORKTREE_TOOL_NAME: "EnterWorktree",
    TODO_WRITE_TOOL_NAME: "TodoWrite",
    TASK_CREATE_TOOL_NAME: "TaskCreate",
    TASK_UPDATE_TOOL_NAME: "TaskUpdate",
    TASK_LIST_TOOL_NAME: "TaskList",
    TASK_GET_TOOL_NAME: "TaskGet",
    TASK_STOP_TOOL_NAME: "TaskStop",
    TOOL_SEARCH_TOOL_NAME: "ToolSearch",
    ASK_USER_QUESTION_TOOL_NAME: "AskUserQuestion",
    LIST_MCP_RESOURCES_TOOL_NAME: "ListMcpResourcesTool",
    READ_MCP_RESOURCE_TOOL_NAME: "ReadMcpResourceTool",
    READ_MCP_RESOURCE_DIR_TOOL_NAME: "ReadMcpResourceDirTool",
    REFRESH_MCP_TOOLS_TOOL_NAME: "RefreshMcpTools",
    WAIT_FOR_MCP_SERVERS_TOOL_NAME: "WaitForMcpServers",
    SEND_FEEDBACK_TOOL_NAME: "SendFeedback",
  });
});

test("MCP server and tool names are the real wire names", () => {
  expect([
    MEMORY_MCP_SERVER,
    ORCHESTRATION_MCP_SERVER,
    PLAN_MCP_SERVER,
    EFFECTS_MCP_SERVER,
    DISCORD_ADMIN_MCP_SERVER,
  ]).toEqual(["memory", "orchestration", "plan", "effects", "discord-admin"]);
  // Every tool the app can build, by server, with all ctx parts present and a role that lists every tool.
  expect(toolsByServer(buildServers(ALL_ROLE, FULL_CTX))).toEqual({
    memory: ["MemoryExpand", "MemoryGet", "MemorySave", "MemorySearch"],
    orchestration: [
      "ApprovePlan",
      "AskOwner",
      "CancelTask",
      "DispatchAgent",
      "ForwardResult",
      "ReportProgress",
      "ReportResult",
      "RequestPlan",
      "SetThreadTitle",
      "SteerTask",
      "TaskStatus",
    ],
    plan: [
      "AnalyzeBlockers",
      "CreatePlan",
      "GetAgentCapabilities",
      "GetExecutionProgress",
      "GetProjectContext",
      "ProposePlanRevision",
      "ValidatePlan",
    ],
    effects: ["CreatePullRequest", "DeletePaths", "GitPush", "MergeBranch"],
    "discord-admin": ["CreateSpaceOrChannel", "ListSpaces", "WriteSpaceFile"],
  });
});

test("full MCP names: mcp__<server>__<tool>, valid characters", () => {
  expect(mcpServerPrefix("memory")).toBe("mcp__memory__");
  expect(mcpToolName("memory", "MemorySave")).toBe("mcp__memory__MemorySave");
  const valid = /^mcp__[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+$/;
  for (const [server, tools] of Object.entries(toolsByServer(buildServers(ALL_ROLE, FULL_CTX))))
    for (const t of tools) expect(mcpToolName(server, t)).toMatch(valid);
});

/** The installed SDK package dir (and the platform packages beside it, which hold the bundled CLI binary). */
const SCOPE = join(import.meta.dir, "..", "node_modules", "@anthropic-ai");
const SDK_JS = join(SCOPE, "claude-agent-sdk", "sdk.mjs");

test.skipIf(!existsSync(SDK_JS))(
  "tool names the app relies on exist as strings in the installed SDK package (a rename shows up here)",
  () => {
    const wanted = [
      sdk.LIST_MCP_RESOURCES_TOOL_NAME,
      sdk.READ_MCP_RESOURCE_TOOL_NAME,
      sdk.READ_MCP_RESOURCE_DIR_TOOL_NAME,
      sdk.WAIT_FOR_MCP_SERVERS_TOOL_NAME,
      sdk.LIST_AGENTS_TOOL_NAME,
    ];
    // sdk.mjs holds the alias map; a few names live only in the platform package's bundled CLI binary.
    const sources = [SDK_JS];
    for (const d of readdirSync(SCOPE).filter((n) => n.startsWith("claude-agent-sdk-"))) {
      const bin = join(SCOPE, d, "claude");
      if (existsSync(bin)) sources.push(bin);
    }
    const missing = new Set(wanted);
    for (const file of sources) {
      if (missing.size === 0) break;
      const data = readFileSync(file);
      for (const name of [...missing]) if (data.includes(name)) missing.delete(name);
    }
    expect([...missing]).toEqual([]);
  },
);
