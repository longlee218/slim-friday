import type { IntentDecision } from "../intent/decide-intent";
import { needsTaskConfirm } from "../intent/decide-with-model";
import { ROLES } from "../roles/role-registry";
import type { RouteProposal } from "./route-proposer";
import type { TaskState } from "./routing-contracts";

/** The question for a message that holds several requests. */
const multiText = (roles: string[]) =>
  `That looks like more than one request (${roles.join(", ")}). Which one should I do first?`;

/** A proposal as an intent decision; undefined = not usable here (Haiku L3 follows). `owner` = the waiting task a `continue` refers to. */
export function decisionOfProposal(
  p: RouteProposal,
  owner: TaskState | undefined,
  ctx: { state: string; lastRole?: string },
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
    case "pick":
      // Same discussion guard as an L3 pick: a task right after an answering turn is confirmed first.
      return ROLES[p.role]
        ? {
            kind: "role",
            role: p.role,
            scope: "new",
            ...(needsTaskConfirm({ scope: "new", role: p.role, ...ctx }) && { confirmDev: true }),
          }
        : undefined;
    default:
      return undefined;
  }
}
