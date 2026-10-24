import type { BotActivity, InsightStore, RunStat, TurnSummary } from "@friday/core";
import { sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

/** Wake states that mean the message never got a normal answer. */
const BAD_WAKES = ["blocked", "interrupted", "expired", "dropped"];

/** `YYYY-MM-DD` (UTC) of an epoch time: the `spend` table keys days this way. */
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Read-only views for reviewing bots, over the engine's own tables. Run steps are the JSON `RunStep[]` in
 * `messages.run`, unpacked with SQLite `json_each`; messages have no (author, at) index, which is fine at one owner's
 * volume.
 */
export function insightRepo(db: BunSQLiteDatabase): InsightStore {
  return {
    async runStats(botId, since) {
      return db.all<RunStat>(sql`
        SELECT json_extract(s.value, '$.kind') AS kind,
               CASE json_extract(s.value, '$.kind')
                 WHEN 'skill' THEN coalesce(json_extract(s.value, '$.target'), '?')
                 WHEN 'mcp' THEN coalesce(substr(json_extract(s.value, '$.target'), 1,
                                   instr(json_extract(s.value, '$.target'), ' · ') - 1), '?')
                 WHEN 'command' THEN 'Bash'
                 WHEN 'subagent' THEN 'Agent'
                 ELSE json_extract(s.value, '$.label')
               END AS name,
               count(*) AS uses,
               sum(json_extract(s.value, '$.state') = 'failed') AS failed,
               max(m.at) AS lastAt
        FROM messages m, json_each(m.run) s
        WHERE m.author_kind = 'bot' AND m.author_bot_id = ${botId} AND m.at >= ${since} AND m.run IS NOT NULL
        GROUP BY kind, name
        ORDER BY lastAt DESC, uses DESC`);
    },
    async turns(botId, since, limit) {
      return db.all<TurnSummary>(sql`
        SELECT m.id AS messageId,
               m.conversation_id AS conversationId,
               m.at AS at,
               count(*) AS steps,
               sum(json_extract(s.value, '$.state') = 'failed') AS failed,
               coalesce(max(json_extract(s.value, '$.endedAt')) - min(json_extract(s.value, '$.startedAt')), 0)
                 AS durationMs
        FROM messages m, json_each(m.run) s
        WHERE m.author_kind = 'bot' AND m.author_bot_id = ${botId} AND m.at >= ${since} AND m.run IS NOT NULL
        GROUP BY m.id
        ORDER BY m.at DESC, m.id DESC
        LIMIT ${limit}`);
    },
    async activity(since) {
      const bad = sql.join(
        BAD_WAKES.map((s) => sql`${s}`),
        sql`, `,
      );
      // One row per bot seen in any source; each source is summed on its own so the joins never multiply rows.
      return db.all<BotActivity>(sql`
        WITH
          msg AS (
            SELECT author_bot_id AS botId,
                   sum(run IS NOT NULL) AS turns,
                   sum(coalesce((SELECT count(*) FROM json_each(run) s
                                 WHERE json_extract(s.value, '$.state') = 'failed'), 0)) AS failedSteps,
                   max(at) AS lastAt
            FROM messages
            WHERE author_kind = 'bot' AND at >= ${since}
            GROUP BY author_bot_id),
          cost AS (SELECT bot_id AS botId, sum(usd) AS costUsd FROM spend WHERE day >= ${dayOf(since)} GROUP BY bot_id),
          wk AS (SELECT target_bot AS botId, count(*) AS badWakes FROM wakes
                 WHERE created_at >= ${since} AND status IN (${bad}) GROUP BY target_bot),
          tk AS (SELECT assignee_bot_id AS botId, count(*) AS blockedTickets FROM tickets
                 WHERE status = 'blocked' AND assignee_bot_id IS NOT NULL GROUP BY assignee_bot_id),
          ids AS (SELECT botId FROM msg UNION SELECT botId FROM cost UNION SELECT botId FROM wk UNION SELECT botId FROM tk)
        SELECT ids.botId AS botId,
               coalesce(msg.turns, 0) AS turns,
               coalesce(msg.failedSteps, 0) AS failedSteps,
               coalesce(msg.lastAt, 0) AS lastAt,
               coalesce(cost.costUsd, 0) AS costUsd,
               coalesce(wk.badWakes, 0) AS badWakes,
               coalesce(tk.blockedTickets, 0) AS blockedTickets
        FROM ids
        LEFT JOIN msg ON msg.botId = ids.botId
        LEFT JOIN cost ON cost.botId = ids.botId
        LEFT JOIN wk ON wk.botId = ids.botId
        LEFT JOIN tk ON tk.botId = ids.botId
        ORDER BY lastAt DESC`);
    },
  };
}
