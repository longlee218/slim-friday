import type { Author, Store, WakeRow } from "@friday/core";
import { and, asc, eq, gte, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { wakes } from "../schema/engine-tables";

type Row = typeof wakes.$inferSelect;

/** Statuses of a wake still to be delivered or being delivered. */
const OPEN = ["queued", "running"];

const toAuthor = (r: Row): Author =>
  r.senderKind === "bot" && r.senderBotId
    ? { kind: "bot", botId: r.senderBotId }
    : { kind: r.senderKind === "system" ? "system" : "user" };

/** Table row to domain row; empty columns become absent fields. */
function fromRow(r: Row): WakeRow {
  return {
    id: r.id,
    chainId: r.chainId,
    ...(r.parentWakeId && { parentWakeId: r.parentWakeId }),
    conversationId: r.conversationId,
    targetBot: r.targetBot,
    sender: toAuthor(r),
    intent: r.intent as WakeRow["intent"],
    hop: r.hop,
    text: r.text,
    ...(r.attachments && { attachments: JSON.parse(r.attachments) }),
    ...(r.handoff && { handoff: true }),
    status: r.status as WakeRow["status"],
    ...(r.blockReason && { blockReason: r.blockReason as WakeRow["blockReason"] }),
    attempts: r.attempts,
    createdAt: r.createdAt,
    ...(r.startedAt != null && { startedAt: r.startedAt }),
    ...(r.firstTextAt != null && { firstTextAt: r.firstTextAt }),
    ...(r.endedAt != null && { endedAt: r.endedAt }),
  };
}

/** Domain fields to table columns (only the keys present, so a patch changes only what it names). */
function toColumns(w: Partial<WakeRow>): Partial<typeof wakes.$inferInsert> {
  const { sender, attachments, parentWakeId, blockReason, handoff, ...rest } = w;
  return {
    ...rest,
    ...(sender && {
      senderKind: sender.kind,
      senderBotId: sender.kind === "bot" ? sender.botId : null,
    }),
    ...(attachments && { attachments: JSON.stringify(attachments) }),
    ...(parentWakeId !== undefined && { parentWakeId }),
    ...(blockReason !== undefined && { blockReason }),
    ...(handoff !== undefined && { handoff }),
  };
}

/** The wake log: one row per message sent into a bot session. */
export function wakeRepo(db: BunSQLiteDatabase): Store["wakes"] {
  return {
    async insert(w) {
      db.insert(wakes)
        .values(toColumns(w) as typeof wakes.$inferInsert)
        .run();
    },
    async update(id, patch) {
      const cols = toColumns(patch);
      if (Object.keys(cols).length) db.update(wakes).set(cols).where(eq(wakes.id, id)).run();
    },
    async get(id) {
      const r = db.select().from(wakes).where(eq(wakes.id, id)).get();
      return r && fromRow(r);
    },
    async open() {
      return db
        .select()
        .from(wakes)
        .where(inArray(wakes.status, OPEN))
        .orderBy(asc(wakes.createdAt), asc(wakes.id))
        .all()
        .map(fromRow);
    },
    async botSentSince(conversationId, since) {
      return db
        .select()
        .from(wakes)
        .where(
          and(
            eq(wakes.conversationId, conversationId),
            eq(wakes.senderKind, "bot"),
            gte(wakes.createdAt, since),
          ),
        )
        .orderBy(asc(wakes.createdAt), asc(wakes.id))
        .all()
        .map(fromRow);
    },
    async deleteFinishedBefore(at) {
      // A row that never recorded an end time counts from its creation.
      return db
        .delete(wakes)
        .where(
          and(
            notInArray(wakes.status, OPEN),
            or(lt(wakes.endedAt, at), and(sql`${wakes.endedAt} IS NULL`, lt(wakes.createdAt, at))),
          ),
        )
        .returning({ id: wakes.id })
        .all().length;
    },
  };
}
