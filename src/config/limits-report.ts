import { ROLES } from "../roles/role-registry";

/* The one scan of every limit of the code: `/limits` shows it and `test/limits-doc-drift.test.ts` compares it with
   docs/limits-and-stop-conditions.md. Lives in config (limits are config); it imports the role registry for role data. */

/** Limit files: every `typeof number` export is a limit. A new limit file = one line here. */
const LIMIT_MODULES = [
  "./lead-caps",
  "./run-caps",
  "./resilience-caps",
  "./model-routing",
  "../orchestrator/lead/lead-limits",
  "../orchestrator/budget/task-budget",
  "../runtime/run-supervisor",
  "../artifacts/artifact-limits",
];

/**
 * Every limit of the code as name -> value: the exported numbers of the limit files, then per role
 * `role.<name>.{maxTurns,budgetUsd,maxAsk,subagents.parallel,subagents.depth,subagents.enabled}` (enabled: 1 or 0).
 * Throws when an exported name is used by two files (the name is the key).
 */
export async function collectLimits(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const path of LIMIT_MODULES) {
    const mod = (await import(path)) as Record<string, unknown>;
    for (const [name, v] of Object.entries(mod)) {
      if (typeof v !== "number") continue;
      if (out.has(name)) throw new Error(`exported limit name used twice: ${name}`);
      out.set(name, v);
    }
  }
  for (const r of Object.values(ROLES)) {
    out.set(`role.${r.name}.maxTurns`, r.limits.maxTurns);
    out.set(`role.${r.name}.budgetUsd`, r.budgetUsd);
    out.set(`role.${r.name}.maxAsk`, r.limits.maxAsk);
    out.set(`role.${r.name}.subagents.parallel`, r.subagents.parallel);
    out.set(`role.${r.name}.subagents.depth`, r.subagents.depth);
    out.set(`role.${r.name}.subagents.enabled`, r.noSubagents ? 0 : 1);
  }
  return out;
}
