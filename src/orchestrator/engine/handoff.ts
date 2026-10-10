import type { StageHandoff } from "../../roles/role-types";

/* Stage handoff as data: the template of `StageDefinition.handoff` becomes the next stage's prompt. */

/** Plan file name when a stage hands on without a `handoff` (the approved plan is then the whole prompt). */
export const DEFAULT_PLAN_FILE = "plan.md";

/** What the template placeholders stand for. */
export interface HandoffVars {
  /** The approved plan text. */
  plan: string;
  /** Where the plan was saved (`<scratch>/<planFile>`). */
  planPath: string;
  /** The owner's original task text. */
  task: string;
  /** The repo's test command, when it has one. */
  testCommand?: string;
}

/**
 * Replace `{plan}`, `{planPath}`, `{task}` and `{testLine}` in ONE pass: text that was inserted (a plan that
 * itself contains `{task}`) is never expanded again. Unknown `{words}` stay as they are. `{testLine}` is the
 * test command line, or a note that none was given.
 */
export function renderHandoff(h: StageHandoff, v: HandoffVars): string {
  const values = new Map<string, string>([
    ["plan", v.plan],
    ["planPath", v.planPath],
    ["task", v.task],
    ["testLine", v.testCommand ? `Test command: ${v.testCommand}` : "No test command given."],
  ]);
  return h.template.replace(/\{(\w+)\}/g, (all, key: string) => values.get(key) ?? all);
}
