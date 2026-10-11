import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { ModelTier } from "../../config/model-routing";
import { GIT_MCP_SERVER, GIT_TOOL, mcpToolName } from "../../mcp/mcp-tool-names";
import {
  BASH_TOOL_NAME,
  EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../../tools/sdk-tool-names";

/** `mcp__git__<tool>` full names of the git MCP tools a subagent lists. */
const git = (...tools: string[]): string[] => tools.map((t) => mcpToolName(GIT_MCP_SERVER, t));

/**
 * What a subagent may do, as DATA read by the guard (`guardrails/subagent-guard.ts`): the guard never names a
 * subagent, it looks the scope up by the `agent_type` of the hook input.
 */
export interface SubagentScopeData {
  /** No file writes and no shell at all (Write/Edit/MultiEdit/NotebookEdit/Bash/Monitor are denied). */
  readOnly: boolean;
  /** May stage and commit through the git MCP (worktree only). false = git reads only. */
  canCommit: boolean;
}

/** What the guard gets per subagent type: the scope data plus the tools it may call (its `tools` list). */
export type SubagentScope = SubagentScopeData & {
  tools: readonly string[];
  /** Resumable with SendMessage (the stage's main agent then gets that tool). */
  resumable?: boolean;
  /** Which dispatch templates use this type: named in the denial of a wrong `subagent_type`, so the model picks right. */
  use?: string;
};

/** One subagent type: how the SDK starts it (prompt, tools, model, turns) and what the guard lets it do. */
export interface SubagentDefinition {
  description: string;
  prompt: string;
  /** EXPLICIT tools: a subagent otherwise inherits the default set (Bash, Write...), not the parent's (spike). */
  tools: string[];
  model: ModelTier;
  maxTurns: number;
  scope: SubagentScopeData;
  /** The main agent may resume a spawned one with SendMessage (a skill's fix rounds). Omitted = no. */
  resumable?: boolean;
  /** Short text: the dispatch templates that map to this type (see `SubagentScope.use`). Omitted = none. */
  use?: string;
}

/** Every subagent type the app knows. A stage lists the names it may start (`StageDefinition.subagents`). */
export const SUBAGENTS: Record<string, SubagentDefinition> = {
  // Ex `repo-searcher`: broad code lookups, read-only.
  explorer: {
    description:
      "Searches code across the registered repos and reports findings with file:line. Use for broad lookups.",
    prompt:
      "You search code. Use Glob/Grep/Read with absolute paths. Report only what you found, each item with file:line. Do not modify anything.",
    tools: [READ_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME],
    model: "haiku",
    maxTurns: 15,
    scope: { readOnly: true, canCommit: false },
  },
  // Implements one task of a plan in the task clone (SDD implementer template).
  implementer: {
    description:
      "Implements one plan task in the task clone: edits files, runs the tests, commits with the git tools, reports a status.",
    prompt:
      "You implement one task in the clone (your current directory). Build exactly what your brief says.\n- Edit only inside the clone; no shell for git, never push or amend. Commit with git_add and git_commit (path = the clone): one short conventional commit per task, no Co-Authored-By or AI attribution.\n- Run the repo's test command with Bash; other commands may be denied: adapt, do not retry the same call.\n- You cannot ask anyone. When blocked or missing information, stop and report NEEDS_CONTEXT or BLOCKED with the specifics.\n- Never start a subagent. End with the status contract of your brief.",
    tools: [
      READ_TOOL_NAME,
      GLOB_TOOL_NAME,
      GREP_TOOL_NAME,
      EDIT_TOOL_NAME,
      WRITE_TOOL_NAME,
      BASH_TOOL_NAME,
      ...git(GIT_TOOL.STATUS, GIT_TOOL.ADD, GIT_TOOL.COMMIT),
    ],
    model: "sonnet",
    maxTurns: 40,
    scope: { readOnly: false, canCommit: true },
    resumable: true,
    use: "implementer prompt templates",
  },
  // Reviews a diff (task review, scoped re-review, final code review): reads, never changes anything.
  "task-reviewer": {
    description:
      "Reviews a diff against its brief: spec compliance and code quality. Read-only, reports findings by severity.",
    prompt:
      "You review a change. Read the brief, the report and the diff file you are given, then judge the code on its merits.\n- Read-only: you cannot edit, run a shell or commit. For git use git_log, git_diff, git_status, git_show with path = the clone.\n- Report findings with file:line and severity, then a verdict. Do not crawl beyond the diff except to check a risk you can name.\n- You cannot ask anyone: if the input is missing, say so in your report.\n- Never start a subagent.",
    tools: [
      READ_TOOL_NAME,
      GLOB_TOOL_NAME,
      GREP_TOOL_NAME,
      ...git(GIT_TOOL.LOG, GIT_TOOL.DIFF, GIT_TOOL.STATUS, GIT_TOOL.SHOW),
    ],
    model: "sonnet",
    maxTurns: 20,
    scope: { readOnly: true, canCommit: false },
    use: "task reviewer, re-review and final code reviewer templates",
  },
};

/** Scope table of the named subagents (the guard context). A name missing from the registry is left out: denied. */
export function scopesOf(names: readonly string[]): Record<string, SubagentScope> {
  return Object.fromEntries(
    names.flatMap((n) => {
      const def = SUBAGENTS[n];
      return def
        ? [
            [
              n,
              {
                ...def.scope,
                tools: def.tools,
                ...(def.resumable && { resumable: true }),
                ...(def.use && { use: def.use }),
              },
            ] as const,
          ]
        : [];
    }),
  );
}

/** The SDK `agents` option of a run: only the subagents the stage names (SDK fields only, no guard scope). */
export function agentsOf(names: readonly string[] | undefined): Record<string, AgentDefinition> {
  return Object.fromEntries(
    (names ?? []).flatMap((n) => {
      const def = SUBAGENTS[n];
      if (!def) return [];
      const { description, prompt, tools, model, maxTurns } = def;
      return [[n, { description, prompt, tools, model, maxTurns }] as const];
    }),
  );
}
