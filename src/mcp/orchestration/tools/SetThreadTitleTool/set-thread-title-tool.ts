import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { applyThreadTitle } from "../../../../ingress/thread-rename";
import type { MemoryToolContext } from "../../../../memory/memory-tool-context";
import { textResult } from "../../../tool-result";
import { SET_THREAD_TITLE_MAX_CALLS_PER_RUN, SET_THREAD_TITLE_TOOL } from "./constants";
import { SET_THREAD_TITLE_DESCRIPTION } from "./prompt";

/** Input of the tool (the model sees this schema). Length is checked in the handler, so a refusal is a readable tool error. */
const SHAPE = {
  title: z.string().describe("Thread title: at most 6 words, the owner's language."),
  digest: z.string().describe("1-2 short lines on what the thread is about."),
};

/**
 * The `SetThreadTitle` tool of ONE run (counts its own calls, so build it once per run). Always stores title +
 * digest; renames the thread only while its live name is still the bot's placeholder (adopted threads have none).
 */
export function createSetThreadTitleTool(ctx: MemoryToolContext) {
  let calls = 0;
  return tool(SET_THREAD_TITLE_TOOL, SET_THREAD_TITLE_DESCRIPTION, SHAPE, async (args) => {
    const { threadId, threadTitle } = ctx;
    if (!threadId || !threadTitle) return textResult("this run has no thread", true);
    if (++calls > SET_THREAD_TITLE_MAX_CALLS_PER_RUN)
      return textResult(
        `limit reached: at most ${SET_THREAD_TITLE_MAX_CALLS_PER_RUN} calls per run`,
        true,
      );
    const result = await applyThreadTitle(
      {
        db: ctx.db,
        threadId,
        channelId: ctx.channelId,
        workspace: ctx.workspace,
        port: threadTitle,
        now: ctx.now,
      },
      args.title,
      args.digest,
    );
    if (result === "empty") return textResult("title and digest must not be empty", true);
    return textResult(
      result === "renamed"
        ? "saved; thread renamed"
        : result === "kept"
          ? "saved; thread name kept"
          : "saved; rename failed",
    );
  });
}
