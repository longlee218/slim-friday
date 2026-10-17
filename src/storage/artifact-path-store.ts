import type { Database } from "bun:sqlite";

/** Id of the newest artifact whose file is `path` (absolute, store origin), or null: a posted result file -> its viewer link. */
export function artifactIdByPath(db: Database, path: string): string | null {
  return (
    db
      .query<{ id: string }, [string]>(
        "SELECT id FROM artifacts WHERE origin = 'store' AND path = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(path)?.id ?? null
  );
}
