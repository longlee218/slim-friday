import type { Store } from "@friday/core";
import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { runAttempts } from "../schema/engine-tables";

/** The attempts of runs: one row per try of a run by one worker under one fence. */
export function attemptRepo(db: BunSQLiteDatabase): Store["attempts"] {
  return {
    async start(a) {
      db.insert(runAttempts)
        .values({ ...a, status: "running" })
        .run();
    },
    async finish(id, status, at, error) {
      db.update(runAttempts)
        .set({ status, endedAt: at, ...(error !== undefined && { error }) })
        .where(eq(runAttempts.id, id))
        .run();
    },
  };
}
