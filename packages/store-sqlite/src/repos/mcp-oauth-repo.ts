import type { McpOAuthRecord, McpOAuthStore } from "@friday/core";
import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { mcpOAuth } from "../schema/engine-tables";

type Row = typeof mcpOAuth.$inferSelect;

/** Table row to domain record; empty columns become absent fields. */
const fromRow = (r: Row): McpOAuthRecord => ({
  server: r.server,
  serverUrl: r.serverUrl,
  clientId: r.clientId,
  refreshToken: r.refreshToken,
  ...(r.accessToken != null && { accessToken: r.accessToken }),
  ...(r.accessExpiresAt != null && { accessExpiresAt: r.accessExpiresAt }),
  status: r.status as McpOAuthRecord["status"],
  ...(r.lastRefreshAt != null && { lastRefreshAt: r.lastRefreshAt }),
  ...(r.lastError != null && { lastError: r.lastError }),
  updatedAt: r.updatedAt,
});

/** Domain record to table columns; absent optionals are stored as null so an upsert clears them. */
const toColumns = (r: McpOAuthRecord): typeof mcpOAuth.$inferInsert => ({
  ...r,
  accessToken: r.accessToken ?? null,
  accessExpiresAt: r.accessExpiresAt ?? null,
  lastRefreshAt: r.lastRefreshAt ?? null,
  lastError: r.lastError ?? null,
});

/** OAuth records of MCP servers, one row per server. */
export function mcpOAuthRepo(db: BunSQLiteDatabase): McpOAuthStore {
  return {
    async get(server) {
      const r = db.select().from(mcpOAuth).where(eq(mcpOAuth.server, server)).get();
      return r && fromRow(r);
    },
    async put(r) {
      const cols = toColumns(r);
      db.insert(mcpOAuth)
        .values(cols)
        .onConflictDoUpdate({ target: mcpOAuth.server, set: cols })
        .run();
    },
    async list() {
      return db.select().from(mcpOAuth).all().map(fromRow);
    },
  };
}
