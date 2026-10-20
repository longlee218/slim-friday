import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLAN_MAX_CRITERIA } from "../src/config/lead-caps";
import type { PlanDoc } from "../src/orchestrator/plan/plan-types";

/* Support of the planner team eval: the fixture loader and the scorer of a stored plan (no API call). */

/** One owner request and what its plan must look like. */
export interface PlannerCase {
  id: string;
  text: string;
  /** `project`: a team plan; `small`: a plan of at most SMALL_MAX_ITEMS items. */
  kind: "project" | "small";
  /** The request names a UI: a designer item is expected. */
  ui: boolean;
}

/** Item cap of a small request's plan. */
export const SMALL_MAX_ITEMS = 2;

/** Roles of a project plan that count as the research or architecture step. */
const FRONT_ROLES = ["scout", "researcher", "solution-architect"];

/** The fixture file (test/fixtures/planner-team.json). */
export const loadPlannerCases = (): PlannerCase[] =>
  (
    JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "planner-team.json"), "utf8")) as {
      cases: PlannerCase[];
    }
  ).cases;

/** Misses of a plan against its case (empty = pass). */
export function planMisses(c: PlannerCase, doc: PlanDoc): string[] {
  const roles = new Set(doc.items.map((i) => i.role));
  const misses: string[] = [];
  const n = doc.acceptanceCriteria.length;
  if (n < 1 || n > PLAN_MAX_CRITERIA) misses.push(`criteria count ${n}`);
  if (c.kind === "small") {
    if (doc.items.length > SMALL_MAX_ITEMS)
      misses.push(`${doc.items.length} items for a small request`);
    return misses;
  }
  if (roles.size < 3) misses.push(`only ${roles.size} distinct roles`);
  if (!roles.has("developer")) misses.push("no developer item");
  if (!FRONT_ROLES.some((r) => roles.has(r))) misses.push("no research or architecture item");
  if (c.ui && !roles.has("designer")) misses.push("UI named but no designer item");
  return misses;
}
