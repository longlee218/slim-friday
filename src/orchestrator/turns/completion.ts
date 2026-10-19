import type { Database } from "bun:sqlite";
import type { RoleDefinition } from "../../roles/role-types";
import { effectsOfGoal } from "../../storage/effect-log-store";
import { childrenOf } from "../../storage/owned-item-store";
import { newestApprovedVersion } from "../../storage/work-plan-store";
import { docOfRow } from "../plan/plan-doc";

/* Completion of a worker run = its typed `Report` result + the goal's `effect_log` rows. Pure over those two. */

/** What the goal promised to deliver: the goal and the effect tools its approved plan lists in `effects`. */
export interface DeliveryExpectation {
  goalId: string;
  tools: string[];
}

/**
 * The delivery effects a run is expected to perform. They come ONLY from the approved plan's `effects` list (an explicit
 * promise to the owner). A DIRECT / DELEGATE goal, or a goal with no approved plan, expects nothing: grants are
 * permissions, not obligations. A read-only role expects none either.
 */
export function expectedDelivery(
  db: Database,
  role: RoleDefinition,
  goalId: string,
): DeliveryExpectation | undefined {
  if (role.sideEffects !== "location") return undefined;
  const approved = newestApprovedVersion(db, goalId);
  const tools = approved ? docOfRow(approved).envelope.effects : [];
  return tools.length ? { goalId, tools: [...tools] } : undefined;
}

/**
 * Expected delivery effects with no successful `effect_log` row on the goal. Evaluated only for the LAST item of the goal:
 * when any sibling of `itemId` is not completed yet (pending, ready, running, failed...) it returns none, so earlier
 * items never get the "not delivered" note. A row counts only when the effect ran (`code` 0): refused and denied calls
 * leave rows too, and they are not a delivery.
 */
export function missingEffects(db: Database, want: DeliveryExpectation, itemId?: string): string[] {
  const siblings = childrenOf(db, want.goalId).filter((i) => i.id !== itemId);
  if (siblings.some((i) => i.status !== "completed")) return [];
  const done = new Set(
    effectsOfGoal(db, want.goalId)
      .filter((e) => ranOk(e.result))
      .map((e) => e.tool),
  );
  return want.tools.filter((t) => !done.has(t));
}

/** True when an effect row's stored result says the effect ran (`{"code":0,...}`); unreadable = did not run. */
function ranOk(result: string): boolean {
  try {
    return (JSON.parse(result) as { code?: unknown }).code === 0;
  } catch {
    return false;
  }
}
