import {
  type FileKind,
  type FileRow,
  IMAGE_MIME_TYPES,
  PDF_MIME_TYPE,
  type Store,
} from "@friday/core";
import { and, desc, eq, inArray, lt, notInArray, or, type SQL } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { files } from "../schema/engine-tables";

type FileRecord = typeof files.$inferSelect;

/** A stored row as a core file (null pixel sizes dropped). */
function toRow({ width, height, source, ...rest }: FileRecord): FileRow {
  return {
    ...rest,
    source: source as FileRow["source"],
    ...(width !== null && { width }),
    ...(height !== null && { height }),
  };
}

/** The mime-type condition of a kind. */
function kindClause(kind: FileKind): SQL | undefined {
  if (kind === "image") return inArray(files.mimeType, [...IMAGE_MIME_TYPES]);
  if (kind === "pdf") return eq(files.mimeType, PDF_MIME_TYPE);
  return notInArray(files.mimeType, [...IMAGE_MIME_TYPES, PDF_MIME_TYPE]);
}

/** Files (stored objects) carried by messages. */
export function fileRepo(db: BunSQLiteDatabase): Store["files"] {
  return {
    async listUploads(q) {
      const { cursor } = q;
      const where = and(
        eq(files.source, "upload"),
        q.kind ? kindClause(q.kind) : undefined,
        q.conversationId ? eq(files.conversationId, q.conversationId) : undefined,
        cursor &&
          or(lt(files.at, cursor.at), and(eq(files.at, cursor.at), lt(files.id, cursor.id))),
      );
      return db
        .select()
        .from(files)
        .where(where)
        .orderBy(desc(files.at), desc(files.id))
        .limit(q.limit)
        .all()
        .map(toRow);
    },
    async insert(f) {
      db.insert(files)
        .values({ ...f, width: f.width ?? null, height: f.height ?? null })
        .run();
    },
    async delete(id) {
      db.delete(files).where(eq(files.id, id)).run();
    },
    async hasKey(key) {
      return !!db.select({ id: files.id }).from(files).where(eq(files.key, key)).limit(1).get();
    },
    async get(id) {
      const r = db.select().from(files).where(eq(files.id, id)).get();
      return r && toRow(r);
    },
  };
}
