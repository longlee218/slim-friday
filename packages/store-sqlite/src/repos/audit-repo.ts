import type { AuditEntry, Store } from "@friday/core";
import { desc, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { audit } from "../schema/engine-tables";

/** One row per permission decision. */
export function auditRepo(db: BunSQLiteDatabase): Store["audit"] {
  return {
    async append(e) {
      db.insert(audit)
        .values({
          at: e.at,
          botId: e.botId,
          tool: e.tool,
          outcome: e.outcome,
          answer: e.answer ?? null,
          reason: e.reason,
        })
        .run();
    },
    async recent({ toolPrefix, limit }) {
      const n = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 1));
      // substr, not LIKE: `_` and `%` in a prefix such as `mcp__gh__` must not act as wildcards.
      const rows = db
        .select()
        .from(audit)
        .where(sql`substr(${audit.tool}, 1, length(${toolPrefix})) = ${toolPrefix}`)
        .orderBy(desc(audit.at), desc(audit.id))
        .limit(n)
        .all();
      return rows.map(
        (r): AuditEntry => ({
          at: r.at,
          botId: r.botId,
          tool: r.tool,
          outcome: r.outcome as AuditEntry["outcome"],
          ...(r.answer !== null && { answer: r.answer as AuditEntry["answer"] }),
          reason: r.reason,
        }),
      );
    },
  };
}
