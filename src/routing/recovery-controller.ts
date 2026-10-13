import type { AgentPreflightResult, ReasonCode } from "./routing-contracts";

/** Recovery after a preflight: at most this many reroutes per user turn (no loops, no random route). */
export const MAX_REROUTES_PER_TURN = 1;

/** One question when a request needs several agents (registry names, no tag or command instructions). */
export const collaborationText = (roles: string[]): string =>
  `This needs more than one agent${roles.length ? ` (${roles.join(", ")})` : ""}. Which part should I start with?`;

/** What recovery remembers within one user turn. */
export interface RecoveryState {
  rerouted: boolean;
  /** Roles already tried this turn (the first candidate included). */
  visited: string[];
}

/** What `nextStep` needs besides the preflight result. */
export interface RecoveryCtx {
  /** The entry role: the last stop when nobody else can take a reroutable reject. */
  entryRole: string;
  /** The failed check can be fixed by another role (an owner-fixable failure, e.g. no cap problem). */
  reroutable: boolean;
  /** A reroute is allowed at all (an explicit `[tag]` is the owner's own choice: never rerouted). */
  allowReroute: boolean;
  /** The legacy reply of the failed check (kept unchanged when no reroute applies). */
  reply: string;
}

/** The one thing to do next. */
export type RecoveryStep =
  | { kind: "execute" }
  | { kind: "reroute"; role: string }
  | { kind: "clarify"; text: string; reasonCode: ReasonCode }
  | { kind: "safe_fail"; text: string; reasonCode: ReasonCode };

/**
 * Pure next step after one preflight result (owner doc §7, RE_ROUTE max 1 per turn):
 * accept -> execute; need_clarification -> one question; needs_collaboration -> one question naming the roles;
 * reject -> reroute to the best unvisited candidate (else the entry role), but only once and never to a visited
 * role; a second reject, or a reject nobody can fix, is a clarify / safe fail with the legacy reply.
 */
export function nextStep(
  result: AgentPreflightResult,
  state: RecoveryState,
  ctx: RecoveryCtx,
): RecoveryStep {
  const { reasonCode } = result;
  switch (result.decision) {
    case "accept":
      return { kind: "execute" };
    case "need_clarification":
      return { kind: "clarify", text: ctx.reply, reasonCode };
    case "needs_collaboration":
      return {
        kind: "clarify",
        text: collaborationText(result.suggestedAgents),
        reasonCode,
      };
    case "reject": {
      // Not fixable by another role (e.g. the task cap): the legacy reply, nothing else to try.
      if (!ctx.reroutable || !ctx.allowReroute || state.rerouted)
        return { kind: "safe_fail", text: ctx.reply, reasonCode };
      // Ranked candidates (Jev probabilities, else registry order); none -> the entry role keeps the thread.
      const ranked = result.suggestedAgents.filter((r) => !state.visited.includes(r));
      const next = ranked[0] ?? (state.visited.includes(ctx.entryRole) ? undefined : ctx.entryRole);
      return next
        ? { kind: "reroute", role: next }
        : { kind: "clarify", text: ctx.reply, reasonCode };
    }
  }
}
