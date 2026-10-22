import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { readAppLogLines } from "../../src/observability/skills-metrics";
import { AGENT_HOME } from "./db";

/** One skill as the Skill tool called it, per role. */
interface SkillCallRow {
  skill: string;
  role: string;
  calls: number;
  runs: number;
  last_at: number;
}

/** Per role: runs logged with a skill list, and for each offered skill how many of those runs called it. */
interface RoleOffer {
  role: string;
  runs: number;
  offered: Record<string, { offered: number; called: number }>;
}

/**
 * Skill use since `since` from two sources: `tool_calls` (every Skill call, with its role) and the app log's
 * `skills.used` lines (what each run was offered and what it called), so a skill offered and never called shows too.
 */
export function skillUsage(db: Database, since: number) {
  const calls = db
    .query<SkillCallRow, [number]>(
      `SELECT json_extract(c.input_json, '$.skill') AS skill, t.role, COUNT(*) AS calls,
         COUNT(DISTINCT c.turn_id) AS runs, MAX(t.started_at) AS last_at
       FROM tool_calls c JOIN turns t ON t.id = c.turn_id
       WHERE c.tool = 'Skill' AND t.started_at >= ? AND json_valid(c.input_json)
       GROUP BY skill, t.role ORDER BY calls DESC`,
    )
    .all(since)
    .filter((r) => r.skill);

  const offers = new Map<string, RoleOffer>();
  for (const line of readAppLogLines(join(AGENT_HOME, "logs", "app"))) {
    if (!line.includes('"skills.used"')) continue;
    let e: { event?: string; time?: number; role?: string; available?: string[]; called?: string[] };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.event !== "skills.used" || !e.role || (e.time ?? 0) < since) continue;
    const r = offers.get(e.role) ?? { role: e.role, runs: 0, offered: {} };
    r.runs++;
    for (const s of e.available ?? []) {
      const o = r.offered[s] ?? { offered: 0, called: 0 };
      o.offered++;
      if (e.called?.includes(s)) o.called++;
      r.offered[s] = o;
    }
    offers.set(e.role, r);
  }
  return { calls, offers: [...offers.values()].sort((a, b) => b.runs - a.runs) };
}
