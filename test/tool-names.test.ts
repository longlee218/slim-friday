import { expect, test } from "bun:test";
import {
  GIT_MCP_SERVER,
  GIT_TOOL,
  GITHUB_MCP_SERVER,
  GITHUB_TOOL,
  mcpServerPrefix,
  mcpToolName,
} from "../src/mcp/mcp-tool-names";
import * as sdk from "../src/tools/sdk-tool-names";

// The ONLY test with tool-name literals: it pins the wire contract (SDK / MCP server names) that every
// other test and all of src/ reference through constants.

test("SDK built-in tool names are the real wire names", () => {
  expect({ ...sdk }).toEqual({
    READ_TOOL_NAME: "Read",
    GLOB_TOOL_NAME: "Glob",
    GREP_TOOL_NAME: "Grep",
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
    LEGACY_AGENT_TOOL_NAME: "Task",
    TODO_WRITE_TOOL_NAME: "TodoWrite",
    TASK_CREATE_TOOL_NAME: "TaskCreate",
    TASK_UPDATE_TOOL_NAME: "TaskUpdate",
    TASK_LIST_TOOL_NAME: "TaskList",
    TASK_GET_TOOL_NAME: "TaskGet",
    TASK_STOP_TOOL_NAME: "TaskStop",
    TOOL_SEARCH_TOOL_NAME: "ToolSearch",
    EXIT_PLAN_MODE_TOOL_NAME: "ExitPlanMode",
    ENTER_PLAN_MODE_TOOL_NAME: "EnterPlanMode",
    ASK_USER_QUESTION_TOOL_NAME: "AskUserQuestion",
    LIST_MCP_RESOURCES_TOOL_NAME: "ListMcpResources",
    READ_MCP_RESOURCE_TOOL_NAME: "ReadMcpResource",
    READ_MCP_RESOURCE_DIR_TOOL_NAME: "ReadMcpResourceDir",
    REFRESH_MCP_TOOLS_TOOL_NAME: "RefreshMcpTools",
    SEND_FEEDBACK_TOOL_NAME: "SendFeedback",
  });
});

test("MCP server and tool names are the real wire names", () => {
  expect(GIT_MCP_SERVER).toBe("git");
  expect(GITHUB_MCP_SERVER).toBe("github");
  expect(Object.keys(GIT_TOOL)).toHaveLength(28);
  for (const [k, v] of Object.entries<string>(GIT_TOOL)) expect(v).toBe(`git_${k.toLowerCase()}`);
  expect(GITHUB_TOOL).toEqual({
    CREATE_PULL_REQUEST: "create_pull_request",
    LIST_PULL_REQUESTS: "list_pull_requests",
  });
});

test("full MCP names: mcp__<server>__<tool>, valid characters", () => {
  expect(mcpServerPrefix("git")).toBe("mcp__git__");
  expect(mcpToolName("git", "git_log")).toBe("mcp__git__git_log");
  const valid = /^mcp__[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+$/;
  for (const t of Object.values(GIT_TOOL)) expect(mcpToolName("git", t)).toMatch(valid);
});
