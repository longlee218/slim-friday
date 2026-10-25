import type { Author, Store, WakeRow } from "@friday/core";
import { and, asc, desc, eq, gte, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { wakes } from "../schema/engine-tables";
import { runClaim } from "./run-claim";
import { reconcileReads } from "./wake-reconcile-reads";

type Row = typeof wakes.$inferSelect;

/** Statuses of a wake still to be delivered or being delivered (`leased` and `waiting_input` are not: `open` is the old restart recovery). */
const OPEN = ["queued", "running"];
/** Every status that is not finished: never pruned. */
const ACTIVE = ["queued", "leased", "running", "waiting_input"];

const toAuthor = (r: Row): Author =>
  r.senderKind === "bot" && r.senderBotId
    ? { kind: "bot", botId: r.senderBotId }
    : { kind: r.senderKind === "system" ? "system" : "user" };

/** Table row to domain row; empty columns become absent fields. */
export function fromRow(r: Row): WakeRow {
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
    ...(r.ticketId && { ticketId: r.ticketId }),
    ...(r.rewake && { rewake: true }),
    status: r.status as WakeRow["status"],
    ...(r.blockReason && { blockReason: r.blockReason as WakeRow["blockReason"] }),
    attempts: r.attempts,
    createdAt: r.createdAt,
    ...(r.startedAt != null && { startedAt: r.startedAt }),
    ...(r.firstTextAt != null && { firstTextAt: r.firstTextAt }),
    ...(r.endedAt != null && { endedAt: r.endedAt }),
    scopeKey: r.scopeKey,
    priority: r.priority as WakeRow["priority"],
    ...(r.leaseOwner && { leaseOwner: r.leaseOwner }),
    leaseFence: r.leaseFence,
    ...(r.leaseExpiresAt != null && { leaseExpiresAt: r.leaseExpiresAt }),
    ...(r.wakeAt != null && { wakeAt: r.wakeAt }),
    ...(r.cardId && { cardId: r.cardId }),
    ...(r.tainted != null && { tainted: r.tainted }),
    ...(r.resultText != null && { resultText: r.resultText }),
    ...(r.error != null && { error: r.error }),
    ...(r.outcomeReturnedAt != null && { outcomeReturnedAt: r.outcomeReturnedAt }),
    ...(r.dedupeKey != null && { dedupeKey: r.dedupeKey }),
    cuts: r.cuts,
    transientRetries: r.transientRetries,
    setupFailures: r.setupFailures,
    nudges: r.nudges,
    ...(r.intro && { intro: true }),
    ...(r.quote && { quote: JSON.parse(r.quote) }),
  };
}

/** Domain fields to table columns (only the keys present, so a patch changes only what it names). */
export function toColumns(w: Partial<WakeRow>): Partial<typeof wakes.$inferInsert> {
  // `claimedFrom` is never stored: it only tells the executor what the claim found.
  const {
    sender,
    attachments,
    parentWakeId,
    blockReason,
    handoff,
    quote,
    claimedFrom: _claimed,
    ...rest
  } = w;
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
    ...(quote && { quote: JSON.stringify(quote) }),
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
    async waiting() {
      return db
        .select()
        .from(wakes)
        .where(eq(wakes.status, "waiting_input"))
        .orderBy(asc(wakes.createdAt), asc(wakes.id))
        .all()
        .map(fromRow);
    },
    async insertDeduped(w) {
      // The unique index is the arbiter, so a racing second insert cannot slip through.
      const added = db
        .insert(wakes)
        .values(toColumns(w) as typeof wakes.$inferInsert)
        .onConflictDoNothing({ target: [wakes.conversationId, wakes.dedupeKey] })
        .returning({ id: wakes.id })
        .all();
      if (added.length) return { inserted: true as const };
      const existing = db
        .select()
        .from(wakes)
        .where(
          and(eq(wakes.conversationId, w.conversationId), eq(wakes.dedupeKey, w.dedupeKey ?? "")),
        )
        .get();
      if (!existing) throw new Error(`wake ${w.id} conflicts but no row has its dedupe key`);
      return { inserted: false as const, existing: fromRow(existing) };
    },
    ...runClaim(db),
    async list(f) {
      return db
        .select()
        .from(wakes)
        .where(
          and(gte(wakes.createdAt, f.since), f.status ? eq(wakes.status, f.status) : undefined),
        )
        .orderBy(desc(wakes.createdAt), desc(wakes.id))
        .limit(f.limit)
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
    ...reconcileReads(db),
    async deleteFinishedBefore(at) {
      // A row that never recorded an end time counts from its creation.
      return db
        .delete(wakes)
        .where(
          and(
            notInArray(wakes.status, ACTIVE),
            or(lt(wakes.endedAt, at), and(sql`${wakes.endedAt} IS NULL`, lt(wakes.createdAt, at))),
          ),
        )
        .returning({ id: wakes.id })
        .all().length;
    },
  };
}
