import type { Database } from "bun:sqlite";

/** What the board reads need: the app db and the run's thread. The thread comes from the run, never from params. */
export interface TaskBoardCtx {
  db: Database;
  threadId: string;
}
