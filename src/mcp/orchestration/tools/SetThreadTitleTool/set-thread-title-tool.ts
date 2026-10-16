import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { localDay } from "../../../../memory/memory-clock";
import { logEvent, logger } from "../../../../observability/logger";
import { errText, redactText } from "../../../../observability/redact";
import { getThread, saveTitle } from "../../../../storage/thread-store";
import type { MemoryToolContext } from "../../../memory/memory-tool-context";
import {
  DIGEST_MAX_CHARS,
  DIGEST_MIN_CHARS,
  SET_THREAD_TITLE_MAX_CALLS_PER_RUN,
  SET_THREAD_TITLE_TOOL,
  THREAD_NAME_MAX_CHARS,
  TITLE_MAX_CHARS,
  TITLE_MIN_CHARS,
} from "./constants";
import { SET_THREAD_TITLE_DESCRIPTION } from "./prompt";

/** Logger of this module. */
const log = logger.child({ module: "set-thread-title-tool" });

/** Input of the tool (the model sees this schema). Length is checked in the handler, so a refusal is a readable tool error. */
const SHAPE = {
  title: z.string().describe("Thread title: at most 6 words, the owner's language."),
  digest: z.string().describe("1-2 short lines on what the thread is about."),
};

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

/** Short tool result (never an error: a failed rename still stored the title). */
const reply = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  ...(isError && { isError: true }),
});

/**
 * The `SetThreadTitle` tool of ONE run (counts its own calls, so build it once per run). Always stores title +
 * digest; renames the thread only while its live name is still the bot's placeholder (adopted threads have none).
 * Logs `thread.titled {renamed, chars}`; the text is never logged.
 */
export function createSetThreadTitleTool(ctx: MemoryToolContext) {
  let calls = 0;
  return tool(SET_THREAD_TITLE_TOOL, SET_THREAD_TITLE_DESCRIPTION, SHAPE, async (args) => {
    const { threadId, threadTitle } = ctx;
    if (!threadId || !threadTitle) return reply("this run has no thread", true);
    if (++calls > SET_THREAD_TITLE_MAX_CALLS_PER_RUN)
      return reply(
        `limit reached: at most ${SET_THREAD_TITLE_MAX_CALLS_PER_RUN} calls per run`,
        true,
      );
    const title = clean(args.title, TITLE_MAX_CHARS);
    const digest = clean(args.digest, DIGEST_MAX_CHARS);
    if (title.length < TITLE_MIN_CHARS || digest.length < DIGEST_MIN_CHARS)
      return reply("title and digest must not be empty", true);
    let result: "renamed" | "kept" | "failed" = "failed";
    try {
      saveTitle(ctx.db, threadId, title, digest, Date.now(), ctx.channelId, ctx.workspace);
      const row = getThread(ctx.db, threadId);
      if (row?.placeholder) {
        const now = (ctx.now ?? (() => new Date()))();
        const day = localDay(row.created_at ? new Date(row.created_at) : now).slice(5);
        const name = Array.from(`${day} ${title}`).slice(0, THREAD_NAME_MAX_CHARS).join("");
        result = await threadTitle.rename(threadId, row.placeholder, name);
      } else result = "kept"; // adopted (or unknown) thread: never renamed
    } catch (err) {
      log.warn({ err: errText(err) }, "set thread title failed");
    }
    logEvent(log, "thread.titled", { renamed: result === "renamed", chars: title.length });
    return reply(
      result === "renamed"
        ? "saved; thread renamed"
        : result === "kept"
          ? "saved; thread name kept"
          : "saved; rename failed",
    );
  });
}
