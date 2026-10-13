import type { ReasonCode, RoutingSource } from "../src/routing/routing-contracts";

/* Deterministic routing golden cases (data only; runner: routing-policy-golden.test.ts). Fake Jev + fake Haiku: no paid call. */

/** Symbolic roles: `bg` = a background role (owns tasks), `fg` = a foreground role. Resolved from the registry at run time. */
export type Sym = "bg" | "fg";

/** Thread before the message: new, a waiting background task, or the last turn answered by a fg / bg role. */
export type Setup = "new" | "waiting" | "afterFg" | "afterBg";

/** Scripted Jev reply: probabilities by role / `unclear`, optional Noul numbers, or a failure. */
export type JevScript =
  | { p: Partial<Record<Sym | "unclear", number>>; multi?: number; cont?: number; fits?: number }
  | { fail: "error" | "timeout" | "invalid" };

/** One labeled case. `{fg}` / `{bg}` in `text` is replaced by that role's `[tag]`. */
export interface RoutingCase {
  id: string;
  lang: "en" | "vi";
  text: string;
  setup: Setup;
  /** Engine under test; default `jev`. `haiku` = the legacy order (no proposer). */
  engine?: "jev" | "haiku";
  /** Absent = no proposer (no key). */
  jev?: JevScript;
  /** Scripted Haiku answer: a role, or `fail` (throws: history / entry default follows). Default `fg`. */
  haiku?: Sym | "fail";
  expect: {
    /** The role that runs, or `ask` (one clarify question). */
    role: Sym | "ask";
    source: RoutingSource;
    /** Reason code of the decision, when the case pins it. */
    rationale?: ReasonCode;
    /** The message continues the waiting task (default: not). */
    continues?: boolean;
    /** Exact Haiku / Jev call counts, when the case pins them. */
    haikuCalls?: number;
    jevCalls?: number;
  };
  /** Human labels, the same shape the metrics CLI reads (`expectedOwner` = role that must own the message). */
  labels: { continuity?: true; topicSwitch?: true; expectedOwner?: Sym };
}

export const FG_SURE: JevScript = { p: { fg: 0.9, bg: 0.05, unclear: 0.05 } };
export const BG_SURE: JevScript = { p: { bg: 0.95, fg: 0.03, unclear: 0.02 } };
export const UNSURE: JevScript = { p: { fg: 0.45, bg: 0.4, unclear: 0.15 } };
export const UNCLEAR: JevScript = { p: { unclear: 0.7, fg: 0.15, bg: 0.15 } };
