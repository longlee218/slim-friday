import type { Database } from "bun:sqlite";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { logEvent, logger, tryLog } from "../observability/logger";
import { contextWindowFor } from "../observability/model-usage";
import type { RunRecorder } from "../observability/record-run";
import { errText } from "../observability/redact";
import { createRunGauges } from "../observability/run-gauges";
import {
  addUsage,
  emptyUsage,
  type ResultShape,
  type RunOutcome,
  type RunUsage,
  usageFromResult,
} from "../observability/run-usage";
import { createTurnUsage } from "../observability/turn-usage";
import { setTurnSession } from "../storage/run-store";
import { isTransientError } from "./failure-class";
import { isQuotaFailure, resetFromInfo } from "./run-errors";
import { isSandboxFailure } from "./sandbox-errors";
import { assistantText, classifyResult } from "./stream-result";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "run-stream" });

/** Prompt of `query`: one string, or a streaming input the owner can add to (background role, run-input-channel.ts). */
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
  /** Last assistant message that had text; undefined = none (budget-hit message). */
  lastText?: string;
  /** Raw error text when the required OS sandbox could not start (sandbox-errors.ts). */
  sandboxFailure?: string;
  /** The failure named a transient provider / network error: the worker policy resumes it. */
  transient?: true;
}

/**
 * Consume the SDK message stream of one run: record every message, remember the session id at init, collect
 * the quota evidence and turn the final `result` (or a throw, or an abort) into one outcome. Never throws.
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
  /** Sees every stream message: logs the permission mode and classifier denials (permission-watch.ts). */
  permissionWatch?: (msg: SDKMessage) => void;
  /** Streaming input: called for every stream message first (echo tracking, hold timer). */
  onMessage?: (msg: SDKMessage) => void;
  /** Streaming input: called on each `result`; the caller closes the channel or keeps it open for an un-echoed steer. */
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
  /** A transient provider / network error was seen (see failure-class.ts). */
  let transient = false;
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
        const v = classifyResult(r, { assistantError, rejected });
        ({ outcome, text } = v);
        usage = addUsage(usage, usageFromResult(r, 0)); // several results per run: see addUsage
        sandboxFailure = v.sandboxFailure ?? sandboxFailure;
        transient = v.transient ?? transient;
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
      transient = !rejected && isTransientError(errors);
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
    ...(transient && outcome !== "success" && { transient: true as const }),
  };
}
