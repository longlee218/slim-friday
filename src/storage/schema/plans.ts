import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** A versioned work plan (strategy, body, acceptance, envelope) with its approval state. */
export const work_plans = sqliteTable(
  "work_plans",
  {
    /** Plan id. */
    id: text().notNull(),
    /** Plan version (a revision bumps it). */
    version: integer().notNull(),
    /** Goal the plan belongs to. */
    goal_id: text().notNull(),
    /** Plan status. */
    status: text().notNull(),
    /** Strategy name. */
    strategy: text().notNull(),
    /** One-line objective. */
    objective: text().notNull(),
    /** Plan body (items). */
    body: text().notNull(),
    /** Spec text of the goal (markdown); copied to each revision unless replaced. */
    spec_md: text().notNull().default(""),
    /** Plan text of the goal (markdown); item sections are headings of it. */
    plan_md: text().notNull().default(""),
    /** JSON acceptance criteria. */
    acceptance: text().notNull().default("[]"),
    /** JSON envelope (roles, locations, risk classes). */
    envelope: text().notNull().default("{}"),
    /** Budget in USD. */
    budget_usd: real(),
    /** Comma-joined delivery effect tools the plan promises. */
    effects: text(),
    /** Reason of the last decision. */
    reason: text(),
    /** Epoch ms created. */
    created_at: integer().notNull(),
    /** Epoch ms approved. */
    approved_at: integer(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.version] }),
    index("work_plans_goal").on(t.goal_id, t.status),
  ],
);
