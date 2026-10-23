import type { Grant, Store } from "@friday/core";
import { eq, inArray } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { grants } from "../schema/engine-tables";

/** "Always allow" grants. `list` includes the grants for every bot (`*`); expired rows too (core checks expiry). */
export function grantRepo(db: BunSQLiteDatabase): Store["grants"] {
  return {
    async list(botId) {
      return db
        .select()
        .from(grants)
        .where(inArray(grants.botId, [botId, "*"]))
        .all()
        .map(
          (r): Grant => ({
            id: r.id,
            botId: r.botId,
            tool: r.tool,
            scope: JSON.parse(r.scope) as Record<string, string>,
            createdAt: r.createdAt,
            ...(r.expiresAt !== null && { expiresAt: r.expiresAt }),
          }),
        );
    },
    async add(g) {
      db.insert(grants)
        .values({
          id: g.id,
          botId: g.botId,
          tool: g.tool,
          scope: JSON.stringify(g.scope),
          createdAt: g.createdAt,
          expiresAt: g.expiresAt ?? null,
        })
        .run();
    },
    async revoke(id) {
      db.delete(grants).where(eq(grants.id, id)).run();
    },
  };
}
