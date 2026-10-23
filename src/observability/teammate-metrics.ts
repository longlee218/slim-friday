import type { Database } from "bun:sqlite";
import { CHIEF_OF_STAFF_ROLE } from "../roles/builtin/chief-of-staff-role";
import {
  costPerDay,
  costPerTeammate,
  type DayCost,
  envelopeBlocks,
  type TeammateCost,
  type ToolCount,
  teammateDecisions,
  teammateRefusals,
} from "../storage/teammate-metrics-store";

/*
 * Teammate metrics: pure, read-only queries over schema v8. Sources (nothing is invented):
 *  - decisions: `effect_log` rows written by `teammateCall` for every successful state-changing teammate tool call
 *    (`scope = 'teammate tool call'`, `tool` = the typed tool). Plain text answers and read-only tools leave no row: omitted.
 *  - refusals: `thread_events` the teammate wrote for a refused call (event id holds `:refused:`), by tool and refusal `code`.
 *  - envelope blocks: `effect_log` rows of the effect tools whose `result` JSON says refused / denied, by tool and code.
 *  - cost: `runs.cost_usd` joined to `turns.started_at`, per local day, with the teammate's own share.
 */

/** Everything `metrics:teammate` prints. */
export interface TeammateMetrics {
  sinceMs: number;
  decisions: ToolCount[];
  refusals: ToolCount[];
  envelopeBlocks: ToolCount[];
  costPerDay: DayCost[];
  costPerTeammate: TeammateCost[];
}

/** All metrics of the last `days` days. */
export function teammateMetrics(db: Database, days: number, now = Date.now()): TeammateMetrics {
  const sinceMs = now - days * 86_400_000;
  return {
    sinceMs,
    decisions: teammateDecisions(db, sinceMs),
    refusals: teammateRefusals(db, sinceMs),
    envelopeBlocks: envelopeBlocks(db, sinceMs),
    costPerDay: costPerDay(db, CHIEF_OF_STAFF_ROLE.name, sinceMs),
    costPerTeammate: costPerTeammate(db, sinceMs),
  };
}

/** One section as text lines: `  Tool [code]  n`, or `  (none)`. */
const section = (title: string, rows: ToolCount[]): string[] => [
  title,
  ...(rows.length
    ? rows.map((r) => `  ${r.tool ?? "?"}${r.code ? ` [${r.code}]` : ""}  ${r.count}`)
    : ["  (none)"]),
];

/** Plain-text report. Answers and `refuse` as text have no stored source; the report says so. */
export function formatTeammateMetrics(m: TeammateMetrics, days: number): string {
  return [
    `Teammate metrics, last ${days} day(s)`,
    ...section("Decisions (successful teammate tool calls)", m.decisions),
    ...section("Refusals (teammate tool calls refused)", m.refusals),
    ...section("Envelope blocks (effect tools refused or denied)", m.envelopeBlocks),
    "Cost per day (USD, total / teammate)",
    ...(m.costPerDay.length
      ? m.costPerDay.map((d) => `  ${d.day}  ${d.totalUsd} / ${d.teammateUsd}`)
      : ["  (none)"]),
    "Cost per teammate (USD; default = channels without a teammate row)",
    ...(m.costPerTeammate.length
      ? m.costPerTeammate.map((c) => `  ${c.name ?? "default"}  ${c.totalUsd}`)
      : ["  (none)"]),
    "Not recorded (omitted): plain-text answers, read-only tool calls.",
  ].join("\n");
}
