import type { FileRow, Store } from "@friday/core";
import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { files } from "../schema/engine-tables";

/** Files (stored objects) carried by messages. */
export function fileRepo(db: BunSQLiteDatabase): Store["files"] {
  return {
    async insert(f) {
      db.insert(files)
        .values({ ...f, width: f.width ?? null, height: f.height ?? null })
        .run();
    },
    async get(id) {
      const r = db.select().from(files).where(eq(files.id, id)).get();
      if (!r) return undefined;
      const { width, height, source, ...rest } = r;
      return {
        ...rest,
        source: source as FileRow["source"],
        ...(width !== null && { width }),
        ...(height !== null && { height }),
      };
    },
  };
}
