import type { Author, Store, TicketEvent } from "@friday/core";
import { asc, eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { ticketEvents } from "../schema/engine-tables";

/** Insert one history row; `db` may be a transaction, so callers can write it with a ticket change. */
export function insertTicketEvent(db: Pick<BunSQLiteDatabase, "insert">, e: TicketEvent): void {
  db.insert(ticketEvents)
    .values({
      id: e.id,
      ticketId: e.ticketId,
      kind: e.kind,
      fromValue: e.from ?? null,
      toValue: e.to ?? null,
      actorKind: e.actor.kind,
      actorBotId: e.actor.kind === "bot" ? e.actor.botId : null,
      at: e.at,
    })
    .run();
}

/** The history of ticket changes. */
export function ticketEventRepo(db: BunSQLiteDatabase): Store["ticketEvents"] {
  return {
    async append(e) {
      insertTicketEvent(db, e);
    },
    async list(ticketId) {
      return (
        db
          .select()
          .from(ticketEvents)
          .where(eq(ticketEvents.ticketId, ticketId))
          // `rowid` keeps the insert order for events of the same millisecond.
          .orderBy(asc(ticketEvents.at), sql`rowid`)
          .all()
          .map((r): TicketEvent => {
            const actor: Author =
              r.actorKind === "bot" && r.actorBotId
                ? { kind: "bot", botId: r.actorBotId }
                : { kind: r.actorKind === "system" ? "system" : "user" };
            return {
              id: r.id,
              ticketId: r.ticketId,
              kind: r.kind as TicketEvent["kind"],
              ...(r.fromValue != null && { from: r.fromValue }),
              ...(r.toValue != null && { to: r.toValue }),
              actor,
              at: r.at,
            };
          })
      );
    },
  };
}
