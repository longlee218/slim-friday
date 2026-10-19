import type { Database } from "bun:sqlite";
import {
  ORCHESTRATE_ACTION_SET_TITLE,
  orchestrateRef,
} from "../../mcp/orchestration/tools/OrchestrateTool/action-names";
import { getThread } from "../../storage/thread-store";

/** The system-context line that asks the agent to title a thread that still carries the bot's placeholder name. */
const THREAD_TITLE_NOTE = `This thread has no title yet: call ${orchestrateRef(ORCHESTRATE_ACTION_SET_TITLE)} once, early, with a short title and digest (skip for a greeting-only turn).`;

/**
 * One context line while the thread has its placeholder name and no title, and the run can rename (`hasPort`:
 * the tool is registered only then). Adopted or unknown threads, titled threads and runs without a port get none.
 */
export function threadTitleNote(db: Database, threadId: string, hasPort: boolean): string[] {
  if (!hasPort) return [];
  const row = getThread(db, threadId);
  return row?.placeholder && !row.title ? [THREAD_TITLE_NOTE] : [];
}

/** The rename port a run may use: none in a chat channel (`threadId === channelId`: no thread to rename, no tool offered). */
export const titlePortFor = <P>(i: { threadId: string; channelId?: string }, port?: P) =>
  i.threadId === i.channelId ? undefined : port;
