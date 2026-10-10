import type { ThreadState } from "../orchestrator/thread/thread-state";
import { tokenizeMessage } from "./normalize-text";

/** L1 input: the message and what the thread is waiting for. */
export interface GateAnswerInput {
  text: string;
  /** Derived thread state; the waiting states are the gates. */
  state: ThreadState;
  /** A queued proposal / ask ("run it after the current task?") is waiting for an answer. */
  pendingAsk?: boolean;
}

/** L1 result: which answer, and what it answers. */
export interface GateAnswer {
  answer: "yes" | "no";
  /** `gate` = the thread's own gate (plan approval, delivery, confirm); `ask` = a queued proposal. */
  target: "gate" | "ask";
  ruleId: string;
}

/** Thread states that are an owner gate. */
const GATE_STATES: ReadonlySet<ThreadState> = new Set([
  "awaiting_plan_approval",
  "awaiting_result",
  "awaiting_confirmation",
]);

/** Politeness / filler words dropped before matching ("ok nhe", "duyet luon a"). */
const FILLER: ReadonlySet<string> = new Set([
  "nhe",
  "nha",
  "a",
  "ah",
  "ha",
  "nghen",
  "luon",
  "giup",
]);

/** Whole-message answers (accent-free tokens; the matcher normalizes the message the same way). */
const YES = [
  "ok",
  "oke",
  "okay",
  "ok roi",
  "ok di",
  "yes",
  "y",
  "yep",
  "duyet",
  "duyet di",
  "dong y",
  "approve",
  "approved",
  "lgtm",
  "chot",
  "chot di",
  "co",
  "code di",
  "lam di",
  "chay di",
  "go ahead",
  "ship it",
  "cu lam di",
];
const NO = [
  "khong",
  "ko",
  "no",
  "n",
  "nope",
  "thoi",
  "huy",
  "tu choi",
  "reject",
  "khong duyet",
  "khong dong y",
  "khong can",
  "thoi khong can",
];

const YES_SET = new Set(YES);
const NO_SET = new Set(NO);

/**
 * L1: is the message a bare yes/no to a pending gate or ask? The WHOLE message must be the answer
 * (so "ok nhung doi ten" is feedback and falls through to L3/L4). No gate and no ask pending = never fires.
 * Runs BEFORE L3: with a plan waiting, "code di" is an approval, not a new dev task.
 */
export function matchGateAnswer(input: GateAnswerInput): GateAnswer | undefined {
  const isGate = GATE_STATES.has(input.state);
  if (!isGate && !input.pendingAsk) return undefined;
  const words = tokenizeMessage(input.text).filter((t) => t !== "|" && !FILLER.has(t));
  const key = words.join(" ");
  const target = isGate ? "gate" : "ask";
  if (YES_SET.has(key)) return { answer: "yes", target, ruleId: "L1.yes" };
  if (NO_SET.has(key)) return { answer: "no", target, ruleId: "L1.no" };
  return undefined;
}
