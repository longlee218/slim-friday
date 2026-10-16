import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { MEMORY_KINDS } from "../../../../memory/memory-sections";
import { logEvent, logger } from "../../../../observability/logger";
import { errText } from "../../../../observability/redact";
import type { MemoryToolContext } from "../../memory-tool-context";
import { formatTrustedToolIssue, type TrustedToolIssueCode } from "../../trusted-tool-issue";
import { REMEMBER_MAX_CALLS_PER_RUN, REMEMBER_SCOPES, REMEMBER_TOOL } from "./constants";
import { REMEMBER_DESCRIPTION } from "./prompt";
import { type RememberOutcome, rememberNote } from "./remember-write";

/** Logger of this module. */
const log = logger.child({ module: "remember-tool" });

/** Input of the tool (the model sees this schema). Text length is checked in the handler, so the refusal is a readable tool error. */
const SHAPE = {
  text: z.string().describe("The note: one short plain sentence."),
  scope: z.enum(REMEMBER_SCOPES),
  location: z
    .string()
    .optional()
    .describe("Location name; required with scope location, otherwise omit."),
  kind: z.enum(MEMORY_KINDS).optional().describe("Default fact. open only with scope journal."),
};

/** Trusted code of a refused write; any result this map does not know is `unavailable` (no guessed cause). */
const ISSUE_OF: Record<string, TrustedToolIssueCode> = {
  too_short: "invalid_input",
  too_long: "invalid_input",
  bad_kind: "invalid_input",
  bad_location: "invalid_input",
  no_channel: "invalid_input",
  empty: "invalid_input",
  full: "limit",
  limit: "limit",
  busy: "temporarily_busy",
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
              text: `at most ${REMEMBER_MAX_CALLS_PER_RUN} saves per run`,
              isError: true,
              result: "limit",
            }
          : rememberNote(ctx, args, now);
    } catch (err) {
      // Never let a bug escape into the SDK: the model gets a short error, the log gets the class only (never the text).
      log.warn({ err: errText(err).slice(0, 120) }, "remember failed");
      out = { text: "", isError: true, result: "error" };
    }
    if (out.isError) {
      // The model gets a trusted code and one next step: known outcomes keep their short text as detail, an unknown
      // one (an exception, an unmapped result) gets none.
      const known = ISSUE_OF[out.result];
      // Only a KNOWN outcome is reported to the supervisor; an unknown failure stays `unavailable` for the model but
      // never counts toward a recovery.
      if (known) ctx.onIssue?.({ tool: REMEMBER_TOOL, code: known });
      out = {
        ...out,
        text: formatTrustedToolIssue(known ?? "unavailable", known ? out.text : undefined),
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
