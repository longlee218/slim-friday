import type { Database } from "bun:sqlite";
import type { AgentConfig } from "../../config/agent-config";
import type { Location } from "../../locations/location-registry";
import { logger, setLogContext, tryLog } from "../../observability/logger";
import { setTurnLocation } from "../../storage/run-store";
import type { FlowResult } from "../turns/turn-result";
import type { RoleRunInput } from "./role-run-types";

/* What the app reads from the END of a background run's report (`location: <name>`) and how a failure is tagged. */

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "run-report" });

/** The last non-empty line of the form `location: <name>` (optionally a bullet, bold or in backticks). */
const LOCATION_LINE = /^\s*[-*]?\s*\**location\**\s*:\s*`?([\w.-]+)`?\s*$/i;

/**
 * Split the final report into text + the location the agent named on its last non-empty line `location: <name>`. The line is removed from the
 * text; the name counts only when it is one of `locations` (case-insensitive, returned as registered). No valid marker =
 * no location (the ledger shows `*`).
 */
export function extractLocationMarker(
  text: string,
  locations: Location[],
): { text: string; location?: Location } {
  const lines = text.split("\n");
  // Only the LAST non-empty line can be the marker (a `location:` line earlier in the report is just text).
  const at = lines.findLastIndex((l) => l.trim() !== "");
  if (at < 0 || !LOCATION_LINE.test(lines[at] ?? "")) return { text };
  const name = LOCATION_LINE.exec(lines[at] ?? "")?.[1]?.toLowerCase();
  const rest = [...lines.slice(0, at), ...lines.slice(at + 1)].join("\n").trimEnd();
  return { text: rest, location: locations.find((r) => r.name.toLowerCase() === name) };
}

/**
 * Close a background run. A failure is returned as is (the lead re-dispatches the goal). A success names its location on the last `location:` line (validated against the workspace locations): the turn row, the
 * log context follow it. No valid marker = no location: the ledger shows `*`. A `Memory:` block in the report is plain text
 * (lessons are saved by the agent during the run with its memory tool).
 */
export function closeBackgroundRun(
  d: { db: Database; config: AgentConfig },
  i: RoleRunInput,
  res: FlowResult,
): FlowResult {
  if (res.outcome !== "success") return res;
  const marked = extractLocationMarker(res.text, i.locations);
  const location = marked.location ?? i.locations.find((r) => r.name === res.location);
  if (location) {
    setLogContext({ location: location.name });
    tryLog(log, "set turn location failed", () => setTurnLocation(d.db, i.turnId, location.name));
  }
  return { ...res, text: marked.text, location: location?.name ?? "*" };
}
