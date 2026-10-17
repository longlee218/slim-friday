import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ROLES } from "../src/roles/role-registry";

/* Drift check: every limit in code must have a `<!-- limit:NAME=VALUE -->` marker in docs/limits-and-stop-conditions.md
   with the same value, and every marker must match a code value. Code side = exported numbers of the limit files plus
   the numeric fields of every role. */

/** Limit files: every `typeof number` export is a limit. */
const LIMIT_MODULES = [
  "../src/config/lead-caps",
  "../src/config/run-caps",
  "../src/config/resilience-caps",
  "../src/config/model-routing",
  "../src/orchestrator/lead/lead-limits",
  "../src/orchestrator/budget/task-budget",
  "../src/runtime/run-supervisor",
];

/** Every limit of the code as name -> value (also asserts that exported names are unique across the files). */
async function collectCodeLimits(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const path of LIMIT_MODULES) {
    const mod = (await import(path)) as Record<string, unknown>;
    for (const [name, v] of Object.entries(mod)) {
      if (typeof v !== "number") continue;
      expect(out.has(name), `exported limit name used twice: ${name}`).toBe(false);
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

/** Markers of the doc as a list (duplicates kept so the test can report them). */
function docMarkers(): { name: string; value: number }[] {
  const text = readFileSync("docs/limits-and-stop-conditions.md", "utf8");
  return [...text.matchAll(/<!-- limit:([\w.-]+)=([\d.]+) -->/g)].map((m) => ({
    name: m[1] ?? "",
    value: Number(m[2]),
  }));
}

test("the limits doc and the code agree on every limit", async () => {
  const code = await collectCodeLimits();
  const markers = docMarkers();
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { name, value } of markers) {
    if (seen.has(name)) problems.push(`duplicate marker: ${name}`);
    seen.add(name);
    const actual = code.get(name);
    if (actual === undefined) problems.push(`doc marker without a code limit: ${name}=${value}`);
    else if (actual !== value)
      problems.push(`value mismatch ${name}: doc ${value}, code ${actual}`);
  }
  for (const [name, value] of code)
    if (!seen.has(name)) problems.push(`code limit without a doc marker: ${name}=${value}`);
  // Per-name problems first (they name the limit); this only guards a whole table removed from the doc.
  expect(problems).toEqual([]);
  expect(markers.length).toBeGreaterThanOrEqual(code.size);
});
