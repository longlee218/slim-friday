import type { Logger } from "pino";
import type { IntentDecision, IntentDeps } from "../intent/decide-intent";
import type { RouteProposal } from "../intent/jev/route-proposer";
import { logEvent } from "../observability/logger";
import { statusFacts } from "../orchestrator/turns/status-snapshot";
import type { RouteInput } from "./routing-policy";

/**
 * Jev on the BUSY path, SHADOW only (phase 1f, P3): while a steerable task runs, the proposer is asked in parallel
 * with the Haiku decision and its proposal is only LOGGED next to it (`routing.jev_shadow`). It never changes the
 * route, never throws and never delays the Haiku verdict: a late answer is logged with `late: true`. No text is logged.
 */

/** A started shadow request; `settle` logs it once the Haiku decision is known. */
export interface BusyShadow {
  /** Log the shadow next to the Haiku decision. Sync and non-blocking: an unfinished request logs when it ends. */
  settle(decision: IntentDecision): void;
}

/** How the Haiku decision reads, as plain labels (no text). */
function haikuAction(d: IntentDecision): Record<string, unknown> {
  if (d.kind !== "role") return { kind: d.kind };
  return { kind: d.kind, role: d.role, scope: d.scope, question: d.question === true };
}

/** Whether the proposal says the same thing as the Haiku decision; undefined when Jev did not decide (undecided / multi). */
export function shadowAgrees(p: RouteProposal, d: IntentDecision): boolean | undefined {
  if (p.kind === "undecided" || p.kind === "multi") return undefined;
  if (d.kind !== "role") return false;
  const asks = d.question === true;
  if (p.kind === "question") return asks;
  if (asks) return false;
  if (p.kind === "continue") return d.scope === "active";
  return p.kind === "pick" && p.role === d.role;
}

/**
 * Start the shadow request when it applies: engine `jev`, a proposer, and a busy message that takes steers. The task
 * sent is the running turn's role + the thread's task scope, state `running`. Returns undefined when it does not apply.
 */
export function startBusyShadow(
  i: RouteInput,
  deps: IntentDeps,
  log: Logger = i.log,
): BusyShadow | undefined {
  const px = deps.proposer;
  if (deps.engine !== "jev" || !px || !i.busy || !i.steerable) return undefined;
  const t0 = Date.now();
  const facts = statusFacts(i.db, i.threadId);
  const request: Promise<RouteProposal> = (async () =>
    px.propose(
      {
        text: i.text,
        threadId: i.threadId,
        state: "running",
        task: {
          taskId: i.active?.taskId ?? i.threadId,
          ownerRole: facts?.role ?? i.active?.ownerAgentId ?? "",
          status: "running",
          scope: i.active?.scope,
        },
        recent: i.recent ?? [],
      },
      i.signal,
    ))().catch((): RouteProposal => ({ kind: "undecided", reason: "error" }));
  let got: RouteProposal | undefined;
  let decided: IntentDecision | undefined;
  const emit = (p: RouteProposal, d: IntentDecision, late: boolean) =>
    logEvent(log, "routing.jev_shadow", {
      busy: true,
      jevKind: p.kind,
      haikuAction: haikuAction(d),
      agree: shadowAgrees(p, d),
      band: p.scores?.band,
      ms: p.scores?.ms ?? Date.now() - t0,
      ...(late && { late: true }),
    });
  void request.then((p) => {
    got = p;
    // The Haiku decision came first: this answer is late.
    if (decided) emit(p, decided, true);
  });
  return {
    settle(decision) {
      decided = decision;
      if (got) emit(got, decision, false);
    },
  };
}
