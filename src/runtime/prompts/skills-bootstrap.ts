import {
  ASK_USER_QUESTION_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  SKILL_TOOL_NAME,
} from "../../tools/sdk-tool-names";
import { MAX_ASK_CALLS_PER_TASK } from "../ask-limit";

/**
 * Skills bootstrap: how this app loads skills and the facts of the run a skill text cannot know. The publisher's
 * skills are loaded whole and UNMODIFIED; nothing here rewrites or overrides a skill. Where a skill assumes another
 * environment (where a plan is saved, how a branch is made, who is "the human"), this text states what is true here
 * and the model applies the skill's intent to it. Upstream injects its own bootstrap with a SessionStart hook; the app
 * never loads plugin hooks, so the equivalent lives in the system prompt (it also survives compaction there).
 * Added only for stages whose role lists `skills` (see `system-prompt.ts`). Subagent types are NOT named here.
 */
export const SKILLS_BOOTSTRAP = `## Skills
Skills load through the ${SKILL_TOOL_NAME} tool. Publisher skills are named \`superpowers:<name>\`, the workspace's own \`<workspace>:<name>\`. Their text is the publisher's, unmodified. Only the skills in the list exist; a skill step that names a skill, subagent or tool that is not available here cannot be done: say so in one line and continue with the rest.
- Check the skill list before you act. If a skill has even a small chance of applying, invoke it and follow it. The workspace's \`workflow\` skill, when listed, says which skill fits which step.
- Facts of this run (apply a skill's steps to them; a skill's intent holds, its paths and tools may not):
  - Your human partner is the owner, who sees only Discord. Reach them with ${ASK_USER_QUESTION_TOOL_NAME} (at most ${MAX_ASK_CALLS_PER_TASK} calls per task in all, plan and execute stages together; see the ask rules above); text you write is not a conversation turn. Subagents never ask.
  - Plan stage: plan mode in a scratch dir, repos read-only. The only files you can write are the plan file and the task scratch dir. A spec, design or plan a skill says to save under docs/ goes in the plan file instead (a design section first, then the plan); nothing is committed in this stage. The owner reviews at ${EXIT_PLAN_MODE_TOOL_NAME}: that call is your "plan complete, please review" step and the execution handoff, so do not ask which execution approach they prefer.
  - Execute stage: you are already in an isolated clone on its own branch (no worktree or branch to create), and the approved plan is the plan.md in the task scratch dir: give that path to a skill script that asks for a plan file. Skill steps that commit use the git tools of the run rules, never shell git. The app pushes and opens the PR: there is no merge, PR or cleanup step for you.
  - A skill's scripts sit in its plugin directory (shown as the skill's base directory when it loads): you may read them and run them by absolute path.
- The owner's instructions and the rules in this prompt come first when they differ from a skill.`;
