import type { Client } from "discord.js";
import { logger } from "../observability/logger";
import { errText } from "../observability/redact";

/**
 * Renames a thread on behalf of the `SetThreadTitle` tool. The agent never holds a Discord token: only this
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
export const RENAME_TIMEOUT_MS = 5000;

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
