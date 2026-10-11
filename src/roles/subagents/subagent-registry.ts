import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { ModelTier } from "../../config/model-routing";
import { GLOB_TOOL_NAME, GREP_TOOL_NAME, READ_TOOL_NAME } from "../../tools/sdk-tool-names";

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
export type SubagentScope = SubagentScopeData & { tools: readonly string[] };

/** One subagent type: how the SDK starts it (prompt, tools, model, turns) and what the guard lets it do. */
export interface SubagentDefinition {
  description: string;
  prompt: string;
  /** EXPLICIT tools: a subagent otherwise inherits the default set (Bash, Write...), not the parent's (spike). */
  tools: string[];
  model: ModelTier;
  maxTurns: number;
  scope: SubagentScopeData;
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
};

/** Scope table of the named subagents (the guard context). A name missing from the registry is left out: denied. */
export function scopesOf(names: readonly string[]): Record<string, SubagentScope> {
  return Object.fromEntries(
    names.flatMap((n) => {
      const def = SUBAGENTS[n];
      return def ? [[n, { ...def.scope, tools: def.tools }] as const] : [];
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
