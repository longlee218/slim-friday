import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../observability/logger";
import { redactText } from "../observability/redact";
import { outcomeFromSubtype, type ResultShape, type RunOutcome } from "../observability/run-usage";
import { isTransientError } from "./failure-class";
import { isQuotaFailure, RESUME_FAILED } from "./run-errors";
import { isSandboxFailure } from "./sandbox-errors";

/** Logger of the stream consumer (task fields come from the log context). */
const log = logger.child({ module: "run-stream" });

/** Text blocks of an assistant message, joined; empty when it only called tools. */
export function assistantText(m: SDKMessage): string {
  const content = (m as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** What one SDK `result` message says about the run. */
export interface ResultVerdict {
  outcome: RunOutcome;
  text: string;
  /** Raw error text when the required OS sandbox could not start. */
  sandboxFailure?: string;
  /** Set only when the result was a failure: a transient provider / network error was named. */
  transient?: boolean;
}

/** Turn a `result` message into outcome and text: quota, sandbox, transient and resume failures are told apart. */
export function classifyResult(
  r: ResultShape,
  ev: { assistantError?: string; rejected: boolean },
): ResultVerdict {
  let outcome = outcomeFromSubtype(r.subtype);
  let text = r.subtype === "success" ? (r.result ?? "") : (r.errors ?? []).join("; ");
  // Failure = error subtype, or success flagged is_error.
  if (!(outcome === "error" || (outcome === "success" && r.is_error))) return { outcome, text };
  const errors = outcome === "error" ? text : (r.result ?? "");
  const sandboxFailure = isSandboxFailure(errors) ? errors : undefined;
  const transient = !ev.rejected && isTransientError(errors); // read before the text is blanked
  if (transient && outcome === "success") outcome = "error"; // success + is_error + API error = failed run
  if (isQuotaFailure({ subtype: r.subtype, errors, ...ev })) {
    outcome = "quota";
    text = "";
  } else if (outcome === "error") {
    log.warn({ subtype: r.subtype, err: redactText(errors) }, "run failed");
    // Only a failed resume needs the raw text (handle-message drops the stale session); else generic reply.
    if (!RESUME_FAILED.test(errors)) text = "";
  }
  return { outcome, text, sandboxFailure, transient };
}
