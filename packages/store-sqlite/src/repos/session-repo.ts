import type { Store } from "@friday/core";
import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { sessions } from "../schema/engine-tables";

/** The SDK session id of each bot. */
export function sessionRepo(db: BunSQLiteDatabase): Store["sessions"] {
  return {
    async get(botId) {
      return db.select().from(sessions).where(eq(sessions.botId, botId)).get()?.sessionId;
    },
    async set(botId, sessionId) {
      db.insert(sessions)
        .values({ botId, sessionId })
        .onConflictDoUpdate({ target: sessions.botId, set: { sessionId } })
        .run();
    },
    async clear(botId) {
      db.delete(sessions).where(eq(sessions.botId, botId)).run();
    },
  };
}
