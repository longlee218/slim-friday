import type { Database } from "bun:sqlite";
import { logEvent, logger } from "../observability/logger";
import { searchThreads } from "../storage/thread-store";
import { selectWorkspace } from "../workspaces/task-workspace";
import { monthDay } from "./channel-digest";
import type { MemoryRunner } from "./memory-command-handler";

const log = logger.child({ module: "find-command-handler" });

/** `/find <keywords>` (the only form: a plain "find: ..." message is a normal task); the keywords may be empty. */
const FIND_COMMAND = /^\/find(?:\s+([\s\S]*))?$/i;

/** Most threads one `/find` lists. */
export const FIND_LIMIT = 10;

/** Reply of `/find` with no keyword. */
export const FIND_USAGE =
  "Usage: `/find <keywords>` (every keyword must match a thread title or digest).";

/** Reply of `/find` with no match. */
export const FIND_NONE = "No thread matches.";

/**
 * Wrap the owner memory runner so `/find <keywords>` is answered by app code too (same inline path, owner and guild
 * checks already ran in ingress): no thread, no task row, no model call. Searches the titles and digests of every
 * channel of the SAME space as the channel/thread it was typed in; every keyword must match (case-insensitive,
 * literal, NFC), newest 10, one line `<#threadId> MM-DD title`. Anything else goes to the wrapped runner.
 */
export function withFindCommand(
  next: MemoryRunner,
  deps: { db: Database; agentHome: string },
): MemoryRunner {
  return async (req) => {
    const m = FIND_COMMAND.exec(req.text.normalize("NFC").trim());
    if (!m || req.where === "ops") return next(req);
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
