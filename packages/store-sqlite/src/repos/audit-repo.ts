import type { Store } from "@friday/core";
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
  };
}
