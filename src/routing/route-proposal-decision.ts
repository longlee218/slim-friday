import type { IntentDecision } from "../intent/decide-intent";
import { entryRole, ROLES } from "../roles/role-registry";
import type { RouteProposal } from "../intent/jev/route-proposer";
import type { TaskState } from "./routing-contracts";

/** The question for a message that holds several requests. */
const multiText = (roles: string[]) =>
  `That looks like more than one request (${roles.join(", ")}). Which one should I do first?`;

/** A proposal as an intent decision; undefined = not usable here (Haiku L3 follows). `owner` = the waiting task a `continue` refers to. */
export function decisionOfProposal(
  p: RouteProposal,
  owner: TaskState | undefined,
): IntentDecision | undefined {
  switch (p.kind) {
    case "multi": {
      const roles = p.roles.filter((r) => ROLES[r]);
      return roles.length > 1
        ? { kind: "ask", reason: "low_confidence", text: multiText(roles) }
        : undefined;
    }
    case "continue":
      return owner?.ownerAgentId
        ? { kind: "role", role: owner.ownerAgentId, scope: "active" }
        : undefined;
    // A pure question about the task: the entry role answers it (a new run, never a resume of the owner's session).
    case "question":
      return { kind: "role", role: entryRole().name, scope: "new", question: true };
    case "pick":
      return ROLES[p.role] ? { kind: "role", role: p.role, scope: "new" } : undefined;
    default:
      return undefined;
  }
}
