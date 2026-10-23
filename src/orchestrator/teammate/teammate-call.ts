import { createHash } from "node:crypto";
import type { Reply } from "../../effects/reply";
import type { OwnerLanguage } from "../../ingress/user-copy";
import { orchestrateAudit } from "../../mcp/orchestration/tools/OrchestrateTool/action-names";
import { ORCHESTRATE_TOOL } from "../../mcp/orchestration/tools/OrchestrateTool/constants";
import { refusalLevel } from "../../observability/failure-level";
import { logEvent, logger } from "../../observability/logger";
import type { EventKind } from "../events/event-types";
import type { EffectPort } from "../goal/effect-port";
import type { PlanSideEffects } from "../plan/plan-side-effects";

/* Wrapper of every teammate tool call: idempotency, the `teammate.decision` log line and the thread event. The handlers
   decide; this only records. */

/** Logger of this module. */
const log = logger.child({ module: "teammate-call" });

/** What a handler needs about the teammate run it serves (built per run; `run` is the run's mutable counters). */
export interface TeammateToolContext {
  port: EffectPort;
  threadId: string;
  /** Turn id of this teammate run (log field). */
  teammateTurnId: string;
  /** Id of the teammate input that triggered the run (idempotency key). */
  inputId: string;
  correlationId?: string;
  /** Language of the owner's message (owner-facing posts of a handler; absent = Vietnamese). */
  language?: OwnerLanguage;
  run: { dispatched: number; ownerAnswers?: string[] };
  /** Where the run lives, for `Orchestrate register_location` (absent in tests that never call it). */
  place?: TeammatePlace;
  /** Plan artifacts and the owner line of `create_plan` / `revise_plan` (absent in tests that do not check them). */
  plan?: PlanSideEffects;
}

/** Facts `Orchestrate register_location` needs about the run: its thread's space and channel (from code, never the model) and its trigger. */
export interface TeammatePlace {
  /** AGENT_HOME. */
  home: string;
  workspace: string;
  /** Channel (yaml name), for the confirm text. */
  channel?: string;
  channelId: string;
  /** What woke the teammate: only an `owner` run may register a location (an announce run carries worker text = DATA). */
  trigger: "owner" | "announce";
  /** The owner's text of an `owner` run (merged messages); the path must appear in it. */
  ownerText?: string;
  /** Re-read the thread's locations after a write (teammate ctx and port env), so the same run can dispatch to it. */
  refresh(): void;
}

/** What a handler returns: the reply plus the events and audit ids to record. */
export interface Outcome {
  reply: Reply;
  /** Natural thread events (a steer = one `steer`); none = one `teammate_decision` event. */
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
  /** Audit row overrides (default: scope "teammate tool call", granted by "role"). */
  audit?: { scope: string; grantedBy: string };
}

/** Idempotency key: thread + teammate input + tool + action + a hash of the arguments (the same call twice is one effect). */
const callKey = (threadId: string, inputId: string, action: string, args: unknown): string =>
  `${threadId}:${inputId}:${ORCHESTRATE_TOOL}:${action}:${createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 16)}`;

/** Options of one call. */
export interface CallOpts {
  /** A pure read: never cached, no event, no audit row (only the log line). */
  read?: true;
  /** Never replay a stored reply: the call changes state that can change back (update 10 -> 0 -> 10). Each call is its own effect. */
  fresh?: true;
}

/**
 * Run one `Orchestrate` action. A mutation that already succeeded under the same key replays its stored reply (one effect); a
 * refusal is never stored, so it is not replayed once the blocker is gone. A new call runs `act(key)`, writes the thread
 * event(s) (events carry `by: "teammate"` so announce skips them), the audit row on success, and one `teammate.decision` log line.
 * A read skips the db entirely.
 */
export async function teammateCall(
  ctx: TeammateToolContext,
  action: string,
  args: unknown,
  act: (key: string) => Promise<Outcome> | Outcome,
  opts: CallOpts = {},
): Promise<Reply> {
  const key =
    callKey(ctx.threadId, ctx.inputId, action, args) +
    (opts.fresh ? `:${crypto.randomUUID()}` : "");
  if (!opts.read && !opts.fresh) {
    const stored = ctx.port.recall(key);
    if (stored) return JSON.parse(stored) as Reply;
  }
  const out = await act(key);
  const code = out.reply.ok ? undefined : out.reply.code;
  if (!opts.read && !out.recorded) {
    const events = out.events?.length
      ? out.events
      : [
          {
            kind: "teammate_decision" as const,
            payload: { tool: ORCHESTRATE_TOOL, action, ok: out.reply.ok, code },
          },
        ];
    for (const [i, e] of events.entries()) {
      ctx.port.appendEvent({
        // A refusal is not stored, so its events get a fresh id (a later success under the same key must still write its own).
        id: out.reply.ok ? `${key}:${i}` : `${key}:refused:${crypto.randomUUID()}`,
        kind: e.kind,
        ...(e.taskId && { taskId: e.taskId }),
        ...(e.itemId && { itemId: e.itemId }),
        payload: { ...e.payload, by: "teammate", tool: ORCHESTRATE_TOOL, action },
        ...(ctx.correlationId && { correlationId: ctx.correlationId }),
      });
    }
    if (out.reply.ok)
      ctx.port.remember(key, {
        tool: orchestrateAudit(action),
        reply: JSON.stringify(out.reply),
        ...(out.goalId && { goalId: out.goalId }),
        ...(out.itemId && { itemId: out.itemId }),
        ...(out.audit && out.audit),
      });
  }
  logEvent(
    log,
    "teammate.decision",
    {
      tool: ORCHESTRATE_TOOL,
      action,
      ok: out.reply.ok,
      code,
      key,
      teammateTurnId: ctx.teammateTurnId,
    },
    refusalLevel(out.reply.ok, code),
  );
  return out.reply;
}
