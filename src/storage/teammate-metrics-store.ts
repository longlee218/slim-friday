import type { Database } from "bun:sqlite";

/* Read-only queries behind `metrics:teammate` (schema v8); the caller formats them (src/observability/teammate-metrics.ts). */

/** Scope text `teammateCall` stamps on the audit row of a teammate tool call. */
export const TEAMMATE_CALL_SCOPE = "teammate tool call";

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
  teammateUsd: number;
}

/** Successful teammate tool calls since `sinceMs`, by tool and action (`Orchestrate.<action>`). */
export function teammateDecisions(db: Database, sinceMs: number): ToolCount[] {
  return db
    .query<ToolCount, [string, number]>(
      `SELECT tool, COUNT(*) AS count FROM effect_log
       WHERE scope = ? AND created_at >= ? GROUP BY tool ORDER BY count DESC, tool`,
    )
    .all(TEAMMATE_CALL_SCOPE, sinceMs);
}

/** Refused teammate tool calls since `sinceMs`, by tool and refusal code (events carry `by: "teammate"`, `tool` and `action`; shown as `Orchestrate.<action>`). */
export function teammateRefusals(db: Database, sinceMs: number): ToolCount[] {
  return db
    .query<ToolCount, [number]>(
      `SELECT json_extract(payload, '$.tool') || COALESCE('.' || json_extract(payload, '$.action'), '') AS tool, json_extract(payload, '$.code') AS code, COUNT(*) AS count
       FROM thread_events
       WHERE id LIKE '%:refused:%' AND json_extract(payload, '$.by') = 'teammate' AND created_at >= ?
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
    .all(TEAMMATE_CALL_SCOPE, sinceMs);
}

/** Cost per local day since `sinceMs` (all roles, and the share of role `chiefOfStaffRole`), newest day first. */
export function costPerDay(db: Database, chiefOfStaffRole: string, sinceMs: number): DayCost[] {
  return db
    .query<DayCost, [string, number]>(
      `SELECT date(t.started_at / 1000, 'unixepoch', 'localtime') AS day,
              ROUND(SUM(r.cost_usd), 4) AS totalUsd,
              ROUND(SUM(CASE WHEN t.role = ? THEN r.cost_usd ELSE 0 END), 4) AS teammateUsd
       FROM runs r JOIN turns t ON t.id = r.turn_id
       WHERE t.started_at >= ? GROUP BY day ORDER BY day DESC`,
    )
    .all(chiefOfStaffRole, sinceMs);
}
