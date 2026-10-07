/**
 * Names of the Claude Agent SDK built-in tools we use. Leaf file (imports nothing) so any module can use
 * the names without import cycles. Only names used in `src/` are listed; add one when code needs it.
 * Naming follows claude-code: `<X>_TOOL_NAME`.
 */

/* File tools. */
export const READ_TOOL_NAME = "Read";
export const GLOB_TOOL_NAME = "Glob";
export const GREP_TOOL_NAME = "Grep";
export const WRITE_TOOL_NAME = "Write";
export const EDIT_TOOL_NAME = "Edit";
export const MULTI_EDIT_TOOL_NAME = "MultiEdit";
export const NOTEBOOK_EDIT_TOOL_NAME = "NotebookEdit";

/* Shell and web. */
export const BASH_TOOL_NAME = "Bash";
export const WEB_SEARCH_TOOL_NAME = "WebSearch";
export const WEB_FETCH_TOOL_NAME = "WebFetch";

/* Skills and subagents. `Task` is the legacy name of the Agent tool. */
export const SKILL_TOOL_NAME = "Skill";
export const AGENT_TOOL_NAME = "Agent";
export const LEGACY_AGENT_TOOL_NAME = "Task";

/* Progress tracking and tool discovery. */
export const TODO_WRITE_TOOL_NAME = "TodoWrite";
export const TASK_CREATE_TOOL_NAME = "TaskCreate";
export const TASK_UPDATE_TOOL_NAME = "TaskUpdate";
export const TASK_LIST_TOOL_NAME = "TaskList";
export const TOOL_SEARCH_TOOL_NAME = "ToolSearch";

/* Plan flow: Exit and AskUserQuestion are answered by the owner; Enter is harmless. */
export const EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";
export const ENTER_PLAN_MODE_TOOL_NAME = "EnterPlanMode";
export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
