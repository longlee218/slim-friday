import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { editNote } from "../../../../memory/edit-note";
import type { MemoryToolContext } from "../../../../memory/memory-tool-context";
import type { MemorySaveOutcome } from "../../../../memory/save-note";
import { logEvent, logger } from "../../../../observability/logger";
import { errText } from "../../../../observability/redact";
import { textResult } from "../../../tool-result";
import { finishWriteOutcome } from "../../write-outcome";
import { MEMORY_EDIT_ACTIONS, MEMORY_EDIT_MAX_CALLS_PER_RUN, MEMORY_EDIT_TOOL } from "./constants";
import { MEMORY_EDIT_DESCRIPTION } from "./prompt";

const log = logger.child({ module: "memory-edit-tool" });

/** Input of the tool (the model sees this schema). Id and text are checked in the handler, so a refusal is a readable tool error. */
const SHAPE = {
  action: z.enum(MEMORY_EDIT_ACTIONS),
  id: z.string().describe("Id of the channel bullet, from MemorySearch or MemoryGet."),
  text: z.string().optional().describe("New text of the bullet (replace only)."),
};

/**
 * The `MemoryEdit` tool of ONE run: counts its own calls (MEMORY_EDIT_MAX_CALLS_PER_RUN), so build it once per run.
 * Logs `memory.edit {action, chars, result}`; the text is never logged.
 */
export function createMemoryEditTool(ctx: MemoryToolContext) {
  let calls = 0;
  return tool(MEMORY_EDIT_TOOL, MEMORY_EDIT_DESCRIPTION, SHAPE, async (args) => {
    let out: MemorySaveOutcome;
    try {
      const now = (ctx.now ?? (() => new Date()))(); // one clock read per call
      out =
        ++calls > MEMORY_EDIT_MAX_CALLS_PER_RUN
          ? {
              text: `at most ${MEMORY_EDIT_MAX_CALLS_PER_RUN} edits per run`,
              isError: true,
              result: "limit",
            }
          : editNote(ctx, args, now);
    } catch (err) {
      // Never let a bug escape into the SDK: the model gets a short error, the log gets the class only (never the text).
      log.warn({ err: errText(err).slice(0, 120) }, "edit failed");
      out = { text: "", isError: true, result: "error" };
    }
    out = finishWriteOutcome(ctx, MEMORY_EDIT_TOOL, out);
    logEvent(log, "memory.edit", {
      action: args.action,
      chars: args.text?.length ?? 0,
      result: out.result,
    });
    return textResult(out.text, out.isError);
  });
}
