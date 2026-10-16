import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Audit row of one side effect a grant allowed (append only). */
export const effect_log = sqliteTable("effect_log", {
  /** Effect id (a repeated id is a no-op). */
  id: text().primaryKey(),
  /** Thread of the effect. */
  thread_id: text().notNull(),
  /** Goal of the effect. */
  goal_id: text(),
  /** Item of the effect. */
  item_id: text(),
  /** Tool or action name. */
  tool: text().notNull(),
  /** What the grant covered. */
  scope: text().notNull(),
  /** Who allowed it: owner, plan, role. */
  granted_by: text().notNull(),
  /** Short redacted outcome. */
  result: text().notNull(),
  /** How to undo it. */
  undo: text(),
  /** Epoch ms created. */
  created_at: integer().notNull(),
});
