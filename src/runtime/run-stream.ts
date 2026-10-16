import type { Database } from "bun:sqlite";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { logEvent, logger, tryLog } from "../observability/logger";
import { contextWindowFor } from "../observability/model-usage";
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
import { createRunGauges } from "../observability/run-gauges";
import { createTurnUsage } from "../observability/turn-usage";
import { setTurnSession } from "../storage/run-store";
import { isQuotaFailure, RESUME_FAILED, resetFromInfo } from "./run-errors";
import { isSandboxFailure } from "./sandbox-errors";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "run-stream" });

/** What `query` takes as prompt: one string (an answer run), or a streaming input the owner can add to (a background role, see run-input-channel.ts). */
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
  /** The raw error text when the run failed because the required OS sandbox could not start (see sandbox-errors.ts). */
  sandboxFailure?: string;
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

/**
 * Consume the SDK message stream of one run: record every message, remember the session id at init, collect
 * the quota evidence and turn the final `result`
 * message (or a throw, or an abort) into one outcome. Never throws.
 */
export async function consumeStream(p: {
  run: QueryFn;
  prompt: QueryPrompt;
  options: Options;
  recorder: RunRecorder;
  ac: AbortController;
  db: Database;
  turnId: string;
  cwd: string;
  resume?: string;
  /** Sees every stream message: logs the actual permission mode and classifier denials (permission-watch.ts). */
  permissionWatch?: (msg: SDKMessage) => void;
  /** Streaming input: called for every stream message first (echo tracking, hold timer). */
  onMessage?: (msg: SDKMessage) => void;
  /**
   * Streaming input: called on each `result` with its subtype. The caller closes the channel (the CLI exits once its
   * input ends) or keeps it open to wait for a steer that was not echoed yet (the CLI answers it with its own `result`).
   */
  onResult?: (subtype: string) => void;
  /** Called once per distinct model call of the MAIN agent (1-based): the run supervisor counts turns. */
  onTurn?: (turn: number) => void;
  /** Called with each assistant message that has text (the agent's latest progress note). */
  onProgress?: (text: string) => void;
}): Promise<StreamResult> {
  const { ac, recorder } = p;
  let text = "";
  let sessionId: string | undefined;
  let outcome: RunOutcome = "error";
  let usage = emptyUsage();
  let compactions = 0;
  /** Quota evidence: last assistant `error`, a rejected rate_limit_event (with its reset time). */
  let assistantError: string | undefined;
  let rejected = false;
  let resetsAt: number | undefined;
  let lastText: string | undefined;
  /** Raw error text when the required sandbox could not start. */
  let sandboxFailure: string | undefined;
  const turns = createTurnUsage(); // one `llm.turn` line per distinct model call
  const gauges = createRunGauges(recorder.denied); // context peak/last, tool errors vs guard denials
  try {
    for await (const msg of p.run({ prompt: p.prompt, options: p.options })) {
      recorder.logMessage(msg);
      p.permissionWatch?.(msg);
      p.onMessage?.(msg);
      const m = msg as SDKMessage & { subtype?: string; session_id?: string };
      sessionId = m.session_id ?? sessionId;
      if (m.type === "system" && m.subtype === "compact_boundary") {
        compactions++;
        tryLog(log, "compact.boundary log failed", () => {
          const meta = (m as { compact_metadata?: Record<string, unknown> }).compact_metadata;
          gauges.onBoundary(Number(meta?.post_tokens));
          logEvent(log, "compact.boundary", {
            preTokens: meta?.pre_tokens,
            postTokens: meta?.post_tokens,
            trigger: meta?.trigger,
          });
        });
      }
      // Tool results the SDK flagged as errors arrive as user messages; counted, content never logged.
      if (m.type === "user") gauges.onUser(m);
      // Record the session on the turn row at once (not in `sessions`: that table is only updated by a
      // successful finish, so a failed run never replaces the thread's good session). Resume reads it.
      if (m.type === "system" && m.subtype === "init" && m.session_id) {
        const sid = m.session_id;
        tryLog(log, "early session save failed", () => setTurnSession(p.db, p.turnId, sid));
      }
      const ext = m as unknown as { error?: string; rate_limit_info?: { status?: string } };
      // A later assistant message without `error` means the SDK retry worked: forget the old error.
      if (m.type === "assistant") {
        tryLog(log, "turn usage failed", () => {
          const t = turns.onMessage(m);
          if (!t) return;
          logEvent(log, "llm.turn", t);
          gauges.onTurn(t);
          if (!t.sub) p.onTurn?.(t.turn);
        });
        assistantError = ext.error;
        const said = assistantText(m);
        if (said) {
          lastText = said;
          p.onProgress?.(said);
        }
      }
      if (m.type === "rate_limit_event") {
        // Raw shape at debug: the real payload of limit events is still being learned.
        log.debug({ info: ext.rate_limit_info }, "rate_limit_event");
        if (ext.rate_limit_info?.status === "rejected") {
          rejected = true;
          resetsAt = resetFromInfo(ext.rate_limit_info);
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
          if (isSandboxFailure(errors)) sandboxFailure = errors;
          if (isQuotaFailure({ subtype: r.subtype, errors, assistantError, rejected })) {
            outcome = "quota";
            text = "";
          } else if (outcome === "error") {
            log.warn({ subtype: r.subtype, err: redactText(errors) }, "run failed");
            // Only a failed resume needs the raw text (handle-message drops the stale session); else generic reply.
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
    if (isSandboxFailure(errText(err))) sandboxFailure = errText(err);
    // A limit can also surface only as a thrown error (no result message).
    if (outcome === "error" && !ac.signal.aborted) {
      const errors = errText(err);
      if (isQuotaFailure({ errors, assistantError, rejected })) {
        outcome = "quota";
        text = "";
      }
    }
  }
  // No result message + abort (user stop or shutdown): relabel once, for throw or clean end.
  if (outcome === "error" && ac.signal.aborted) outcome = "aborted";
  const { mainModel, ...g } = gauges.snapshot();
  const contextWindow = contextWindowFor(usage.modelUsage, mainModel);
  if (contextWindow === undefined && usage.modelUsage)
    log.debug({ mainModel, keys: Object.keys(usage.modelUsage) }, "no context window for model");
  return {
    text,
    sessionId,
    outcome,
    usage: {
      ...usage,
      compactions,
      ...g,
      ...(mainModel && { mainModel }),
      ...(contextWindow !== undefined && { contextWindow }),
    },
    resetsAt,
    lastText,
    ...(sandboxFailure && { sandboxFailure }),
  };
}
