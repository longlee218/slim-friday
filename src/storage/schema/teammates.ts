import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** A persistent teammate: one private Discord channel, its own model, tools, skills and persona (a copy of a preset's values). */
export const teammates = sqliteTable("teammates", {
  /** Teammate id. */
  id: text().primaryKey(),
  /** Short unique name (`[a-z0-9-]{2,32}`): how other teammates address it. */
  name: text().notNull().unique(),
  /** Short role title shown in the profile ("" = none). */
  title: text().notNull().default(""),
  /** Owner's private instructions for this teammate ("" = none); sent in its system prompt, never shown to other teammates. */
  instructions: text().notNull().default(""),
  /** Public profile: one or two lines the other teammates see. */
  description: text().notNull(),
  /** Discord channel id; workspace and channel names come from `workspace.yaml` at run time (one source). */
  channel_id: text().notNull().unique(),
  /** Preset the teammate was created from (its `prompt.md` is rendered, never copied). */
  preset: text().notNull(),
  /** Model id. */
  model: text().notNull(),
  /** JSON array of tool ids (catalog ids valid for a teammate run). */
  tools: text().notNull(),
  /** JSON array of skill names. */
  skills: text().notNull(),
  /** Per-run budget in USD; null = the preset's. */
  budget_usd: real(),
  /** Per-run turn ceiling; null = the preset's. */
  max_turns: integer(),
  /** Epoch ms created. */
  created_at: integer().notNull(),
  /** Epoch ms last edited. */
  updated_at: integer().notNull(),
  /** Epoch ms archived (channel gone); null = active. */
  archived_at: integer(),
});
