import type { Database } from "bun:sqlite";
import type { TaskClass } from "../config/model-routing";
import type { IntentDecision } from "../intent/decide-intent";
import { FIT_MIN } from "../intent/jev/route-proposer";
import { hasClassTiers, ROLES } from "../roles/role-registry";

/** Role of the thread's latest turn (any role), or undefined in a new thread. */
export const lastRoleOf = (db: Database, threadId: string): string | undefined =>
  db
    .query<{ role: string }, [string]>(
      "SELECT role FROM turns WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get(threadId)?.role;

/**
 * Nothing decided the route (no tag, no usable proposal / Haiku answer): no question. The role that answered the last
 * turn keeps the thread; a role with side effects only when the proposer says the message fits it (`fitsLastP >=
 * FIT_MIN`; no number = no). Else, or in a new thread, the entry role keeps `current`. Returns the decision and why.
 */
export function historyDefault(
  db: Database,
  threadId: string,
  current: IntentDecision,
  fitsLastP: number | undefined,
  ownerClass?: TaskClass,
): { decision: IntentDecision; rationaleCode: "HISTORY_DEFAULT" | "ENTRY_DEFAULT" } {
  const last = lastRoleOf(db, threadId);
  const role = last ? ROLES[last] : undefined;
  if (!role || (role.sideEffects !== "none" && !(fitsLastP !== undefined && fitsLastP >= FIT_MIN)))
    return { decision: current, rationaleCode: "ENTRY_DEFAULT" };
  const same = current.kind === "role" && current.role === role.name;
  return {
    rationaleCode: "HISTORY_DEFAULT",
    decision: same
      ? current
      : {
          kind: "role",
          role: role.name,
          scope: "new",
          ...(ownerClass && hasClassTiers(role) && { cls: ownerClass }),
        },
  };
}
