import type { Database } from "bun:sqlite";
import {
  getWorktreeByTask,
  listWorktreesOfWorkspace,
  type WorktreeRow,
} from "../storage/worktree-store";
import { UUID_RE } from "./clone-safety";
import { selectWorkspace } from "./task-workspace";

/* Resolves the argument of `/cleanup <taskId8|taskId>` against the clones of THIS workspace. */

/** Short id the owner copies from a message: the first 8 hex chars of the task id. */
const SHORT_ID_RE = /^[0-9a-f]{8}$/i;
/** Candidates listed when a short id is ambiguous. */
const MAX_CANDIDATES = 10;

/** The one refusal line for an id that names no clone of this workspace (also for malformed input). */
const UNKNOWN =
  "No clone with that id in this workspace. Use `/cleanup <taskId8>` (first 8 characters of the task id).";

/**
 * The clone row to remove, or a one-line reply when none can be picked. The workspace comes from the channel;
 * a row of another workspace is never reachable (same answer as an unknown id).
 */
export function resolveCleanupTarget(
  deps: { db: Database; agentHome: string },
  channelId: string,
  arg: string,
): WorktreeRow | string {
  const isFull = UUID_RE.test(arg);
  if (!isFull && !SHORT_ID_RE.test(arg)) return UNKNOWN;
  const sel = selectWorkspace(deps.agentHome, channelId);
  if (!("ws" in sel)) return sel.reply;
  const name = sel.ws.name;
  if (isFull) {
    const row = getWorktreeByTask(deps.db, arg.toLowerCase());
    return row && row.workspace === name ? row : UNKNOWN;
  }
  const prefix = arg.toLowerCase();
  const hits = listWorktreesOfWorkspace(deps.db, name).filter((w) => w.taskId.startsWith(prefix));
  if (hits.length === 1) return hits[0] as WorktreeRow;
  if (hits.length === 0) return UNKNOWN;
  const list = hits
    .slice(0, MAX_CANDIDATES)
    .map((w) => `- ${w.taskId} (${w.repo}, ${w.branch})`)
    .join("\n");
  return `Several clones start with ${prefix}. Use the full id:\n${list}`;
}
