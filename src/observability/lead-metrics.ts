import type { Database } from "bun:sqlite";
import { LEAD_ROLE } from "../roles/builtin/lead-role";
import {
  costPerDay,
  type DayCost,
  envelopeBlocks,
  leadDecisions,
  leadRefusals,
  type ToolCount,
} from "../storage/lead-metrics-store";

/*
 * Lead metrics: pure, read-only queries over schema v8. Sources (nothing is invented):
 *  - decisions: `effect_log` rows written by `leadCall` for every successful state-changing lead tool call
 *    (`scope = 'lead tool call'`, `tool` = the typed tool). Plain text answers and read-only tools leave no row: omitted.
 *  - refusals: `thread_events` the lead wrote for a refused call (event id holds `:refused:`), by tool and refusal `code`.
 *  - envelope blocks: `effect_log` rows of the effect tools whose `result` JSON says refused / denied, by tool and code.
 *  - cost: `runs.cost_usd` joined to `turns.started_at`, per local day, with the lead's own share.
 */

/** Everything `metrics:lead` prints. */
export interface LeadMetrics {
  sinceMs: number;
  decisions: ToolCount[];
  refusals: ToolCount[];
  envelopeBlocks: ToolCount[];
  costPerDay: DayCost[];
}

/** All metrics of the last `days` days. */
export function leadMetrics(db: Database, days: number, now = Date.now()): LeadMetrics {
  const sinceMs = now - days * 86_400_000;
  return {
    sinceMs,
    decisions: leadDecisions(db, sinceMs),
    refusals: leadRefusals(db, sinceMs),
    envelopeBlocks: envelopeBlocks(db, sinceMs),
    costPerDay: costPerDay(db, LEAD_ROLE.name, sinceMs),
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
export function formatLeadMetrics(m: LeadMetrics, days: number): string {
  return [
    `Lead metrics, last ${days} day(s)`,
    ...section("Decisions (successful lead tool calls)", m.decisions),
    ...section("Refusals (lead tool calls refused)", m.refusals),
    ...section("Envelope blocks (effect tools refused or denied)", m.envelopeBlocks),
    "Cost per day (USD, total / lead)",
    ...(m.costPerDay.length
      ? m.costPerDay.map((d) => `  ${d.day}  ${d.totalUsd} / ${d.leadUsd}`)
      : ["  (none)"]),
    "Not recorded (omitted): plain-text answers, read-only tool calls.",
  ].join("\n");
}
