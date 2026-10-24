import type { Store } from "@friday/core";
import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { runAttempts } from "../schema/engine-tables";

/** The attempts of runs: one row per try of a run by one worker under one fence. */
export function attemptRepo(db: BunSQLiteDatabase): Store["attempts"] {
  return {
    /** Record a new attempt as `running`. */
    async start(a) {
      db.insert(runAttempts)
        .values({ ...a, status: "running" })
        .run();
    },
    /** Close an attempt with its final status, end time and optional error. */
    async finish(id, status, at, error) {
      db.update(runAttempts)
        .set({ status, endedAt: at, ...(error !== undefined && { error }) })
        .where(eq(runAttempts.id, id))
        .run();
    },
  };
}
