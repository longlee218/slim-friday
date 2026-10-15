import type { InboundMessage } from "../../ingress/discord-message-handler";
import type { Location } from "../../locations/location-registry";
import type { Proposal } from "../../storage/proposal-store";
import { type DispatchDeps, dispatchRole } from "./dispatch-role";

/** Efforts a stored proposal may carry (`max` needs the owner's yes at start time, so it is never replayed). */
const QUEUED_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high"]);

/**
 * Start the thread's pending proposal (`go` after a restart): the dispatcher gets the stored row, marked
 * confirmed (the owner said `go`, so the low-confidence question is not asked again).
 */
export function startPendingProposal(
  c: {
    deps: DispatchDeps;
    message: InboundMessage;
    workspace: string;
    channel?: string;
    /** Mode of that channel (`chat` skips the channel digest); absent = `task`. */
    channelMode?: "task" | "chat";
    locations: Location[];
    ac: AbortController;
    pinned?: Location;
  },
  p: Proposal,
  /** Owner raise of the budget (`go +<usd>`). */
  extraBudgetUsd?: number,
): Promise<string> {
  return dispatchRole(c.deps, {
    request: {
      role: p.role,
      brief: p.brief,
      location: p.location ?? undefined,
      cls: p.class ?? undefined,
      confidence: p.confidence ?? undefined,
      proposalId: p.id,
      confirmed: true,
    },
    message: c.message,
    reply: "",
    workspace: c.workspace,
    channel: c.channel,
    channelMode: c.channelMode,
    locations: c.locations,
    pinned: c.pinned,
    ac: c.ac,
    fromTurnId: p.fromTurnId ?? undefined,
    extraBudgetUsd,
    // Effort stored when the request was queued (null = role defaults); `max` never comes from here.
    effort: p.effort && QUEUED_EFFORTS.has(p.effort) ? p.effort : undefined,
  });
}
