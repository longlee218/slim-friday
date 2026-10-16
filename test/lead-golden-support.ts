import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REQUEST_PLAN_TOOL } from "../src/mcp/mcp-tool-names";
import { canonicalRoleName } from "../src/roles/role-aliases";

/* Support of the lead golden set: the fixture loader and the scorer that reads the lead's recorded decisions. */

/** Strategies a case may expect (ANSWER = the lead dispatched nothing). */
export const STRATEGIES = ["ANSWER", "DIRECT", "DELEGATE", "PLAN"] as const;
type GoldenStrategy = (typeof STRATEGIES)[number];

/** One owner message and what the lead must decide. */
export interface GoldenCase {
  id: string;
  text: string;
  strategy: GoldenStrategy;
  /** Worker roles of the dispatched items, in order; empty for ANSWER and PLAN. */
  roles: string[];
}

/** The fixture file (test/fixtures/lead-golden.json). */
export const loadGolden = (): GoldenCase[] =>
  (
    JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "lead-golden.json"), "utf8")) as {
      cases: GoldenCase[];
    }
  ).cases;

/**
 * The lead's recorded decision in a fresh db (one case per db): PLAN when it called RequestPlan, else the strategy
 * its dispatched items imply (1 = DIRECT, 2+ = DELEGATE) with their roles, else ANSWER (it only wrote text or asked).
 */
export function decisionOf(db: Database): Pick<GoldenCase, "strategy" | "roles"> {
  const planned = db
    .query("SELECT 1 FROM effect_log WHERE scope = 'lead tool call' AND tool = ?")
    .get(REQUEST_PLAN_TOOL);
  if (planned) return { strategy: "PLAN", roles: [] };
  const roles = db
    .query<{ owner_role: string }, []>(
      "SELECT owner_role FROM owned_tasks WHERE parent_id IS NOT NULL ORDER BY rowid",
    )
    .all()
    .map((r) => canonicalRoleName(r.owner_role));
  if (roles.length === 0) return { strategy: "ANSWER", roles: [] };
  return { strategy: roles.length === 1 ? "DIRECT" : "DELEGATE", roles };
}
