import type { Schedule, Store } from "@friday/core";
import { and, asc, eq, inArray, isNotNull, lt, lte } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { scheduleRuns, schedules } from "../schema/engine-tables";

type Row = typeof schedules.$inferSelect;

/** Table row to domain row; empty columns become absent fields. */
function fromRow(r: Row): Schedule {
  return {
    id: r.id,
    name: r.name,
    botId: r.botId,
    task: r.task,
    rule: JSON.parse(r.rule),
    timeZone: r.timeZone,
    conversationId: r.conversationId,
    notify: r.notify as Schedule["notify"],
    enabled: r.enabled,
    ...(r.nextRunAt != null && { nextRunAt: r.nextRunAt }),
    ...(r.lastFireAt != null && { lastFireAt: r.lastFireAt }),
    ...(r.disabledReason && { disabledReason: r.disabledReason as Schedule["disabledReason"] }),
    createdBy: JSON.parse(r.createdBy),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Domain fields to table columns (only the keys present, so a patch changes only what it names). */
function toColumns(s: Partial<Schedule>): Partial<typeof schedules.$inferInsert> {
  const { rule, createdBy, nextRunAt, lastFireAt, disabledReason, ...rest } = s;
  return {
    ...rest,
    ...(rule && { rule: JSON.stringify(rule) }),
    ...(createdBy && { createdBy: JSON.stringify(createdBy) }),
    // An explicit `undefined` clears the column, an absent key leaves it.
    ...("nextRunAt" in s && { nextRunAt: nextRunAt ?? null }),
    ...("lastFireAt" in s && { lastFireAt: lastFireAt ?? null }),
    ...("disabledReason" in s && { disabledReason: disabledReason ?? null }),
  };
}

/** Schedules of bot runs; removing one also removes its runs. */
export function scheduleRepo(db: BunSQLiteDatabase): Store["schedules"] {
  return {
    async list(f) {
      return db
        .select()
        .from(schedules)
        .where(
          and(
            f?.botId ? eq(schedules.botId, f.botId) : undefined,
            f?.conversationId ? eq(schedules.conversationId, f.conversationId) : undefined,
          ),
        )
        .orderBy(asc(schedules.createdAt), asc(schedules.id))
        .all()
        .map(fromRow);
    },
    async get(id) {
      const r = db.select().from(schedules).where(eq(schedules.id, id)).get();
      return r && fromRow(r);
    },
    async insert(s) {
      db.insert(schedules)
        .values(toColumns(s) as typeof schedules.$inferInsert)
        .run();
    },
    async update(id, patch) {
      const cols = toColumns(patch);
      if (Object.keys(cols).length)
        db.update(schedules).set(cols).where(eq(schedules.id, id)).run();
      const r = db.select().from(schedules).where(eq(schedules.id, id)).get();
      return r && fromRow(r);
    },
    async advance(id, expectedNext, patch) {
      // The guard on next_run_at makes a second ticker (or a racing manual run) lose.
      const done = db
        .update(schedules)
        .set(toColumns(patch))
        .where(and(eq(schedules.id, id), eq(schedules.nextRunAt, expectedNext)))
        .returning({ id: schedules.id })
        .all();
      return done.length > 0;
    },
    async due(now) {
      return db
        .select()
        .from(schedules)
        .where(
          and(
            eq(schedules.enabled, true),
            isNotNull(schedules.nextRunAt),
            lte(schedules.nextRunAt, now),
          ),
        )
        .orderBy(asc(schedules.nextRunAt), asc(schedules.id))
        .all()
        .map(fromRow);
    },
    async remove(id) {
      db.delete(scheduleRuns).where(eq(scheduleRuns.scheduleId, id)).run();
      return (
        db.delete(schedules).where(eq(schedules.id, id)).returning({ id: schedules.id }).all()
          .length > 0
      );
    },
    async removeDisabledBefore(reasons, at) {
      if (!reasons.length) return 0;
      const gone = db
        .select({ id: schedules.id })
        .from(schedules)
        .where(
          and(
            eq(schedules.enabled, false),
            inArray(schedules.disabledReason, reasons),
            lt(schedules.updatedAt, at),
          ),
        )
        .all()
        .map((r) => r.id);
      if (!gone.length) return 0;
      db.delete(scheduleRuns).where(inArray(scheduleRuns.scheduleId, gone)).run();
      db.delete(schedules).where(inArray(schedules.id, gone)).run();
      return gone.length;
    },
  };
}
