import { MAX_PARALLEL_SUBAGENTS, MAX_SUBAGENT_SPAWNS } from "../../guardrails/subagent-run";
import { GIT_TOOL } from "../../mcp/mcp-tool-names";
import { AGENT_TOOL_NAME, SEND_MESSAGE_TOOL_NAME } from "../../tools/sdk-tool-names";

/**
 * Friday's run facts for subagent-driven work in the dev exec stage: how the publisher skills' dispatch templates map
 * onto this app's subagent types. Self-contained and delimited on purpose: the prompt-quality plan (P3) folds run facts
 * into the role prompts later and can move this block as it is. It restates no skill step, it only maps and limits.
 * Empty unless the stage lists both `implementer` and `task-reviewer` (the single switch, see `DEV_SKILLS`).
 */
export function subagentRunFacts(stageSubagents: readonly string[]): string {
  if (!["implementer", "task-reviewer"].every((n) => stageSubagents.includes(n))) return "";
  return `<subagent-run-facts>
- Subagent types here: ${stageSubagents.join(", ")}. A skill template headed "Subagent (general-purpose)" is started with ${AGENT_TOOL_NAME} and one of these \`subagent_type\` values: the implementer prompt template -> implementer; the task reviewer, re-review and final code-reviewer templates -> task-reviewer. Any other type is denied.
- Every ${AGENT_TOOL_NAME} call: pass \`name\` (a short slug, unique in this run) and \`model\` (haiku or sonnet; opus only for a design task), foreground, no other keys.
- Resume a subagent for a fix round with ${SEND_MESSAGE_TOOL_NAME}, \`to\` = its \`name\`. At most ${MAX_PARALLEL_SUBAGENTS} run at once and ${MAX_SUBAGENT_SPAWNS} starts and resumes per run.
- Subagents work in this clone, cannot ask the owner and never push. The implementer commits with ${GIT_TOOL.ADD} and ${GIT_TOOL.COMMIT} (path = the clone) and may run the repo's test command; reviewers read only and cannot write or commit. On NEEDS_CONTEXT or BLOCKED, resolve it as the skill says; the owner is not asked for a subagent.
- Use subagent-driven development only for a plan of 3 or more tasks; with fewer, execute the plan inline.
</subagent-run-facts>`;
}
