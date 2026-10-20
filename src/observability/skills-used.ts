import type { Logger } from "pino";
import { logEvent } from "./logger";

/**
 * Skill names as the metric counts them: the SDK qualifies a plugin skill as `<plugin>:<name>` (`friday:plan-work`),
 * a run may call either form, so both reduce to the bare name after the last colon.
 */
export function normalizeSkillName(raw: string): string {
  return raw.slice(raw.lastIndexOf(":") + 1).trim();
}

/** The skill name of a Skill tool call input (`{ skill: "..." }`), normalized; undefined when the input has none. */
export function calledSkillName(toolInput: unknown): string | undefined {
  const raw = (toolInput as { skill?: unknown } | null)?.skill;
  return typeof raw === "string" && raw.trim() ? normalizeSkillName(raw) : undefined;
}

/**
 * Logs the `skills.used` event of one finished worker run: the skills the run was given and the ones it called through
 * the Skill tool. `bun run metrics:skills` reads these lines from the app log.
 */
export function logSkillsUsed(
  log: Logger,
  run: { role: string; available: readonly string[]; called: ReadonlySet<string> },
): void {
  logEvent(log, "skills.used", {
    role: run.role,
    available: [...new Set(run.available.map(normalizeSkillName))].sort(),
    called: [...run.called].sort(),
  });
}
