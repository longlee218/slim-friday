import type { ScratchpadItem, Store } from "@friday/core";
import { and, asc, eq, lt } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { scratchpad } from "../schema/engine-tables";

/** Scratchpad items; every read and write names the scope key, so a scope never touches another's rows. */
export function scratchpadRepo(db: BunSQLiteDatabase): Store["scratchpad"] {
  return {
    async list(scopeKey, f) {
      const where = f?.status
        ? and(eq(scratchpad.scopeKey, scopeKey), eq(scratchpad.status, f.status))
        : eq(scratchpad.scopeKey, scopeKey);
      return db
        .select()
        .from(scratchpad)
        .where(where)
        .orderBy(asc(scratchpad.createdAt), asc(scratchpad.id))
        .all()
        .map(toItem);
    },
    async add(i, now) {
      const row = { ...i, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
      db.insert(scratchpad).values(row).run();
      return toItem(row);
    },
    async update(id, scopeKey, patch, now) {
      const row = db
        .update(scratchpad)
        .set({ ...patch, updatedAt: now })
        .where(and(eq(scratchpad.id, id), eq(scratchpad.scopeKey, scopeKey)))
        .returning()
        .get();
      return row && toItem(row);
    },
    async remove(id, scopeKey) {
      return (
        db
          .delete(scratchpad)
          .where(and(eq(scratchpad.id, id), eq(scratchpad.scopeKey, scopeKey)))
          .returning({ id: scratchpad.id })
          .all().length > 0
      );
    },
    async deleteDoneBefore(at) {
      return db
        .delete(scratchpad)
        .where(and(eq(scratchpad.status, "done"), lt(scratchpad.updatedAt, at)))
        .returning({ id: scratchpad.id })
        .all().length;
    },
  };
}

/** A table row as a domain item. */
function toItem(r: typeof scratchpad.$inferSelect): ScratchpadItem {
  return { ...r, status: r.status as ScratchpadItem["status"] };
}
