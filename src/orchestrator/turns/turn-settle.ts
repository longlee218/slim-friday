import type { Database } from "bun:sqlite";
import { type OwnerLanguage, renderUserNotice } from "../../ingress/user-copy";
import { logEvent, logger } from "../../observability/logger";
import { ROLES } from "../../roles/role-registry";
import { STATUS_OF_RESULT } from "../../roles/typed-result";
import type { ResultKind } from "../../storage/owned-item-store";
import { ownedTaskOfTurn } from "../../storage/owned-task-store";
import { turnRole } from "../../storage/run-store";
import { moveTaskTo, settleTaskAfterTurn } from "../../tasks/task-resolver";
import { type DeliveryExpectation, missingEffects } from "./completion";
import type { FlowResult } from "./turn-result";

/** Logger of this module (same module name as `turn-result`: one log stream for the task end). */
const log = logger.child({ module: "task-result" });

/**
 * Settle the owned task of a finished turn from the typed result and the effect log. Returns the owned task id and a
 * reply note: COMPLETED on the goal's last item while a promised delivery effect has no successful row is reported,
 * NOT delivered (one neutral line, the task stays completed).
 */
export function settleTurn(
  db: Database,
  turnId: string,
  res: FlowResult,
  status: string,
  o: {
    language: OwnerLanguage;
    resultKind?: ResultKind;
    delivery?: DeliveryExpectation;
    /** Worker failure policy: true = it moved the item itself (resume or hold), skip the normal settle. */
    failurePolicy?: (res: FlowResult, status: string) => boolean;
  },
): { taskId: string | undefined; note: string } {
  const taskId = ownedTaskOfTurn(db, turnId);
  const missing =
    status === "done" && o.resultKind === "COMPLETED" && o.delivery
      ? missingEffects(db, o.delivery, taskId)
      : [];
  if (missing.length > 0) logEvent(log, "execution.undelivered", { tools: missing });
  // A `done` run of a role with side effects and no typed report is no completion: the task waits for the owner.
  const role = ROLES[turnRole(db, turnId) ?? ""];
  const noReport = status === "done" && !o.resultKind && !!role && role.sideEffects !== "none";
  if (o.failurePolicy?.(res, status)) {
    // Resumed or held by the failure policy: the task is already moved.
  } else if (o.resultKind && status === "done" && taskId)
    moveTaskTo(db, taskId, STATUS_OF_RESULT[o.resultKind]);
  else settleTaskAfterTurn(db, turnId, status, noReport);
  return {
    taskId,
    note:
      missing.length > 0
        ? `\n\n${renderUserNotice({ kind: "note", state: "no-delivery" }, o.language)}`
        : "",
  };
}
