import type { HubContext } from "../hub/hub-context";
import type { InboundTurn } from "../ports/agent-runtime";
import type { RunExec } from "./run-exec";
import { runKindOf, silenceAllowed } from "./run-kind";

/** Most continue nudges one run gets (spec §6.5). */
export const MAX_NUDGES = 3;

/** Rakazo's continue nudge (R§8), "user" read as the owner. */
export const NUDGE_TEXT =
  "Your last turn ended right after a tool result, without a reply. Continue the original task from the latest tool result. If you need information or a decision from the owner, ask them instead of guessing; otherwise use any remaining tools needed, then give the owner the final answer.";

/** Why a run fails after its nudges are used up; the owner is told exactly this. */
export const NO_FINAL_ANSWER =
  "The tools finished, but the bot did not write a final answer. Rephrase the request and try again.";

/** The failure of a run out of nudges: fatal (no retry); `notice` is told to the owner as it is. */
export function noFinalAnswerError(): Error {
  return Object.assign(new Error(NO_FINAL_ANSWER), { retryable: false, notice: NO_FINAL_ANSWER });
}

/** The automated turn that carries a nudge, in the conversation the run answers now. */
function nudgeTurn(ctx: HubContext, exec: RunExec): InboundTurn {
  return {
    conversationId: exec.current.conversationId,
    from: { kind: "system" },
    text: NUDGE_TEXT,
    hop: exec.current.hop,
    context: [],
    automated: true,
    now: ctx.deps.clock.now(),
    timeZone: ctx.deps.timeZone?.() ?? "UTC",
  };
}

/**
 * Called at a `turn_end` with no background task open (a turn that ends while one runs waits for it and is never
 * nudged). A turn whose last event was a tool result, with no text after it, gets a nudge pushed as an automated
 * turn while `exec.nudges < MAX_NUDGES` ("nudged"; the count is stored on the row, so a resumed run keeps it);
 * past that the run fails ("fail"). Any other turn end is "done", also one with unread steering pushes or a lost
 * lease, and one of a run that may stay silent (`silenceAllowed`: a ticket, a bot `fyi` that answers no request):
 * such a run may end right after a tool result, so a nudge would only buy an extra turn that ends silently.
 */
export async function nudgeOrEnd(
  ctx: HubContext,
  exec: RunExec,
): Promise<"nudged" | "fail" | "done"> {
  if (!exec.lastWasToolResult || exec.stop || !exec.session) return "done";
  // Steering pushed after the last tool result was not read: the run ends and a continuation run carries those
  // messages (a nudge would answer them too, and the continuation again).
  if (exec.pushed.length > 0) return "done";
  if (silenceAllowed(exec.row, runKindOf(exec.row))) return "done";
  if (exec.nudges >= MAX_NUDGES) return "fail";
  exec.lastWasToolResult = false;
  const { id, leaseFence } = exec.row;
  const nudges = exec.nudges + 1;
  // A lost lease (the fence refuses the write): this worker no longer owns the run, so it sends nothing.
  if (!(await ctx.deps.store.wakes.transition(id, leaseFence, ["running"], { nudges })))
    return "done";
  exec.nudges = nudges;
  exec.turnOpen = true;
  exec.session.send(nudgeTurn(ctx, exec));
  return "nudged";
}
