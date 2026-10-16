import type { Database } from "bun:sqlite";
import { logEvent, logger } from "../observability/logger";
import type { RunUsage } from "../observability/record-run";
import { errText } from "../observability/redact";
import { getRole } from "../roles/role-registry";
import { turnRole } from "../storage/run-store";
import { deleteSession, getSession } from "../storage/session-store";
import {
  getThreadSummary,
  markFlushed,
  markRolled,
  needsFlush,
} from "../storage/thread-summary-store";
import { flushMemory } from "./rollover-flush";
import type { RolloverDeps, RolloverRequest } from "./rollover-run";
import { summarizeThread } from "./rollover-summary";

export type { RolloverDeps, RolloverRequest } from "./rollover-run";

/* Thread rollover: when a finished run's context is over the share of the model window, the thread's session is
   dropped after its memory is flushed and its summary is updated; the next run starts fresh, seeded with the summary. */

/**
 * Share of the model window above which a finished run's context triggers a rollover (owner decision 2026-10-12).
 * Known trade-off: the SDK already compacts mid-run at 75% of the window, so a context rarely stays above it
 * after a run; the rollover then fires rarely and the mid-run compaction does most of the work.
 */
export const ROLLOVER_CONTEXT_SHARE = 0.75;
/** Window (tokens) when the SDK result named none: Haiku models 200k, every other model 1M. */
export const WINDOW_FALLBACK_HAIKU = 200_000;
export const WINDOW_FALLBACK_DEFAULT = 1_000_000;

const log = logger.child({ module: "thread-rollover" });

/**
 * Window of the MAIN model of a run: `modelUsage[mainModel].contextWindow` from the SDK result (`usage.contextWindow`
 * is that lookup), else a per-tier constant from the main model's id. Other models of `modelUsage` (a Haiku
 * side call) never count; an unknown main model gets the default window.
 */
export function windowOf(usage: RunUsage): number {
  if (usage.contextWindow) return usage.contextWindow;
  return /haiku/i.test(usage.mainModel ?? "") ? WINDOW_FALLBACK_HAIKU : WINDOW_FALLBACK_DEFAULT;
}

/** The run's gauges when its last model call's context is at or over the share of the window; null below it. */
export function rolloverGauges(
  usage: RunUsage | undefined,
): { contextTokens: number; window: number } | null {
  if (!usage || usage.lastContextTokens <= 0) return null;
  const window = windowOf(usage);
  return usage.lastContextTokens >= ROLLOVER_CONTEXT_SHARE * window
    ? { contextTokens: usage.lastContextTokens, window }
    : null;
}

/** Rollovers asked by `finishRun`, by TURN id (a stale entry of another path can never fire on a later turn). */
const due = new Map<string, Omit<RolloverRequest, "workspace">>();

/**
 * `finishRun` of a successful foreground run: remember that this turn's thread must roll when its context is over
 * the share. Background roles (`skipThreadSession`) never reach here. Never throws.
 */
export function requestRollover(
  db: Database,
  ids: { turnId: string; threadId: string },
  usage: RunUsage | undefined,
): void {
  try {
    const gauges = rolloverGauges(usage);
    if (!gauges) return;
    const role = turnRole(db, ids.turnId);
    const session = getSession(db, ids.threadId);
    if (!role || !session || getRole(role).kind === "worker") return;
    due.set(ids.turnId, { ...ids, role, model: usage?.mainModel, ...gauges });
  } catch (err) {
    log.warn({ err: errText(err) }, "rollover request skipped");
  }
}

/** The rollover `finishRun` asked for in this turn, once; the handler adds the workspace it knows. */
export function takeRollover(turnId: string, workspace: string): RolloverRequest | undefined {
  const req = due.get(turnId);
  due.delete(turnId);
  return req && { ...req, workspace };
}

/**
 * Run one rollover: needsFlush -> flush -> markFlushed -> summary -> drop the session -> markRolled. The caller
 * holds the per-thread lock and has posted the reply. A step that fails never stops the roll (an old summary
 * and a keyword extract are better than a session that keeps growing); an unexpected throw leaves the session alone.
 * Logs `session.rolled {contextTokens, window, flushed, summary}` (counts and enums only).
 */
export async function runRollover(d: RolloverDeps, req: RolloverRequest): Promise<void> {
  try {
    const session = getSession(d.db, req.threadId);
    if (!session || getRole(req.role).kind === "worker") return;
    // Shutdown / `/stop` / the total time cap abort the rollover: stop between steps, never roll half-way.
    const aborted = () => d.signal?.aborted === true;
    const previous = getThreadSummary(d.db, req.threadId)?.summary ?? "";
    let flushed: "llm" | "extract" | "skipped" = "skipped";
    // Once per cycle: a repeated trigger before the roll finds the cycle flushed.
    if (needsFlush(d.db, req.threadId)) {
      flushed = await flushMemory(d, req, session, previous);
      if (aborted()) {
        logEvent(log, "session.rollover_aborted", { step: "flush" });
        return;
      }
      markFlushed(d.db, req.threadId, req.workspace);
    }
    const summary = await summarizeThread(d, req, session, previous);
    if (aborted()) {
      logEvent(log, "session.rollover_aborted", { step: "summary" });
      return;
    }
    // One transaction: the session is never dropped without the roll being counted (or the reverse).
    d.db.transaction(() => {
      deleteSession(d.db, req.threadId);
      markRolled(d.db, req.threadId);
    })();
    logEvent(log, "session.rolled", {
      contextTokens: req.contextTokens,
      window: req.window,
      flushed,
      summary,
    });
  } catch (err) {
    logEvent(log, "session.rollover_failed", { err: errText(err, 200) }, "warn");
  }
}
