/**
 * Read-only tool config. ONLY `tools` truly restricts the tool set;
 * `allowedTools` just auto-approves (and bypasses canUseTool), so never use it.
 */
export const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"] as const;

/** Second layer: explicitly deny everything dangerous in case `tools` semantics change. */
export const DISALLOWED_TOOLS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Task",
  "TodoWrite",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "EnterWorktree",
  "ExitWorktree",
  "EnterPlanMode",
  "ExitPlanMode",
  "AskUserQuestion",
  "Skill",
  "SlashCommand",
];

/**
 * Scoped deny rules for secret files (documented: disallowedTools accepts `Tool(pattern)` rules
 * that are denied in every permission mode). Backstop for the prompt rule; redaction is the other.
 */
export const SECRET_FILE_RULES = [
  "Read(**/.env*)",
  "Read(**/*.pem)",
  "Read(**/*.key)",
  "Read(**/id_rsa*)",
  "Read(**/credentials*)",
];

/** SDK options fragment for the read-only Q&A mode. */
export function readOnlyToolOptions() {
  return {
    tools: [...READ_ONLY_TOOLS],
    disallowedTools: [...DISALLOWED_TOOLS, ...SECRET_FILE_RULES],
    // Ignore account-level MCP connectors (claude.ai) leaking into the tool list.
    strictMcpConfig: true,
  };
}
