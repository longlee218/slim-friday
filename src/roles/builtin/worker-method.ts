/**
 * The Method line of worker contracts (owner decision D1, 2026-10-20): one generic line with no skill name. Probes showed a
 * worker loads no method skill unless its contract says so (plans/reports/fullstack-developer-261020-developer-skill-activation-probe.md,
 * variant F). Which skills exist stays data (`RoleDefinition.skills`); the line only says to use the listed ones.
 */

/**
 * The Method bullet. `before` names what the skills must precede ("plan or change anything", "plan"); `tail` ends the
 * sentence (a period, or a role clause after a `;`).
 */
export const methodLine = (before: string, tail = "."): string =>
  `- Method: the skills listed for this run are how you work. Before you ${before}, call the Skill tool for every listed skill whose description matches the request (the "Use when" line), even for a small request${tail}`;

/** Roster specialists and the scout: skills first, then any plan or change. */
export const WORKER_METHOD_LINE = methodLine("plan or change anything");

/** The planner: skills before it plans. */
export const PLANNER_METHOD_LINE = methodLine("plan");

/** The developer: same line, plus where the plan it asks the owner to approve comes from. */
export const DEVELOPER_METHOD_LINE = methodLine(
  "plan or change anything",
  "; the plan you ask the owner to approve comes from them.",
);
