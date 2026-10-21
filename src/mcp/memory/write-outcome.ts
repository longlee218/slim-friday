import type { MemoryToolContext } from "../../memory/memory-tool-context";
import type { MemorySaveOutcome } from "../../memory/save-note";
import {
  formatTrustedToolIssue,
  type TrustedToolIssueCode,
} from "../../runtime/trusted-tool-issue";

/** Trusted code of a refused write (shared by `MemorySave` and `MemoryEdit`); a result this map does not know is `unavailable` (no guessed cause). */
const ISSUE_OF: Record<string, TrustedToolIssueCode> = {
  too_short: "invalid_input",
  too_long: "invalid_input",
  bad_kind: "invalid_input",
  bad_id: "invalid_input",
  no_channel: "invalid_input",
  empty: "invalid_input",
  duplicate: "invalid_input",
  not_bullet: "invalid_input",
  not_found: "not_found",
  full: "limit",
  limit: "limit",
  busy: "temporarily_busy",
  symlink: "unavailable",
  not_utf8: "unavailable",
};

/**
 * Turn a failed write outcome into what the model reads: a trusted code and one next step. A known outcome keeps its
 * short text as the detail and is reported to the run supervisor; an unknown one (an exception, an unmapped result)
 * gets no detail and is never reported (it must not count toward a recovery). A successful outcome is returned as is.
 */
export function finishWriteOutcome(
  ctx: MemoryToolContext,
  tool: string,
  out: MemorySaveOutcome,
): MemorySaveOutcome {
  if (!out.isError) return out;
  const known = ISSUE_OF[out.result];
  if (known) ctx.onIssue?.({ tool, code: known });
  return {
    ...out,
    text: formatTrustedToolIssue(known ?? "unavailable", known ? out.text : undefined),
  };
}
