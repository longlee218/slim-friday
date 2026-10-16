import type { Database } from "bun:sqlite";
import { logEvent, logger } from "../observability/logger";
import { searchThreads } from "../storage/thread-store";
import { selectWorkspace } from "../workspaces/task-workspace";
import { monthDay } from "./channel-digest";

const log = logger.child({ module: "find-command-handler" });

/** One message to check for an inline owner command. The owner and guild checks already ran in ingress. */
export interface InlineRequest {
  /** Routing key: the parent channel of a thread, else the channel itself (maps to a workspace). */
  channelId: string;
  text: string;
}

/** Returns the reply, or null when the text is not an inline command (then it is a normal message). */
export type InlineRunner = (req: InlineRequest) => Promise<string | null>;

/** `/find <keywords>` (the only form: a plain "find: ..." message is a normal task); the keywords may be empty. */
const FIND_COMMAND = /^\/find(?:\s+([\s\S]*))?$/i;

/** Most threads one `/find` lists. */
const FIND_LIMIT = 10;

/** Reply of `/find` with no keyword. */
export const FIND_USAGE =
  "Usage: `/find <keywords>` (every keyword must match a thread title or digest).";

/** Reply of `/find` with no match. */
export const FIND_NONE = "No thread matches.";

/**
 * The inline owner command runner: `/find <keywords>` is answered by app code (owner and guild checks already
 * ran in ingress): no thread, no task row, no model call. Searches the titles and digests of every
 * channel of the SAME space as the channel/thread it was typed in; every keyword must match (case-insensitive,
 * literal, NFC), newest 10, one line `<#threadId> MM-DD title`. Any other text returns null.
 */
export function createFindRunner(deps: { db: Database; agentHome: string }): InlineRunner {
  return async (req) => {
    const m = FIND_COMMAND.exec(req.text.normalize("NFC").trim());
    if (!m) return null;
    const words = (m[1] ?? "").split(/\s+/).filter(Boolean);
    if (!words.length) return FIND_USAGE;
    const picked = selectWorkspace(deps.agentHome, req.channelId);
    if ("reply" in picked) return picked.reply;
    const rows = searchThreads(deps.db, picked.ws.name, picked.ws.channels, words, FIND_LIMIT);
    logEvent(log, "find.command", { words: words.length, hits: rows.length });
    return rows.length
      ? rows.map((r) => `<#${r.thread_id}> ${monthDay(r.updated_at)} ${r.title}`).join("\n")
      : FIND_NONE;
  };
}
