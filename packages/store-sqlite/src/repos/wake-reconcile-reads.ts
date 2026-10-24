import type { Store, WakeCursor } from "@friday/core";
import { and, asc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { wakes } from "../schema/engine-tables";
import { fromRow } from "./wake-repo";

/** Statuses of a finished run whose result or failure goes back to the bot that sent the work. */
const RETURNING = ["done", "failed", "interrupted", "cancelled", "expired", "dropped"];

/** Rows after a batch cursor (creation time, then id). */
const after = (c?: WakeCursor) =>
  c
    ? or(
        gt(wakes.createdAt, c.createdAt),
        and(eq(wakes.createdAt, c.createdAt), gt(wakes.id, c.id)),
      )
    : undefined;

/** The wake reads the outcome reconciler uses (bounded, cursor based). */
export function reconcileReads(
  db: BunSQLiteDatabase,
): Pick<Store["wakes"], "pendingOutcomes" | "staleHeld"> {
  return {
    async pendingOutcomes(limit, cursor) {
      return db
        .select()
        .from(wakes)
        .where(
          and(
            inArray(wakes.status, RETURNING),
            isNull(wakes.outcomeReturnedAt),
            eq(wakes.senderKind, "bot"),
            inArray(wakes.intent, ["request", "question"]),
            or(isNull(wakes.handoff), eq(wakes.handoff, false)),
            after(cursor),
          ),
        )
        .orderBy(asc(wakes.createdAt), asc(wakes.id))
        .limit(limit)
        .all()
        .map(fromRow);
    },
    async staleHeld(holdUntil, before, limit, cursor) {
      return db
        .select()
        .from(wakes)
        .where(
          and(
            eq(wakes.status, "queued"),
            eq(wakes.wakeAt, holdUntil),
            lt(wakes.createdAt, before),
            after(cursor),
          ),
        )
        .orderBy(asc(wakes.createdAt), asc(wakes.id))
        .limit(limit)
        .all()
        .map(fromRow);
    },
  };
}
