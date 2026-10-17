import { expect, test } from "bun:test";
import { PLAN_MAX_ITEMS, PLAN_MAX_REVISIONS } from "../src/config/lead-caps";
import { MERGE_BRANCH_TOOL } from "../src/mcp/effects/tools/MergeBranchTool/constants";
import { envelopeGrew } from "../src/orchestrator/plan/envelope-diff";
import { buildEnvelope, toPlanItem } from "../src/orchestrator/plan/plan-doc";
import { normalizeRisk, type PlanCtx, type PlanDoc } from "../src/orchestrator/plan/plan-types";
import { validatePlan } from "../src/orchestrator/plan/validate-plan";

/* The plan validator is pure: one table row per error code, plus the happy path and the envelope diff. */

const CTX: PlanCtx = {
  workerRoles: ["developer", "scout"],
  locations: ["repo", "docs"],
  goalBudgetUsd: 6,
  existingKeys: [],
  revisions: 0,
};
const item = (key: string, over: Record<string, unknown> = {}) =>
  toPlanItem({ key, role: "developer", brief: `do ${key}`, dependsOn: [], risk: "R1", ...over });
/** A plan doc over the given items; the envelope covers repo + R0-R2 by default. */
const doc = (items: ReturnType<typeof item>[], env: Record<string, unknown> = {}): PlanDoc => ({
  items,
  acceptanceCriteria: ["done"],
  envelope: {
    ...buildEnvelope(
      { locations: ["repo"], riskClasses: ["R0", "R1", "R2"], bounds: { maxItems: 8, maxGb: 1 } },
      items,
      3,
      [],
    ),
    ...env,
  },
});
const codes = (d: PlanDoc, ctx: Partial<PlanCtx> = {}): string[] =>
  validatePlan(d, { ...CTX, ...ctx }).map((e) => e.code);

test("a sound plan has no errors; deps may point at earlier finished items", () => {
  expect(codes(doc([item("a"), item("b", { dependsOn: ["a"] })]))).toEqual([]);
  expect(codes(doc([item("b", { dependsOn: ["old"] })]), { existingKeys: ["old"] })).toEqual([]);
});

test("each rule answers its code", () => {
  const tooMany = Array.from({ length: PLAN_MAX_ITEMS + 1 }, (_, i) => item(`k${i}`));
  const table: [string, string[], PlanDoc, Partial<PlanCtx>?][] = [
    ["NO_ITEMS", ["NO_ITEMS"], doc([])],
    [
      "TOO_MANY_ITEMS",
      ["TOO_MANY_ITEMS"],
      doc(tooMany, { bounds: { maxItems: tooMany.length, maxGb: 1 } }),
    ],
    ["DUP_KEY", ["DUP_KEY"], doc([item("a"), item("a")])],
    ["DUP_KEY reserved", ["DUP_KEY"], doc([item("planner-x")])],
    ["DUP_KEY existing", ["DUP_KEY"], doc([item("old")]), { existingKeys: ["old"] }],
    ["UNKNOWN_ROLE", ["UNKNOWN_ROLE"], doc([item("a", { role: "lead" })])],
    ["UNKNOWN_DEP", ["UNKNOWN_DEP"], doc([item("a", { dependsOn: ["nope"] })])],
    [
      "CYCLE",
      ["CYCLE", "CYCLE"],
      doc([item("a", { dependsOn: ["b"] }), item("b", { dependsOn: ["a"] })]),
    ],
    ["BAD_LOCATION", ["BAD_LOCATION"], doc([item("a", { location: "elsewhere" })])],
    ["OUTSIDE_ENVELOPE location", ["OUTSIDE_ENVELOPE"], doc([item("a", { location: "docs" })])],
    ["OUTSIDE_ENVELOPE risk", ["OUTSIDE_ENVELOPE"], doc([item("a", { risk: "R3" })])],
    [
      "OUTSIDE_ENVELOPE count",
      ["OUTSIDE_ENVELOPE"],
      doc([item("a"), item("b")], { bounds: { maxItems: 1, maxGb: 1 } }),
    ],
    ["BUDGET", ["BUDGET"], doc([item("a")], { budgetUsd: 7 })],
    [
      "TOO_MANY_REVISIONS",
      ["TOO_MANY_REVISIONS"],
      doc([item("a")]),
      { revisions: PLAN_MAX_REVISIONS + 1 },
    ],
  ];
  for (const [name, want, d, ctx] of table) expect([name, codes(d, ctx)]).toEqual([name, want]);
});

test("an unknown risk word counts as R2, never R0", () => {
  expect(normalizeRisk("R9")).toBe("R2");
  expect(normalizeRisk("low")).toBe("R2");
  expect(normalizeRisk("R0")).toBe("R0");
});

test("envelopeGrew: only a wider ask is growth", () => {
  const base = doc([item("a")]).envelope;
  expect(envelopeGrew(base, { ...base })).toBe(false);
  expect(envelopeGrew(base, { ...base, locations: ["repo"], budgetUsd: 2 })).toBe(false); // narrower
  expect(envelopeGrew(base, { ...base, locations: ["repo", "docs"] })).toBe(true);
  expect(envelopeGrew(base, { ...base, riskClasses: ["R0", "R1", "R2", "R3"] })).toBe(true);
  expect(envelopeGrew(base, { ...base, roles: ["developer", "scout"] })).toBe(true);
  expect(envelopeGrew(base, { ...base, bounds: { maxItems: 9, maxGb: 1 } })).toBe(true);
  expect(envelopeGrew(base, { ...base, budgetUsd: 4 })).toBe(true);
  expect(envelopeGrew(base, { ...base, effects: [MERGE_BRANCH_TOOL] })).toBe(true);
});
