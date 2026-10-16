import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Token/cost totals of one SDK run inside a turn. */
export const runs = sqliteTable(
  "runs",
  {
    /** Run id. */
    id: text().primaryKey(),
    /** Turn the run belongs to. */
    turn_id: text().notNull(),
    /** Model name. */
    model: text().notNull(),
    /** Input tokens. */
    input_tokens: integer().notNull().default(0),
    /** Output tokens. */
    output_tokens: integer().notNull().default(0),
    /** Cache-read tokens. */
    cache_read_tokens: integer().notNull().default(0),
    /** Cache-creation tokens. */
    cache_creation_tokens: integer().notNull().default(0),
    /** Cost in USD. */
    cost_usd: real().notNull().default(0),
    /** SDK turn count. */
    turns: integer().notNull().default(0),
    /** Wall time in ms. */
    duration_ms: integer().notNull().default(0),
    /** Outcome label. */
    outcome: text().notNull(),
    /** Number of compactions during the run. */
    compactions: integer().notNull().default(0),
  },
  (t) => [index("idx_runs_turn").on(t.turn_id)],
);

/** One tool call of a run (input and a short output preview). */
export const tool_calls = sqliteTable(
  "tool_calls",
  {
    /** Tool call id. */
    id: text().primaryKey(),
    /** Run the call belongs to. */
    run_id: text().notNull(),
    /** Tool name. */
    tool: text().notNull(),
    /** Redacted input JSON. */
    input_json: text().notNull(),
    /** Clipped, redacted output. */
    output_preview: text().notNull(),
    /** 1 when the call failed. */
    is_error: integer().notNull().default(0),
    /** Duration in ms. */
    duration_ms: integer().notNull().default(0),
    /** Subagent id when the call came from a subagent. */
    agent_id: text(),
    /** Turn of the call. */
    turn_id: text(),
  },
  (t) => [index("idx_tool_calls_run").on(t.run_id)],
);
