import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * One artifact: a titled document of a workspace channel (a task result, a report, a reference into a repo). The body
 * lives in a file (`origin` store) or in the granted location (`origin` repo); this row is its record. The `artifacts_fts`
 * FTS5 table is created by the custom migration `artifacts_fts` (drizzle has no FTS5 support), not declared here.
 */
export const artifacts = sqliteTable(
  "artifacts",
  {
    /** Artifact id. */
    id: text().primaryKey(),
    /** Workspace (space) it belongs to. */
    workspace: text().notNull(),
    /** Channel (yaml name) it belongs to; '' = the workspace level (no mapped channel). */
    channel: text().notNull().default(""),
    /** Goal, task and thread that produced it (lookup only, never the owner of the file). */
    goal_id: text(),
    task_id: text(),
    thread_id: text(),
    /** Title the producer gave. */
    title: text().notNull(),
    /** File name without the `-vN` suffix: the versioning key together with workspace and channel. */
    name: text().notNull(),
    /** `md`, `html`, `diff`, `csv` or `txt`. */
    kind: text().notNull(),
    /** `store` (file under the channel's artifacts dir) or `repo` (reference into a granted location). */
    origin: text().notNull(),
    /** Absolute file path (store) or path relative to the location (repo). */
    path: text().notNull(),
    /** Location name of a repo artifact. */
    location: text(),
    /** Role that produced it. */
    producer_role: text(),
    /** 1 for the first file of a name, then 2, 3 ... (older versions are kept). */
    version: integer().notNull().default(1),
    /** Body size in bytes. */
    size: integer().notNull(),
    /** Epoch ms created. */
    created_at: integer().notNull(),
  },
  (t) => [
    index("artifacts_name").on(t.workspace, t.channel, t.name),
    index("artifacts_goal").on(t.goal_id),
  ],
);
