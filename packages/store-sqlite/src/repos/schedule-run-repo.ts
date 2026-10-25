import type { ScheduleRun, Store } from "@friday/core";
import { and, desc, eq, getTableColumns, inArray, lt, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { scheduleRuns } from "../schema/engine-tables";

/** Table row to domain row; empty columns become absent fields. */
function fromRow(r: typeof scheduleRuns.$inferSelect): ScheduleRun {
  return {
    id: r.id,
    scheduleId: r.scheduleId,
    dueAt: r.dueAt,
    firedAt: r.firedAt,
    manual: r.manual,
    late: r.late,
    status: r.status as ScheduleRun["status"],
    ...(r.wakeId && { wakeId: r.wakeId }),
    ...(r.endedAt != null && { endedAt: r.endedAt }),
    costUsd: r.costUsd,
    ...(r.error != null && { error: r.error }),
  };
}

/** One row per fire of a schedule. */
export function scheduleRunRepo(db: BunSQLiteDatabase): Store["scheduleRuns"] {
  return {
    async insert(r) {
      db.insert(scheduleRuns).values(r).run();
    },
    async update(id, patch) {
      if (Object.keys(patch).length)
        db.update(scheduleRuns).set(patch).where(eq(scheduleRuns.id, id)).run();
    },
    async open() {
      return db
        .select()
        .from(scheduleRuns)
        .where(eq(scheduleRuns.status, "running"))
        .all()
        .map(fromRow);
    },
    async addCost(wakeId, usd) {
      // One SQL step, so two turns of a wake finishing together both count.
      db.update(scheduleRuns)
        .set({ costUsd: sql`${scheduleRuns.costUsd} + ${usd}` })
        .where(eq(scheduleRuns.wakeId, wakeId))
        .run();
    },
    async list(scheduleId, limit, before) {
      return db
        .select()
        .from(scheduleRuns)
        .where(
          and(
            eq(scheduleRuns.scheduleId, scheduleId),
            before !== undefined ? lt(scheduleRuns.firedAt, before) : undefined,
          ),
        )
        .orderBy(desc(scheduleRuns.firedAt), desc(scheduleRuns.id))
        .limit(limit)
        .all()
        .map(fromRow);
    },
    async latest(ids) {
      if (ids.length === 0) return new Map();
      // One query: rank each schedule's runs newest first and keep rank 1.
      const ranked = db
        .select({
          ...getTableColumns(scheduleRuns),
          rank: sql<number>`row_number() over (partition by ${scheduleRuns.scheduleId} order by ${scheduleRuns.firedAt} desc, ${scheduleRuns.id} desc)`.as(
            "rank",
          ),
        })
        .from(scheduleRuns)
        .where(inArray(scheduleRuns.scheduleId, ids))
        .as("ranked");
      const rows = db.select().from(ranked).where(eq(ranked.rank, 1)).all();
      return new Map(rows.map(({ rank: _, ...r }) => [r.scheduleId, fromRow(r)]));
    },
    async deleteBefore(at) {
      return db
        .delete(scheduleRuns)
        .where(lt(scheduleRuns.firedAt, at))
        .returning({ id: scheduleRuns.id })
        .all().length;
    },
  };
}
