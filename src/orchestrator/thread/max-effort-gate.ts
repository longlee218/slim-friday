import type { ApprovalGateway } from "../../approvals/approval-types";
import type { TaskClass } from "../../config/model-routing";
import { type OwnerLanguage, renderUserNotice } from "../../ingress/user-copy";
import type { EffortSignals } from "../../intent/effort-signals";
import { ownerConfirm } from "../engine/owner-confirm";
import type { EffortFloors } from "./effort-floor";
import { type TurnEffort, turnEffort } from "./turn-effort";

/* Effort `max` (Opus, costly) runs only after the owner-confirm gate says yes. */

/** One line put before the reply when the owner did not confirm: the run went on at `high`. */
export const MAX_DECLINED_NOTICE = "Max effort not confirmed: ran at high.";

/**
 * Settle a `pendingMax` turn: ask the owner with buttons. Yes -> the turn is resolved again with `max`
 * confirmed (the floor is already raised, so no second raise); no / timeout / stop / no button flow -> the turn
 * stays at the capped `high` and `declined` says so (fails closed: never Opus without a yes).
 */
export async function settleMaxEffort(a: {
  approvals: ApprovalGateway | undefined;
  floors: EffortFloors;
  threadId: string;
  /** Owner's conversation language for the question and buttons. */
  language: OwnerLanguage;
  cls: TaskClass | undefined;
  signals: EffortSignals;
  turn: TurnEffort;
  signal: AbortSignal;
}): Promise<{ turn: TurnEffort; declined: boolean }> {
  const yes = await ownerConfirm(a.approvals, {
    kind: "max_effort",
    turnId: crypto.randomUUID(),
    threadId: a.threadId,
    summary: renderUserNotice({ kind: "label", state: "max-effort" }, a.language),
    language: a.language,
    signal: a.signal,
  });
  if (!yes) return { turn: a.turn, declined: true };
  const turn = turnEffort(a.floors, a.threadId, a.cls, { ...a.signals, floorDelta: 0 }, true);
  return { turn, declined: false };
}
