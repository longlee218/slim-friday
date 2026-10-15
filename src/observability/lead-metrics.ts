import type { Database } from "bun:sqlite";
import { LEAD_ROLE } from "../roles/builtin/lead-role";

/*
 * Lead metrics: pure, read-only queries over schema v8. Sources (nothing is invented):
 *  - decisions: `effect_log` rows written by `leadCall` for every successful state-changing lead tool call
 *    (`scope = 'lead tool call'`, `tool` = the typed tool). Plain text answers and read-only tools leave no row: omitted.
 *  - refusals: `thread_events` the lead wrote for a refused call (event id holds `:refused:`), by tool and refusal `code`.
 *  - envelope blocks: `effect_log` rows of the effect tools whose `result` JSON says refused / denied, by tool and code.
 *  - cost: `runs.cost_usd` joined to `turns.started_at`, per local day, with the lead's own share.
 */

/** Scope text `leadCall` stamps on the audit row of a lead tool call. */
const LEAD_CALL_SCOPE = "lead tool call";

/** A count of something per tool (and per code when it has one). */
export interface ToolCount {
  tool: string;
  code?: string;
  count: number;
}

/** Spend of one local day. */
export interface DayCost {
  day: string;
  totalUsd: number;
  leadUsd: number;
}

/** Everything `metrics:lead` prints. */
export interface LeadMetrics {
  sinceMs: number;
  decisions: ToolCount[];
  refusals: ToolCount[];
  envelopeBlocks: ToolCount[];
  costPerDay: DayCost[];
}

/** Successful lead tool calls since `sinceMs`, by tool. */
export function leadDecisions(db: Database, sinceMs: number): ToolCount[] {
  return db
    .query<ToolCount, [string, number]>(
      `SELECT tool, COUNT(*) AS count FROM effect_log
       WHERE scope = ? AND created_at >= ? GROUP BY tool ORDER BY count DESC, tool`,
    )
    .all(LEAD_CALL_SCOPE, sinceMs);
}

/** Refused lead tool calls since `sinceMs`, by tool and refusal code (events carry `by: "lead"` and `tool`). */
export function leadRefusals(db: Database, sinceMs: number): ToolCount[] {
  return db
    .query<ToolCount, [number]>(
      `SELECT json_extract(payload, '$.tool') AS tool, json_extract(payload, '$.code') AS code, COUNT(*) AS count
       FROM thread_events
       WHERE id LIKE '%:refused:%' AND json_extract(payload, '$.by') = 'lead' AND created_at >= ?
       GROUP BY tool, code ORDER BY count DESC, tool`,
    )
    .all(sinceMs);
}

/** Effect-tool calls the envelope refused or the owner denied since `sinceMs`, by tool and code. */
export function envelopeBlocks(db: Database, sinceMs: number): ToolCount[] {
  return db
    .query<ToolCount, [string, number]>(
      `SELECT tool, json_extract(result, '$.code') AS code, COUNT(*) AS count FROM effect_log
       WHERE scope != ? AND created_at >= ? AND json_valid(result)
         AND json_extract(result, '$.result') IN ('refused', 'denied')
       GROUP BY tool, code ORDER BY count DESC, tool`,
    )
    .all(LEAD_CALL_SCOPE, sinceMs);
}

/** Cost per local day since `sinceMs` (all roles, and the lead's share), newest day first. */
export function costPerDay(db: Database, sinceMs: number): DayCost[] {
  return db
    .query<DayCost, [string, number]>(
      `SELECT date(t.started_at / 1000, 'unixepoch', 'localtime') AS day,
              ROUND(SUM(r.cost_usd), 4) AS totalUsd,
              ROUND(SUM(CASE WHEN t.role = ? THEN r.cost_usd ELSE 0 END), 4) AS leadUsd
       FROM runs r JOIN turns t ON t.id = r.turn_id
       WHERE t.started_at >= ? GROUP BY day ORDER BY day DESC`,
    )
    .all(LEAD_ROLE.name, sinceMs);
}

/** All metrics of the last `days` days. */
export function leadMetrics(db: Database, days: number, now = Date.now()): LeadMetrics {
  const sinceMs = now - days * 86_400_000;
  return {
    sinceMs,
    decisions: leadDecisions(db, sinceMs),
    refusals: leadRefusals(db, sinceMs),
    envelopeBlocks: envelopeBlocks(db, sinceMs),
    costPerDay: costPerDay(db, sinceMs),
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
