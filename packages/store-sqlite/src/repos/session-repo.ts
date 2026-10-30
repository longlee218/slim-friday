import type { SessionStateHashes, Store } from "@friday/core";
import { eq, like, or } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { sessions } from "../schema/engine-tables";

/**
 * The SDK session id per session key: `<botId>` (direct), `<botId>@<groupId>` (group) or
 * `<botId>#ticket@<groupId>` (ticket). Ids never contain `@`, `#`, `%` or `_`, so the LIKE patterns below are safe.
 */
export function sessionRepo(db: BunSQLiteDatabase): Store["sessions"] {
  return {
    async get(key) {
      return db.select().from(sessions).where(eq(sessions.botId, key)).get()?.sessionId;
    },
    // A different session id resets the hashes (the new session has been shown nothing).
    async set(key, sessionId) {
      const prev = db.select().from(sessions).where(eq(sessions.botId, key)).get()?.sessionId;
      const set = prev === sessionId ? { sessionId } : { sessionId, stateHashes: null };
      db.insert(sessions)
        .values({ botId: key, sessionId })
        .onConflictDoUpdate({ target: sessions.botId, set })
        .run();
    },
    async stateGet(key) {
      const raw = db.select().from(sessions).where(eq(sessions.botId, key)).get()?.stateHashes;
      return raw ? (JSON.parse(raw) as SessionStateHashes) : undefined;
    },
    async stateSet(key, hashes) {
      db.update(sessions)
        .set({ stateHashes: JSON.stringify(hashes) })
        .where(eq(sessions.botId, key))
        .run();
    },
    async clear(key) {
      db.delete(sessions).where(eq(sessions.botId, key)).run();
    },
    // The direct key and every group and ticket key of the bot; `ab` is not matched by `a@%` or `a#%`.
    async clearBot(botId) {
      db.delete(sessions)
        .where(
          or(
            eq(sessions.botId, botId),
            like(sessions.botId, `${botId}@%`),
            like(sessions.botId, `${botId}#%`),
          ),
        )
        .run();
    },
    // Every key that ends with `@<groupId>`: group-chat and ticket keys of the group.
    async clearGroup(groupId) {
      db.delete(sessions)
        .where(like(sessions.botId, `%@${groupId}`))
        .run();
    },
  };
}
