import { createHash } from "node:crypto";
import { logEvent, logger } from "../../observability/logger";
import type { EventKind } from "../events/event-types";
import type { EffectPort } from "./effect-port";

/* Wrapper of every lead tool call: idempotency, the `lead.decision` log line and the thread event. The handlers
   decide; this only records. */

/** Logger of this module. */
const log = logger.child({ module: "lead-call" });

/** What a handler needs about the lead run it serves (built per run; `run` is the run's mutable counters). */
export interface LeadToolContext {
  port: EffectPort;
  threadId: string;
  /** Turn id of this lead run (log field). */
  leadTurnId: string;
  /** Id of the lead input that triggered the run (idempotency key). */
  inputId: string;
  correlationId?: string;
  run: { dispatched: number };
}

/** A tool reply: facts on success, a code + message on refusal. */
export type Reply =
  | { ok: true; [k: string]: unknown }
  | { ok: false; code: string; message: string };

/** A coded refusal. */
export const refuse = (code: string, message: string): Reply => ({ ok: false, code, message });

/** What a handler returns: the reply plus the events and audit ids to record. */
export interface Outcome {
  reply: Reply;
  /** Natural thread events (a steer = one `steer`); none = one `lead_decision` event. */
  events?: {
    kind: EventKind;
    taskId?: string;
    itemId?: string;
    payload?: Record<string, unknown>;
  }[];
  goalId?: string;
  itemId?: string;
  /** The port already wrote the events and the audit row (the dispatch transaction): record nothing more. */
  recorded?: true;
}

/** Idempotency key: thread + lead input + tool + a hash of the arguments (the same call twice is one effect). */
export const callKey = (threadId: string, inputId: string, tool: string, args: unknown): string =>
  `${threadId}:${inputId}:${tool}:${createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 16)}`;

/** Options of one call. */
export interface CallOpts {
  /** A pure read: never cached, no event, no audit row (only the log line). */
  read?: true;
}

/**
 * Run one tool call. A mutation that already succeeded under the same key replays its stored reply (one effect); a
 * refusal is never stored, so it is not replayed once the blocker is gone. A new call runs `act(key)`, writes the thread
 * event(s) (events carry `by: "lead"` so announce skips them), the audit row on success, and one `lead.decision` log line.
 * A read skips the db entirely.
 */
export async function leadCall(
  ctx: LeadToolContext,
  tool: string,
  args: unknown,
  act: (key: string) => Promise<Outcome> | Outcome,
  opts: CallOpts = {},
): Promise<Reply> {
  const key = callKey(ctx.threadId, ctx.inputId, tool, args);
  if (!opts.read) {
    const stored = ctx.port.recall(key);
    if (stored) return JSON.parse(stored) as Reply;
  }
  const out = await act(key);
  const code = out.reply.ok ? undefined : out.reply.code;
  if (!opts.read && !out.recorded) {
    const events = out.events?.length
      ? out.events
      : [{ kind: "lead_decision" as const, payload: { tool, ok: out.reply.ok, code } }];
    for (const [i, e] of events.entries()) {
      ctx.port.appendEvent({
        // A refusal is not stored, so its events get a fresh id (a later success under the same key must still write its own).
        id: out.reply.ok ? `${key}:${i}` : `${key}:refused:${crypto.randomUUID()}`,
        kind: e.kind,
        ...(e.taskId && { taskId: e.taskId }),
        ...(e.itemId && { itemId: e.itemId }),
        payload: { ...e.payload, by: "lead", tool },
        ...(ctx.correlationId && { correlationId: ctx.correlationId }),
      });
    }
    if (out.reply.ok)
      ctx.port.remember(key, {
        tool,
        reply: JSON.stringify(out.reply),
        ...(out.goalId && { goalId: out.goalId }),
        ...(out.itemId && { itemId: out.itemId }),
      });
  }
  logEvent(log, "lead.decision", { tool, ok: out.reply.ok, code, key, leadTurnId: ctx.leadTurnId });
  return out.reply;
}
