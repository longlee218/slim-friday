import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { REMEMBER_TOOL } from "../../mcp/mcp-tool-names";
import { MEMORY_KINDS } from "../../memory/memory-sections";
import { logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import type { MemoryToolContext } from "../memory-tool-context";
import { REMEMBER_MAX_CALLS_PER_RUN, REMEMBER_SCOPES } from "./constants";
import { REMEMBER_DESCRIPTION } from "./prompt";
import { type RememberOutcome, rememberNote } from "./remember-write";

/** Logger of this module. */
const log = logger.child({ module: "remember-tool" });

/** Input of the tool (the model sees this schema). Text length is checked in the handler, so the refusal is a readable tool error. */
const SHAPE = {
  text: z.string().describe("The note: one short plain sentence."),
  scope: z.enum(REMEMBER_SCOPES),
  repo: z.string().optional().describe("Repo name; required with scope repo, otherwise omit."),
  kind: z.enum(MEMORY_KINDS).optional().describe("Default fact. open only with scope journal."),
};

/**
 * The `Remember` tool of ONE run: it counts its own calls (REMEMBER_MAX_CALLS_PER_RUN), so build it once per run.
 * Logs `memory.remember {scope, kind, chars, result}`; the text is never logged.
 */
export function createRememberTool(ctx: MemoryToolContext) {
  let calls = 0;
  return tool(REMEMBER_TOOL, REMEMBER_DESCRIPTION, SHAPE, async (args) => {
    let out: RememberOutcome;
    try {
      const now = (ctx.now ?? (() => new Date()))(); // one clock read per call
      out =
        ++calls > REMEMBER_MAX_CALLS_PER_RUN
          ? {
              text: `limit reached: at most ${REMEMBER_MAX_CALLS_PER_RUN} saves per run`,
              isError: true,
              result: "limit",
            }
          : rememberNote(ctx, args, now);
    } catch (err) {
      // Never let a bug escape into the SDK: the model gets a short error, the log gets the class only (never the text).
      out = {
        text: `could not save: ${errText(err).slice(0, 120)}`,
        isError: true,
        result: "error",
      };
    }
    logEvent(log, "memory.remember", {
      scope: args.scope,
      kind: args.kind,
      chars: args.text.length,
      result: out.result,
    });
    return {
      content: [{ type: "text" as const, text: out.text }],
      ...(out.isError && { isError: true }),
    };
  });
}
