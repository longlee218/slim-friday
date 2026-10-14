import type { RecentMessage } from "../intent/intent-types";

/**
 * Async route proposer: the slot Jev (TypeSafe System One, phase 7) plugs into. The policy asks ONE proposal per
 * routed message on an idle thread; code decides what to do with it (bands, preflight). No role names here.
 */

/** Minimum `fitsLastP` that keeps a last-responding role with side effects as the default route (calibrated on the golden set, phase 9). */
export const FIT_MIN = 0.7;

/** Numbers behind a proposal (probabilities in [0, 1]; logged as `route.decision.jev`, never text). */
export interface RouteScores {
  /** Probability per role name (higher = better); feeds the reroute order (phase 6). */
  ranking?: Record<string, number>;
  /** Probability that the message belongs to the thread's last responding role (asked only for a side-effect role). */
  fitsLastP?: number;
  /** Probability that the message continues the open task. */
  continueP?: number;
  /** Probability that the message only asks about the task's progress or result. */
  questionP?: number;
  /** Numbers behind a Jev pick, logged in `route.decision.jev` (never text): top probability, top / second ratio, Choice confidence, multi-intent probability, request ms, band label. */
  top?: number;
  ratio?: number;
  confidence?: number;
  multiP?: number;
  ms?: number;
  band?: string;
}

/** What the proposer says about one message. `undecided` covers low confidence, close top two, `unclear`, error, timeout, no key. */
export type RouteProposal = (
  | { kind: "continue" }
  | { kind: "question" }
  | { kind: "pick"; role: string; alternatives: string[] }
  | { kind: "multi"; roles: string[] }
  | { kind: "undecided"; reason: string }
) & { scores?: RouteScores };

/** Facts of the thread the proposer may use (the caller redacts / clips as it needs; phase 7 owns that). */
export interface ProposeInput {
  text: string;
  threadId: string;
  /** Derived thread state (idle / done ...). */
  state?: string;
  /** The live background task the message may continue; absent = none. */
  task?: { taskId: string; ownerRole: string; status: string; scope?: string };
  /** Role of the thread's last turn, when there is one. */
  lastRole?: string;
  recent: RecentMessage[];
}

export interface RouteProposer {
  /** Never throws: any failure is an `undecided` proposal. `signal` aborts the call (`/stop`, shutdown). */
  propose(input: ProposeInput, signal?: AbortSignal): Promise<RouteProposal>;
}

/** Default proposer: always undecided (engine `jev` without a client, or before phase 7). */
export const undecidedProposer: RouteProposer = {
  propose: async () => ({ kind: "undecided", reason: "no_proposer" }),
};
