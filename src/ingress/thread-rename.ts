import type { Database } from "bun:sqlite";
import type { Client } from "discord.js";
import {
  DIGEST_MAX_CHARS,
  DIGEST_MIN_CHARS,
  THREAD_NAME_MAX_CHARS,
  TITLE_MAX_CHARS,
  TITLE_MIN_CHARS,
} from "../mcp/orchestration/tools/OrchestrateTool/constants";
import { localDay } from "../memory/memory-clock";
import { logEvent, logger } from "../observability/logger";
import { errText, redactText } from "../observability/redact";
import { getThread, saveTitle } from "../storage/thread-store";

/**
 * Renames a thread on behalf of the `Orchestrate set_title` action. The agent never holds a Discord token: only this
 * app-side port touches Discord. `renamed` = new name set, `kept` = the live name is not the placeholder
 * (the owner renamed it, or it is not a thread), `failed` = Discord or lookup error.
 */
export interface ThreadTitlePort {
  rename(
    threadId: string,
    placeholder: string,
    name: string,
  ): Promise<"renamed" | "kept" | "failed">;
}

const log = logger.child({ module: "thread-rename" });

/** Longest wait for Discord to rename (a rate-limited `setName` is queued, not rejected): then give up. */
const RENAME_TIMEOUT_MS = 5000;

/** Build the port over a lazily-read client (the client is created after the turn handler). Never throws. */
export function createThreadTitlePort(
  getClient: () => Client | undefined,
  timeoutMs: number = RENAME_TIMEOUT_MS,
): ThreadTitlePort {
  return {
    async rename(threadId, placeholder, name) {
      try {
        const ch = await getClient()?.channels.fetch(threadId);
        if (!ch?.isThread()) return "kept";
        // Never overwrite a name the owner set by hand.
        if (ch.name !== placeholder) return "kept";
        // Race the rename against a timeout so a rate limit never stalls the turn.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((r) => {
          timer = setTimeout(() => r("timeout"), timeoutMs);
        });
        const won = await Promise.race([ch.setName(name).then(() => "renamed" as const), timeout]);
        clearTimeout(timer);
        if (won === "timeout") {
          log.warn({ threadId }, "thread rename timed out");
          return "failed";
        }
        return "renamed";
      } catch (err) {
        log.warn({ err: errText(err) }, "thread rename failed");
        return "failed";
      }
    },
  };
}

/** Bidi controls and zero-width / invisible format chars (they can disguise a title). */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD]/g;

/** Redact, drop control/bidi/zero-width chars, fold to ONE line, trim and clip to `max` code points. */
function clean(text: string, max: number): string {
  const line = redactText(text)
    .replace(/\p{Cc}/gu, " ")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(line).slice(0, max).join("").trim(); // by code point: never splits a surrogate pair
}

/** Run facts `applyThreadTitle` needs (a slice of the memory tool context). */
export interface ThreadTitleRun {
  db: Database;
  threadId: string;
  /** Discord channel id the thread lives in (stamped on a thread row that must be created). */
  channelId?: string;
  workspace: string;
  port: ThreadTitlePort;
  /** Clock (tests pass a fixed one). */
  now?: () => Date;
}

/**
 * Store title + digest of a thread and rename it only while its live name is still the bot's placeholder (adopted
 * threads have none). Returns "empty" when the cleaned title or digest is empty (nothing stored), else the rename
 * result ("failed" also when the store or the port threw). Logs `thread.titled {renamed, chars}`; never the text.
 */
export async function applyThreadTitle(
  run: ThreadTitleRun,
  rawTitle: string,
  rawDigest: string,
): Promise<"empty" | "renamed" | "kept" | "failed"> {
  const title = clean(rawTitle, TITLE_MAX_CHARS);
  const digest = clean(rawDigest, DIGEST_MAX_CHARS);
  if (title.length < TITLE_MIN_CHARS || digest.length < DIGEST_MIN_CHARS) return "empty";
  let result: "renamed" | "kept" | "failed" = "failed";
  try {
    saveTitle(run.db, run.threadId, title, digest, Date.now(), run.channelId, run.workspace);
    const row = getThread(run.db, run.threadId);
    if (row?.placeholder) {
      const now = (run.now ?? (() => new Date()))();
      const day = localDay(row.created_at ? new Date(row.created_at) : now).slice(5);
      const name = Array.from(`${day} ${title}`).slice(0, THREAD_NAME_MAX_CHARS).join("");
      result = await run.port.rename(run.threadId, row.placeholder, name);
    } else result = "kept"; // adopted (or unknown) thread: never renamed
  } catch (err) {
    log.warn({ err: errText(err) }, "set thread title failed");
  }
  logEvent(log, "thread.titled", { renamed: result === "renamed", chars: title.length });
  return result;
}
