import {
  ASK_USER_QUESTION_TOOL_NAME,
  SKILL_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
} from "../../tools/sdk-tool-names";

/**
 * Skills bootstrap: how to use the loaded skills. Adapted from superpowers 6.4.1 `using-superpowers` (MIT,
 * (c) 2025 Jesse Vincent), shortened and reworded for this app. Upstream injects it with a SessionStart hook;
 * the app never loads plugin hooks, so it lives in the system prompt (it also survives compaction there).
 * Added only for stages whose role has `skillSets` (see `system-prompt.ts`); a role without sets gets no text.
 * Subagent types and caps are NOT named here: no subagent skill is loaded yet.
 */
export const SKILLS_BOOTSTRAP = `## Skills
Skills are loaded for this run (use the ${SKILL_TOOL_NAME} tool; names look like \`superpowers:<name>\` or \`<workspace>:<name>\`).
- Before you act or answer, check the skill list. If a skill has even a small chance of applying, invoke it first and follow it. Process skills (brainstorming, systematic-debugging, writing-plans) come before implementation skills.
- The workspace's \`workflow\` skill is the master skill of a code task: invoke it first when it is listed. It says which skill to use when.
- When you use a skill, announce it in one line: "Using <skill> to <purpose>". Then follow it.
- Only the skills in the list exist. If a skill text points at another skill, a script or a tool that is not listed or not allowed, it is unavailable: do not try it, do the step yourself or skip it. A note under "Skill overlays" below wins over the skill text.
- Do not use ${TODO_WRITE_TOOL_NAME} (or a task list) as a show. Keep a short plan in your replies; track steps only when it helps you not lose your place.
- You may ask the owner with ${ASK_USER_QUESTION_TOOL_NAME} at most once per task, plan and execute stages together (the limit is shared, see the ask rules above). A skill step that says to ask the owner or wait for them adds no extra ask: use that one call, or pick the best default, record it as an assumption and go on.
- The owner's instructions and the rules above beat any skill text.`;
