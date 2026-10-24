import type { Store } from "@friday/core";
import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { effectCalls } from "../schema/engine-tables";

/** Records of side-effect calls, keyed by idempotency key. */
export function effectCallRepo(db: BunSQLiteDatabase): Store["effects"] {
  return {
    async begin(key, wakeId, tool, at) {
      // One INSERT decides who is first; a conflict means the key already exists.
      const inserted = db
        .insert(effectCalls)
        .values({ key, wakeId, tool, state: "started", startedAt: at })
        .onConflictDoNothing({ target: effectCalls.key })
        .returning({ key: effectCalls.key })
        .all();
      if (inserted.length) return { state: "new" };
      const row = db.select().from(effectCalls).where(eq(effectCalls.key, key)).get();
      return row?.state === "done"
        ? { state: "done", result: row.result ?? "" }
        : { state: "started" };
    },
    async finish(key, result, at) {
      db.update(effectCalls)
        .set({ state: "done", result, finishedAt: at })
        .where(eq(effectCalls.key, key))
        .run();
    },
  };
}
