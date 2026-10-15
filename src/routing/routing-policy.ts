import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import {
  type DecideInput,
  decideIntent,
  type IntentDecision,
  type IntentDeps,
} from "../intent/decide-intent";
import { isIdleState } from "../intent/decide-with-model";
import type { EffortSignals } from "../intent/effort-signals";
import type { RecentMessage } from "../intent/intent-types";
import type { ProposeInput, RouteProposal, RouteScores } from "../intent/jev/route-proposer";
import { withSpan } from "../observability/trace-spans";
import { ROLES } from "../roles/role-registry";
import { startBusyShadow } from "./jev-busy-shadow";
import { routingDecisionOf } from "./route-decision-of";
import { historyDefault, lastRoleOf } from "./route-history-default";
import { decisionOfProposal } from "./route-proposal-decision";
import type { RoutingDecision, TaskState } from "./routing-contracts";

/**
 * Routing policy of one message. Order on an idle, ungated thread without a pending question:
 * note prefix -> tag -> (engine `jev`: ONE proposer request: continue / pick / multi) -> Haiku L3 (fallback only) ->
 * unresolved: the role that answered the last turn, else the entry role. Nothing here is a role name: roles are data.
 * Pending question / gate / busy messages keep the L3 logic of `decideIntent` and only get a `RoutingDecision`.
 */

/** What the policy needs besides the intent input. */
export interface RouteInput extends DecideInput {
  db: Database;
  log: Logger;
  threadId: string;
  messageId?: string;
  /** A run of this thread holds the lock. */
  busy: boolean;
  /** Last messages of the thread (for the proposer). */
  recent?: RecentMessage[];
  /** A running task takes steers (the Jev busy shadow only runs then). */
  steerable?: boolean;
  /** The thread's focus: its newest live owned task. */
  active?: TaskState;
}

/** The decision, its trace record and what the executor must do beyond the table. */
export interface RoutePlan {
  decision: IntentDecision;
  effort: EffortSignals;
  routing: RoutingDecision;
  /** Open background task the message continues (resume its session with the owner's text). */
  continueTask?: TaskState;
  /** Proposer role probabilities (phase 6 orders reroute candidates by them). */
  ranking?: Record<string, number>;
  /** Extra `route.decision` fields (numbers / ids only). */
  extra: Record<string, unknown>;
}

/** Task statuses that can take a continuation (`running` means the thread is busy: a steer, not this). */
const CONTINUABLE: ReadonlySet<string> = new Set(["open", "waiting_user"]);

/**
 * Decide the route of one message. Returns the intent decision plus its `RoutingDecision` (source and reason code of
 * the step that decided: tag, owner continuation, Jev pick, Haiku fallback, history / entry default).
 */
export async function decideRoute(i: RouteInput, deps: IntentDeps): Promise<RoutePlan> {
  const jev = deps.engine === "jev";
  const px = deps.proposer;
  const idle = !i.busy && isIdleState(i.state) && !i.pendingQuestion;
  // A background task waiting for the owner can take this message (only background roles own tasks).
  const owner =
    idle &&
    i.active &&
    CONTINUABLE.has(i.active.status) &&
    ROLES[i.active.ownerAgentId ?? ""]?.background
      ? i.active
      : undefined;
  const ownerRole = owner?.ownerAgentId ?? undefined;

  /** The proposer's answer (a holder: it is set inside the `propose` closure). */
  const got: { proposal?: RouteProposal } = {};
  const propose =
    jev && idle && px
      ? async () => {
          const lastRole = lastRoleOf(i.db, i.threadId);
          const input: ProposeInput = {
            text: i.text,
            threadId: i.threadId,
            state: i.state,
            ...(owner &&
              ownerRole && {
                task: {
                  taskId: owner.taskId,
                  ownerRole,
                  status: owner.status,
                  scope: owner.scope,
                },
              }),
            lastRole,
            recent: i.recent ?? [],
          };
          got.proposal = await withSpan(i.log, "select_candidate", () =>
            (async () => px.propose(input, i.signal))().catch(
              (): RouteProposal => ({
                kind: "undecided",
                reason: "error",
                scores: { band: "error" },
              }),
            ),
          );
          return decisionOfProposal(got.proposal, owner);
        }
      : undefined;

  // Busy + steerable under `jev`: the proposer runs next to Haiku, logged only (never routes).
  const shadow = startBusyShadow(i, deps);
  const d = await decideIntent(
    {
      ...i,
      // Under `jev` the Haiku fallback sees the waiting task as the active one; under `haiku` it is only logged.
      hasTask: i.hasTask || (jev && !!owner),
      l3Input:
        jev && owner
          ? () => {
              const x = i.l3Input();
              return { ...x, thread: { ...x.thread, activeRole: ownerRole } };
            }
          : i.l3Input,
      propose,
    },
    deps,
  );
  shadow?.settle(d.decision);
  const { proposal } = got;
  let { decision } = d;
  const role = decision.kind === "role" ? decision.role : undefined;
  const sameAsOwner = !!role && role === ownerRole;
  const over: Partial<RoutingDecision> = {};
  let continueTask: TaskState | undefined;
  const cont = (source: RoutingDecision["source"]) => {
    continueTask = owner;
    Object.assign(over, { source, rationaleCode: "CONTEXT_CONTINUATION", taskId: owner?.taskId });
  };

  if (d.unresolved) {
    // No question: the thread's last role, else the entry role (see historyDefault).
    const h = historyDefault(i.db, i.threadId, decision, proposal?.scores?.fitsLastP, i.ownerClass);
    decision = h.decision;
    Object.assign(over, { source: "fallback", rationaleCode: h.rationaleCode });
    over.candidateAgentId = decision.kind === "role" ? decision.role : undefined;
  } else if (d.layer === "L1" && role && ROLES[role]?.background && owner) {
    // A background tag: the owner's role continues its task, another one starts a new task.
    if (sameAsOwner) cont("tag");
    else Object.assign(over, { rationaleCode: "EXPLICIT_SWITCH" });
  } else if (d.layer === "jev") {
    if (proposal?.kind === "continue") cont("owner");
    else if (proposal?.kind === "multi")
      Object.assign(over, { alternatives: proposal.roles, ambiguityFlags: ["multi_intent"] });
    else if (proposal?.kind === "pick") {
      // A pick of the waiting owner's own role (no `continue`) is a NEW task of that role, by design.
      over.alternatives = proposal.alternatives;
      if (owner && ROLES[proposal.role]?.background && !sameAsOwner)
        over.rationaleCode = "TOPIC_SWITCH"; // another background role than the waiting task's: a new task
    }
  } else if (
    d.layer === "L3" &&
    jev &&
    owner &&
    sameAsOwner &&
    decision.kind === "role" &&
    decision.scope === "active" &&
    !decision.question // a pure question never continues (resumes) the waiting task
  ) {
    cont("owner"); // the Haiku fallback read the message as about the waiting task
  }

  const scores: RouteScores | undefined = proposal?.scores;
  return {
    decision,
    effort: d.effort,
    routing: routingDecisionOf({
      messageId: i.messageId,
      threadId: i.threadId,
      decision,
      layer: d.layer,
      override: over,
    }),
    ...(continueTask && { continueTask }),
    ...(scores?.ranking && { ranking: scores.ranking }),
    extra: {
      ...(scores && { jev: scores }),
      // Shadow: under `haiku` the waiting task is only logged, never continued.
      ...(owner && !jev && { ownerCandidate: owner.taskId }),
    },
  };
}
