import type { Grant, RuleEffect, RuleMatch, Store } from "@friday/core";
import { asc, eq, inArray } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { grants } from "../schema/engine-tables";

/** The effects and match kinds this build knows. */
const EFFECTS: readonly string[] = ["always_allow", "require_approval"] satisfies RuleEffect[];
const MATCHES: readonly string[] = ["site", "tool", "server", "category"] satisfies RuleMatch[];

/** One stored row as an owner rule; a row with an unknown effect or match kind is no rule (skipped). */
function toGrant(r: typeof grants.$inferSelect): Grant[] {
  if (!EFFECTS.includes(r.effect) || !MATCHES.includes(r.matchKind)) return [];
  return [
    {
      id: r.id,
      botId: r.botId,
      effect: r.effect as RuleEffect,
      match: r.matchKind as RuleMatch,
      tool: r.tool,
      scope: JSON.parse(r.scope) as Record<string, string>,
      createdAt: r.createdAt,
      ...(r.expiresAt !== null && { expiresAt: r.expiresAt }),
    },
  ];
}

/** Owner rules (spec §6.14). `list` includes the rules for every bot (`*`); expired rows too (core checks expiry). */
export function grantRepo(db: BunSQLiteDatabase): Store["grants"] {
  return {
    async list(botId) {
      return db
        .select()
        .from(grants)
        .where(inArray(grants.botId, [botId, "*"]))
        .all()
        .flatMap(toGrant);
    },
    async all() {
      return db
        .select()
        .from(grants)
        .orderBy(asc(grants.createdAt), asc(grants.id))
        .all()
        .flatMap(toGrant);
    },
    async add(g) {
      db.insert(grants)
        .values({
          id: g.id,
          botId: g.botId,
          effect: g.effect,
          matchKind: g.match,
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
    async setEffect(id, effect) {
      db.update(grants).set({ effect }).where(eq(grants.id, id)).run();
    },
  };
}
