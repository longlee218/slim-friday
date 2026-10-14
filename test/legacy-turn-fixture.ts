import type { Database } from "bun:sqlite";

/** Tables whose `repo` column became `location` in schema v7. */
const RENAMED = ["turns", "sessions", "proposals"] as const;

/**
 * Run `fn` against a PRE-v7 fixture db with the app's own store functions (which write the v7 column
 * `location`): the columns are renamed for the call and renamed back, so the fixture stays at its old schema.
 */
export function withLocationColumns<T>(db: Database, fn: () => T): T {
  const has = (t: string) =>
    db
      .query<{ name: string }, []>(`PRAGMA table_info(${t})`)
      .all()
      .some((c) => c.name === "repo");
  const tables = RENAMED.filter(has);
  for (const t of tables) db.exec(`ALTER TABLE ${t} RENAME COLUMN repo TO location`);
  try {
    return fn();
  } finally {
    for (const t of tables) db.exec(`ALTER TABLE ${t} RENAME COLUMN location TO repo`);
  }
}
