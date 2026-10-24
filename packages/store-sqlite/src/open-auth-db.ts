import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openEngineDb } from "./open-engine-db";
import { authSchema } from "./schema/auth-tables";

/** The better-auth side of the engine db: a drizzle handle over the auth tables. */
export interface AuthDb {
  /** Drizzle handle for the better-auth drizzle adapter. */
  db: BunSQLiteDatabase<typeof authSchema>;
  /** Tables keyed by better-auth model name. */
  schema: typeof authSchema;
  /** True when the db answers `SELECT 1`; false (never throws) otherwise, e.g. after `close()`. */
  ping(): boolean;
  /** Close the db. */
  close(): void;
}

/** Open the engine db at `file` (same migrations and file rules) and serve the auth tables. */
export function openAuthDb(file: string): AuthDb {
  const client = openEngineDb(file);
  return {
    db: drizzle({ client, schema: authSchema }),
    schema: authSchema,
    ping() {
      try {
        client.query("SELECT 1").get();
        return true;
      } catch {
        return false;
      }
    },
    close: () => client.close(),
  };
}
