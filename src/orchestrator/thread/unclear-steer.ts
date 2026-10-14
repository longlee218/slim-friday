import { entryRole, ROLES } from "../../roles/role-registry";
import type { RoleDefinition } from "../../roles/role-types";
import { isSideRole } from "./intent-table";
import type { IntentOutcome, RouteCtx } from "./route-by-intent";
import { STEER_REACT_REPLY } from "./steer-notice-sentinel";

/**
 * A steer that came from a FALLBACK (engine failure, invalid or low-confidence answer, see `supplement(.., true)`): the
 * message is already pushed into the run (never lost), and the entry role also answers it in the side lane with the status
 * snapshot, so a question the engine could not read still gets an answer. The steer line leads the answer: ONE reply.
 * A repeated steer notice (`STEER_REACT_REPLY`) adds no lead line. No side role = the steer line alone.
 */
export function steerAndAnswer(c: RouteCtx, line: { kind: "reply"; text: string }): IntentOutcome {
  const role = entryRole().name;
  if (!c.busy || !isSideRole(ROLES[role] as RoleDefinition)) return line;
  return {
    kind: "side",
    role,
    text: c.text,
    location: c.location,
    cls: c.cls,
    effort: c.effort,
    ...(line.text !== STEER_REACT_REPLY && { lead: line.text }),
  };
}
