import type { Database } from "bun:sqlite";
import { TURN_SELECT, type TurnRow } from "./turn-rows";

/** A run still in flight, with the goal and thread it serves: "who is doing what right now". */
export interface LiveRun extends TurnRow {
  goal_id: string | null;
  goal_title: string | null;
  thread_title: string | null;
  last_input: string | null;
}

/** Every turn with no end yet, newest first; `last_input` is the newest tool call's input (the current step). */
export function liveRuns(db: Database): LiveRun[] {
  return db
    .query<LiveRun, []>(
      `SELECT x.*, g.id AS goal_id, COALESCE(g.subject, substr(g.scope, 1, 160)) AS goal_title, th.title AS thread_title,
         (SELECT substr(c.input_json, 1, 400) FROM tool_calls c WHERE c.turn_id = x.id ORDER BY c.rowid DESC LIMIT 1)
           AS last_input
       FROM (${TURN_SELECT} WHERE t.ended_at IS NULL) x
       LEFT JOIN owned_tasks o ON o.id = x.owned_task_id
       LEFT JOIN owned_tasks g ON g.id = o.parent_id
       LEFT JOIN threads th ON th.thread_id = x.thread_id
       ORDER BY x.started_at DESC`,
    )
    .all();
}
