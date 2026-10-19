/**
 * Names of the Claude Agent SDK built-in tools we use. Leaf file (imports nothing) so any module can use
 * the names without import cycles. Only names used in `src/` are listed; add one when code needs it.
 * Naming follows claude-code: `<X>_TOOL_NAME`.
 */

/* File tools. */
export const READ_TOOL_NAME = "Read";
export const GLOB_TOOL_NAME = "Glob";
export const GREP_TOOL_NAME = "Grep";
/** Code intelligence (definitions, references); only active when the owner installs a code-intelligence plugin. */
export const LSP_TOOL_NAME = "LSP";
export const WRITE_TOOL_NAME = "Write";
export const EDIT_TOOL_NAME = "Edit";
export const MULTI_EDIT_TOOL_NAME = "MultiEdit";
export const NOTEBOOK_EDIT_TOOL_NAME = "NotebookEdit";

/* Shell and web. */
export const BASH_TOOL_NAME = "Bash";
/** Streams a shell command's stdout as events (also accepts a WebSocket url). */
export const MONITOR_TOOL_NAME = "Monitor";
export const WEB_SEARCH_TOOL_NAME = "WebSearch";
export const WEB_FETCH_TOOL_NAME = "WebFetch";

/* Skills and subagents. */
export const SKILL_TOOL_NAME = "Skill";
export const AGENT_TOOL_NAME = "Agent";
/** Resumes a named subagent with a new message (spike Q19: `to` = the spawn `name`). */
export const SEND_MESSAGE_TOOL_NAME = "SendMessage";
/** Lists the agents SendMessage can reach (SDK alias: the old name was `ListPeers`). */
export const LIST_AGENTS_TOOL_NAME = "ListAgents";
/** Creates or enters a git worktree; the guard only lets it enter one under the workspace's worktrees dir. */
export const ENTER_WORKTREE_TOOL_NAME = "EnterWorktree";

/* Progress tracking and tool discovery. */
export const TODO_WRITE_TOOL_NAME = "TodoWrite";
export const TASK_CREATE_TOOL_NAME = "TaskCreate";
export const TASK_UPDATE_TOOL_NAME = "TaskUpdate";
export const TASK_LIST_TOOL_NAME = "TaskList";
export const TASK_GET_TOOL_NAME = "TaskGet";
/** Stops a background task (shell or agent) by id. */
export const TASK_STOP_TOOL_NAME = "TaskStop";
export const TOOL_SEARCH_TOOL_NAME = "ToolSearch";

/* AskUserQuestion is answered by the owner (buttons); the plan approval of a developer run is one of these asks. */
export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";

/*
 * MCP resource tools (SDK built-ins that read what the connected MCP servers expose). Wire names checked in the SDK
 * 0.3.287 sources: its alias map turns `ListMcpResources` / `ReadMcpResource` / `ReadMcpResourceDir` (old names) into
 * the `...Tool` names below; `RefreshMcpTools` and `WaitForMcpServers` have no suffix.
 */
export const LIST_MCP_RESOURCES_TOOL_NAME = "ListMcpResourcesTool";
export const READ_MCP_RESOURCE_TOOL_NAME = "ReadMcpResourceTool";
export const READ_MCP_RESOURCE_DIR_TOOL_NAME = "ReadMcpResourceDirTool";
export const REFRESH_MCP_TOOLS_TOOL_NAME = "RefreshMcpTools";
/** Waits until the MCP servers of the run have connected. */
export const WAIT_FOR_MCP_SERVERS_TOOL_NAME = "WaitForMcpServers";

/* Sends a bug / idea report to Anthropic: always the owner's call. */
export const SEND_FEEDBACK_TOOL_NAME = "SendFeedback";

/* Permission request the SDK sends for a host a sandboxed command reaches that no `allowedDomains` entry covers. */
export const SANDBOX_NETWORK_ACCESS_TOOL_NAME = "SandboxNetworkAccess";
