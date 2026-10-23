import type { Database } from "bun:sqlite";
import type { AgentConfig } from "../../config/agent-config";
import { logger, setLogContext, tryLog } from "../../observability/logger";
import { setTurnLocation } from "../../storage/run-store";
import type { RoleRunInput } from "../run/role-run-types";
import type { FlowResult } from "../turns/turn-result";

/* Closing step of a background run. */

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "run-report" });

/**
 * Close a background run. A failure is returned as is (the teammate re-dispatches the goal). A success keeps the location the
 * run worked in (the pinned one, or the one tool hooks moved it to): the turn row and the log context follow it. No known
 * location = `*`. A `Memory:` block in the report is plain text (the teammate decides what to save with MemorySave; a worker cannot).
 */
export function closeBackgroundRun(
  d: { db: Database; config: AgentConfig },
  i: RoleRunInput,
  res: FlowResult,
): FlowResult {
  if (res.outcome !== "success") return res;
  const location = i.locations.find((r) => r.name === res.location);
  if (location) {
    setLogContext({ location: location.name });
    tryLog(log, "set turn location failed", () => setTurnLocation(d.db, i.turnId, location.name));
  }
  return { ...res, location: location?.name ?? "*" };
}
