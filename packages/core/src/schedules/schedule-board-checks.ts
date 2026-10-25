import type { RepeatRule } from "./schedule";
import { NAME_MAX, NOTIFY_MODES, type SchedulePatch, TASK_MAX } from "./schedule-board-types";
import { ruleError } from "./schedule-rules";

/** Why the name, task, rule or notify of a create or patch is invalid (only the fields present are checked). */
export function fieldError(p: SchedulePatch): string | undefined {
  const name = p.name?.trim();
  if (p.name !== undefined && (!name || name.length > NAME_MAX))
    return `name must be 1 to ${NAME_MAX} characters`;
  const task = p.task?.trim();
  if (p.task !== undefined && (!task || task.length > TASK_MAX))
    return `task must be 1 to ${TASK_MAX} characters`;
  if (p.notify !== undefined && !NOTIFY_MODES.includes(p.notify))
    return 'notify must be "always" or "problems"';
  return p.rule && ruleError(p.rule);
}

/** The refusal text of a rule with no next run; a `once` on a day that does not exist (31 Feb) says so. */
export function noNextRun(rule: RepeatRule): string {
  if (rule.kind !== "once") return "That rule never fires.";
  return dateExists(rule.date)
    ? "That time is already past."
    : "That date does not exist or is already past.";
}

/** True when a `YYYY-MM-DD` names a real calendar day. */
function dateExists(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number);
  const at = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  return at.getUTCFullYear() === y && at.getUTCMonth() + 1 === m && at.getUTCDate() === d;
}
