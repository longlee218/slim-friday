import type { Database } from "bun:sqlite";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { GIT_MCP_SERVER } from "../mcp/mcp-tool-names";
import { logger, tryLog } from "../observability/logger";
import {
  addUsage,
  emptyUsage,
  outcomeFromSubtype,
  type ResultShape,
  type RunOutcome,
  type RunRecorder,
  type RunUsage,
  usageFromResult,
} from "../observability/record-run";
import { errText, redactText } from "../observability/redact";
import { setTaskSession } from "../storage/run-store";
import { isQuotaFailure, RESUME_FAILED, resetFromInfo } from "./run-errors";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "run-stream" });

/** What `query` takes as prompt: one string (qa), or a streaming input the owner can add to (plan / exec, see run-input-channel.ts). */
export type QueryPrompt = string | AsyncIterable<SDKUserMessage>;

/** Signature of the SDK `query` function; injectable for tests. */
export type QueryFn = (args: {
  prompt: QueryPrompt;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

/** What a finished stream says about the run. */
export interface StreamResult {
  /** Reply text (answer, or error description). */
  text: string;
  sessionId: string | undefined;
  outcome: RunOutcome;
  usage: RunUsage;
  /** Quota outcome: when the limit resets (epoch ms), if the SDK reported it. */
  resetsAt?: number;
  /** Last assistant message that had text (what the agent last said); undefined = none. Used by the budget-hit message. */
  lastText?: string;
}

/** Text blocks of an assistant message, joined; empty when it only called tools. */
function assistantText(m: SDKMessage): string {
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

/** Outcome for a run that ended by abort: timeout if our timer fired, else user stop. */
const abortOutcome = (timedOut: boolean): RunOutcome => (timedOut ? "timeout" : "aborted");

/**
 * Consume the SDK message stream of one run: record every message, remember the session id at init, collect
 * the quota evidence, fail fast when a required git MCP server did not start, and turn the final `result`
 * message (or a throw, or an abort) into one outcome. Never throws.
 */
export async function consumeStream(p: {
  run: QueryFn;
  prompt: QueryPrompt;
  options: Options;
  recorder: RunRecorder;
  ac: AbortController;
  /** True when our own run timer fired (relabels an abort as `timeout`). */
  timedOut: () => boolean;
  db: Database;
  taskId: string;
  cwd: string;
  /** The stage is useless without its git tools (it commits): abort when that server is not connected. */
  requireGit: boolean;
  resume?: string;
  /** Streaming input: called for every stream message first (echo tracking, hold timer). */
  onMessage?: (msg: SDKMessage) => void;
  /**
   * Streaming input: called on each `result` with its subtype. The caller closes the channel (the CLI exits once its
   * input ends) or keeps it open to wait for a steer that was not echoed yet (the CLI answers it with its own `result`).
   */
  onResult?: (subtype: string) => void;
}): Promise<StreamResult> {
  const { ac, recorder } = p;
  let text = "";
  let sessionId: string | undefined;
  let outcome: RunOutcome = "error";
  let usage = emptyUsage();
  let compactions = 0;
  let startupError = "";
  /** Quota evidence: last assistant `error`, a rejected rate_limit_event (with its reset time). */
  let assistantError: string | undefined;
  let rejected = false;
  let resetsAt: number | undefined;
  let lastText: string | undefined;
  try {
    for await (const msg of p.run({ prompt: p.prompt, options: p.options })) {
      recorder.logMessage(msg);
      p.onMessage?.(msg);
      const m = msg as SDKMessage & { subtype?: string; session_id?: string };
      sessionId = m.session_id ?? sessionId;
      if (m.type === "system" && m.subtype === "compact_boundary") compactions++;
      // Record the session on the task row at once (not in `sessions`: that table is only updated by a
      // successful finish, so a failed run never replaces the thread's good session). Resume reads it.
      if (m.type === "system" && m.subtype === "init" && m.session_id) {
        const sid = m.session_id;
        tryLog(log, "early session save failed", () => setTaskSession(p.db, p.taskId, sid, p.cwd));
      }
      const ext = m as unknown as { error?: string; rate_limit_info?: { status?: string } };
      // A later assistant message without `error` means the SDK retry worked: forget the old error.
      if (m.type === "assistant") {
        assistantError = ext.error;
        const said = assistantText(m);
        if (said) lastText = said;
      }
      if (m.type === "rate_limit_event") {
        // Raw shape at debug: the real payload of limit events is still being learned.
        log.debug({ info: ext.rate_limit_info }, "rate_limit_event");
        if (ext.rate_limit_info?.status === "rejected") {
          rejected = true;
          resetsAt = resetFromInfo(ext.rate_limit_info);
        }
      }
      // A committing stage is useless without its git tools: fail fast instead of letting the model flail.
      if (m.type === "system" && m.subtype === "init" && p.requireGit) {
        const servers = (m as unknown as { mcp_servers?: { name: string; status: string }[] })
          .mcp_servers;
        const git = servers?.find((x) => x.name === GIT_MCP_SERVER);
        if (git && git.status !== "connected") {
          startupError =
            "The git MCP server failed to start (check gitAuthor in the workspace config.yaml).";
          ac.abort();
        }
      }
      if (m.type === "result") {
        const r = m as unknown as ResultShape;
        p.onResult?.(r.subtype);
        outcome = outcomeFromSubtype(r.subtype);
        text = r.subtype === "success" ? (r.result ?? "") : (r.errors ?? []).join("; ");
        usage = addUsage(usage, usageFromResult(r, 0)); // several results per run: see addUsage
        // Failure (error subtype, or success flagged is_error): quota, or unknown (raw error to the log only).
        if (outcome === "error" || (outcome === "success" && r.is_error)) {
          const errors = outcome === "error" ? text : (r.result ?? "");
          if (isQuotaFailure({ subtype: r.subtype, errors, assistantError, rejected })) {
            outcome = "quota";
            text = "";
          } else if (outcome === "error") {
            log.warn({ subtype: r.subtype, err: redactText(errors) }, "run failed");
            // Only a failed resume needs the raw text (handle-task drops the stale session); else generic reply.
            if (!RESUME_FAILED.test(errors)) text = "";
          }
        }
      }
    }
  } catch (err) {
    // max_turns/max_budget throw AFTER the result message (outcome already set).
    // Abort throws "process aborted" with no result message.
    if (outcome === "error" && !ac.signal.aborted) text = "Agent error";
    log.warn({ err: errText(err), outcome }, "query loop ended with throw");
    // A limit can also surface only as a thrown error (no result message).
    if (outcome === "error" && !ac.signal.aborted) {
      const errors = errText(err);
      if (isQuotaFailure({ errors, assistantError, rejected })) {
        outcome = "quota";
        text = "";
      }
    }
  }
  // No result message + abort (user stop or our timeout): relabel once, for throw or clean end.
  if (outcome === "error" && ac.signal.aborted) outcome = abortOutcome(p.timedOut());
  if (startupError) {
    outcome = "error";
    text = startupError;
  }
  return { text, sessionId, outcome, usage: { ...usage, compactions }, resetsAt, lastText };
}
