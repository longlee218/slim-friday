import type { Store, UploadRow } from "@friday/core";
import { and, asc, eq, lt } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { uploads } from "../schema/engine-tables";

/** Uploads waiting for a message (or an avatar) to use them. */
export function uploadRepo(db: BunSQLiteDatabase): Store["uploads"] {
  /** A row as the port's shape (`messageId` left out when null). */
  const toRow = (r: typeof uploads.$inferSelect): UploadRow => {
    const { messageId, purpose, state, ...rest } = r;
    return {
      ...rest,
      purpose: purpose as UploadRow["purpose"],
      state: state as UploadRow["state"],
      ...(messageId !== null && { messageId }),
    };
  };
  return {
    async insert(u) {
      db.insert(uploads)
        .values({ ...u, messageId: u.messageId ?? null })
        .run();
    },
    async get(id) {
      const r = db.select().from(uploads).where(eq(uploads.id, id)).get();
      return r && toRow(r);
    },
    async markUsed(id, messageId) {
      db.update(uploads).set({ state: "used", messageId }).where(eq(uploads.id, id)).run();
    },
    async pendingBefore(at) {
      return db
        .select()
        .from(uploads)
        .where(and(eq(uploads.state, "pending"), lt(uploads.at, at)))
        .orderBy(asc(uploads.at))
        .all()
        .map(toRow);
    },
    async delete(id) {
      db.delete(uploads).where(eq(uploads.id, id)).run();
    },
  };
}
