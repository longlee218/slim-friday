import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { MEMORY_KINDS } from "../../../../memory/memory-sections";
import type { MemoryToolContext } from "../../../../memory/memory-tool-context";
import { type MemorySaveOutcome, saveNote } from "../../../../memory/save-note";
import { logEvent, logger } from "../../../../observability/logger";
import { errText } from "../../../../observability/redact";
import { textResult } from "../../../tool-result";
import { finishWriteOutcome } from "../../write-outcome";
import { MEMORY_SAVE_MAX_CALLS_PER_RUN, MEMORY_SAVE_SCOPES, MEMORY_SAVE_TOOL } from "./constants";
import { MEMORY_SAVE_DESCRIPTION } from "./prompt";

/** Logger of this module. */
const log = logger.child({ module: "memory-save-tool" });

/** Input of the tool (the model sees this schema). Text length is checked in the handler, so the refusal is a readable tool error. */
const SHAPE = {
  text: z.string().describe("The note: one short plain sentence."),
  scope: z.enum(MEMORY_SAVE_SCOPES),
  kind: z.enum(MEMORY_KINDS).optional().describe("Default fact. open only with scope journal."),
  cue: z
    .string()
    .optional()
    .describe(
      "kind lesson only (required): the situation it applies to, e.g. 'a verify fails on missing env'.",
    ),
  evidence: z
    .string()
    .optional()
    .describe(
      "kind lesson only (required): the run, item or message that showed it, e.g. 'goal 3f2a verify-1'.",
    ),
  confirmNew: z
    .boolean()
    .optional()
    .describe("true = save even when a similar note exists (scope channel)."),
};

/**
 * The `MemorySave` tool of ONE run: it counts its own calls (MEMORY_SAVE_MAX_CALLS_PER_RUN), so build it once per run.
 * Logs `memory.save {scope, kind, chars, result}`; the text is never logged.
 */
export function createMemorySaveTool(ctx: MemoryToolContext) {
  let calls = 0;
  return tool(MEMORY_SAVE_TOOL, MEMORY_SAVE_DESCRIPTION, SHAPE, async (args) => {
    let out: MemorySaveOutcome;
    try {
      const now = (ctx.now ?? (() => new Date()))(); // one clock read per call
      out =
        ++calls > MEMORY_SAVE_MAX_CALLS_PER_RUN
          ? {
              text: `at most ${MEMORY_SAVE_MAX_CALLS_PER_RUN} saves per run`,
              isError: true,
              result: "limit",
            }
          : saveNote(ctx, args, now);
    } catch (err) {
      // Never let a bug escape into the SDK: the model gets a short error, the log gets the class only (never the text).
      log.warn({ err: errText(err).slice(0, 120) }, "remember failed");
      out = { text: "", isError: true, result: "error" };
    }
    out = finishWriteOutcome(ctx, MEMORY_SAVE_TOOL, out);
    logEvent(log, "memory.save", {
      scope: args.scope,
      kind: args.kind,
      chars: args.text.length,
      result: out.result,
    });
    return textResult(out.text, out.isError);
  });
}
