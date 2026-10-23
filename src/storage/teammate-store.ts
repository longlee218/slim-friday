import type { Database } from "bun:sqlite";
import type { Teammate } from "../teammates/teammate-types";

/* SQL of the `teammates` table (the only place it is written). Rows are written by the owner's slash command only. */

/** Row as stored (JSON columns as text). */
interface Row {
  id: string;
  name: string;
  title: string;
  instructions: string;
  description: string;
  channel_id: string;
  preset: string;
  model: string;
  tools: string;
  skills: string;
  budget_usd: number | null;
  max_turns: number | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

const COLUMNS = "*";

/** Parse a stored JSON array of strings; a corrupt value is an empty list (the resolver then refuses the run). */
function list(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const toTeammate = (r: Row): Teammate => ({
  id: r.id,
  name: r.name,
  title: r.title,
  instructions: r.instructions,
  description: r.description,
  channelId: r.channel_id,
  preset: r.preset,
  model: r.model,
  tools: list(r.tools),
  skills: list(r.skills),
  ...(r.budget_usd !== null && { budgetUsd: r.budget_usd }),
  ...(r.max_turns !== null && { maxTurns: r.max_turns }),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.archived_at !== null && { archivedAt: r.archived_at }),
});

/** The active teammate of a channel, or undefined. */
export function teammateByChannel(db: Database, channelId: string): Teammate | undefined {
  const r = db
    .query<Row, [string]>(
      `SELECT ${COLUMNS} FROM teammates WHERE channel_id = ? AND archived_at IS NULL`,
    )
    .get(channelId);
  return r ? toTeammate(r) : undefined;
}

/** The newest ARCHIVED teammate of a channel, or undefined (the channel then runs nothing until a new teammate takes it). */
export function archivedTeammateByChannel(db: Database, channelId: string): Teammate | undefined {
  const r = db
    .query<Row, [string]>(
      `SELECT ${COLUMNS} FROM teammates WHERE channel_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC LIMIT 1`,
    )
    .get(channelId);
  return r ? toTeammate(r) : undefined;
}

/** The active teammate called `name`, or undefined. */
export function teammateByName(db: Database, name: string): Teammate | undefined {
  const r = db
    .query<Row, [string]>(`SELECT ${COLUMNS} FROM teammates WHERE name = ? AND archived_at IS NULL`)
    .get(name);
  return r ? toTeammate(r) : undefined;
}

/** Every active teammate, oldest first. */
export function listActiveTeammates(db: Database): Teammate[] {
  return db
    .query<Row, []>(
      `SELECT ${COLUMNS} FROM teammates WHERE archived_at IS NULL ORDER BY created_at, rowid`,
    )
    .all()
    .map(toTeammate);
}

/** Insert a teammate. Throws on a duplicate name or channel (both unique). */
export function insertTeammate(db: Database, t: Teammate): void {
  db.query(
    `INSERT INTO teammates (id, name, title, instructions, description, channel_id, preset, model, tools, skills, budget_usd, max_turns,
       created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.id,
    t.name,
    t.title,
    t.instructions,
    t.description,
    t.channelId,
    t.preset,
    t.model,
    JSON.stringify(t.tools),
    JSON.stringify(t.skills),
    t.budgetUsd ?? null,
    t.maxTurns ?? null,
    t.createdAt,
    t.updatedAt,
  );
}

/** Fields an edit may change. */
export type TeammatePatch = Partial<
  Pick<
    Teammate,
    | "title"
    | "instructions"
    | "description"
    | "model"
    | "tools"
    | "skills"
    | "budgetUsd"
    | "maxTurns"
  >
>;

/** Edit an active teammate; returns false when none matches. Only the given fields change. */
export function updateTeammate(
  db: Database,
  id: string,
  patch: TeammatePatch,
  now = Date.now(),
): boolean {
  const cur = db
    .query<Row, [string]>(`SELECT ${COLUMNS} FROM teammates WHERE id = ? AND archived_at IS NULL`)
    .get(id);
  if (!cur) return false;
  const next = { ...toTeammate(cur), ...patch };
  db.query(
    `UPDATE teammates SET title = ?, instructions = ?, description = ?, model = ?, tools = ?, skills = ?, budget_usd = ?, max_turns = ?,
       updated_at = ? WHERE id = ?`,
  ).run(
    next.title,
    next.instructions,
    next.description,
    next.model,
    JSON.stringify(next.tools),
    JSON.stringify(next.skills),
    next.budgetUsd ?? null,
    next.maxTurns ?? null,
    now,
    id,
  );
  return true;
}

/** Archive a teammate (its channel is gone or the owner removed it); keeps the row for the history. */
export function archiveTeammate(db: Database, id: string, now = Date.now()): boolean {
  return (
    db
      .query(
        "UPDATE teammates SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL",
      )
      .run(now, now, id).changes === 1
  );
}
