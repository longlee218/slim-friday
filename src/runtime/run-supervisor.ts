/* Run supervisor (pure): turns structured run events into a PLAN for the orchestration layer. It never calls the SDK,
   never sees owner text or raw tool output, and has no way to allow what the guard denied. Recovery is requested at most
   once, and only after a result (the in-flight query is never touched). */

import {
  formatTrustedToolIssue,
  TRUSTED_TOOL_ISSUE_CODES,
  type TrustedToolIssueCode,
} from "../tools/trusted-tool-issue";

/** The closed set of trusted issue codes (defined with the tools that report them). */
export const TRUSTED_ISSUE_CODES = TRUSTED_TOOL_ISSUE_CODES;
export type TrustedIssueCode = TrustedToolIssueCode;

/** Same trusted issue this many times in one run counts as repeated (a single failure is not a trigger). */
const REPEAT_THRESHOLD = 2;

/** Outcomes that are never recovered: the owner or the service ended the run. */
const NEVER_RECOVERED: ReadonlySet<string> = new Set(["aborted", "quota", "max_budget"]);

/** Events the orchestration feeds in. Only codes, outcomes, counts and delivery states: no text. */
export type RunControlEvent =
  | { kind: "model_turn"; turn: number }
  | { kind: "trusted_tool_issue"; tool: string; code: TrustedIssueCode }
  | { kind: "guard_denied"; tool: string; reasonCode: string }
  | { kind: "owner_steer_state"; state: "queued" | "held" | "delivered" | "dropped" }
  | { kind: "run_result"; outcome: string; resumable: boolean }
  | { kind: "owner_stop" };

/** What the orchestration should do next. */
export type RunControlDecision =
  | { kind: "continue" }
  | { kind: "recover_after_result"; reason: "repeated_issue" | "turn_limit"; issueCode?: string }
  | { kind: "report_incomplete"; reason: string };

/** Read-only view of the supervisor (for logs and the recovery selector). */
export interface RunControlSnapshot {
  turns: number;
  issues: Partial<Record<TrustedIssueCode, number>>;
  /** Latest delivery state of an owner steer; `delivered` only after an event said so (SDK replay). */
  steer?: "queued" | "held" | "delivered" | "dropped";
  stopped: boolean;
  guardDenied: boolean;
  recommendation: "none" | "recover_after_result";
}

/** Build the supervisor of one owner message. `alreadyRecovered` = the single recovery slot is spent. */
export function createRunSupervisor(o: { maxTurns: number; alreadyRecovered: boolean }) {
  let turns = 0;
  const issues: Partial<Record<TrustedIssueCode, number>> = {};
  let steer: RunControlSnapshot["steer"];
  let stopped = false;
  let guardDenied = false;
  /** A result said the turn ceiling was hit (the effort-scaled ceiling is only known to the SDK). */
  let turnLimitHit = false;
  /** A recovery was requested (or the slot was already spent): never ask again. */
  let spent = o.alreadyRecovered;

  /** The most repeated trusted issue at or over the threshold, if any. */
  const repeated = (): TrustedIssueCode | undefined =>
    TRUSTED_ISSUE_CODES.filter((c) => (issues[c] ?? 0) >= REPEAT_THRESHOLD).sort(
      (a, b) => (issues[b] ?? 0) - (issues[a] ?? 0),
    )[0];
  const wantsRecovery = () => !stopped && (!!repeated() || turns >= o.maxTurns || turnLimitHit);

  return {
    observe(e: RunControlEvent): RunControlDecision {
      switch (e.kind) {
        case "model_turn":
          turns = Math.max(turns, e.turn);
          return { kind: "continue" };
        case "trusted_tool_issue":
          // Only the closed code set counts: an unknown code is ignored (never an invented remediation).
          if (TRUSTED_ISSUE_CODES.includes(e.code)) issues[e.code] = (issues[e.code] ?? 0) + 1;
          return { kind: "continue" };
        case "guard_denied":
          guardDenied = true; // observation only: the guard's decision stays final
          return { kind: "continue" };
        case "owner_steer_state":
          steer = e.state;
          return { kind: "continue" };
        case "owner_stop":
          stopped = true;
          return { kind: "continue" };
        case "run_result": {
          if (e.outcome === "max_turns") turnLimitHit = true;
          if (e.outcome === "success") return { kind: "continue" };
          if (stopped) return { kind: "report_incomplete", reason: "owner_stop" };
          if (NEVER_RECOVERED.has(e.outcome))
            return { kind: "report_incomplete", reason: e.outcome };
          if (wantsRecovery() && spent)
            return { kind: "report_incomplete", reason: "recovery_exhausted" };
          const code = repeated();
          if (wantsRecovery() && !spent) {
            spent = true;
            return e.outcome === "max_turns" || !code
              ? { kind: "recover_after_result", reason: "turn_limit" }
              : { kind: "recover_after_result", reason: "repeated_issue", issueCode: code };
          }
          return { kind: "report_incomplete", reason: e.outcome };
        }
      }
    },
    snapshot(): RunControlSnapshot {
      return {
        turns,
        issues: { ...issues },
        ...(steer && { steer }),
        stopped,
        guardDenied,
        recommendation: wantsRecovery() && !spent ? "recover_after_result" : "none",
      };
    },
  };
}

/** A recovery needs at least this much of the task ceiling left (USD): less would stop at once. */
export const MIN_RECOVERY_BUDGET_USD = 0.1;

/** Outcomes after which nothing is recovered: the work is done, or the owner / the service ended it. */
const FINAL_OUTCOMES: ReadonlySet<string> = new Set(["success", "aborted", "quota", "max_budget"]);

/** What the orchestration does after a result: nothing, or resume the saved session with a trusted internal hint. */
export type RecoverySelection = { kind: "none" } | { kind: "resume"; hint: string };

/**
 * Pure selector at the post-result boundary. A recovery needs a repeated TRUSTED issue or the turn ceiling, a saved
 * session, task budget left, no uncertain partial write, no open approval, no earlier retry and no owner stop. The
 * hint is a fixed text built from the code only (never tool output).
 */
export function recoverOnce(i: {
  result: { outcome: string; sessionId?: string };
  snapshot: RunControlSnapshot;
  alreadyReran: boolean;
  remainingBudgetUsd: number;
  uncertainPartialWrite: boolean;
  approvalWaiting: boolean;
}): RecoverySelection {
  const { result, snapshot } = i;
  if (i.alreadyReran || i.approvalWaiting || i.uncertainPartialWrite || snapshot.stopped)
    return { kind: "none" };
  if (FINAL_OUTCOMES.has(result.outcome) || !result.sessionId) return { kind: "none" };
  if (i.remainingBudgetUsd < MIN_RECOVERY_BUDGET_USD) return { kind: "none" };
  const code = TRUSTED_ISSUE_CODES.find((c) => (snapshot.issues[c] ?? 0) >= REPEAT_THRESHOLD);
  if (code)
    return {
      kind: "resume",
      hint: `Internal note (not from the owner): a tool reported "${code}" more than once in the previous attempt. ${formatTrustedToolIssue(code)} Continue the owner's request without repeating that call.`,
    };
  if (result.outcome === "max_turns")
    return {
      kind: "resume",
      hint: "Internal note (not from the owner): the previous attempt reached its turn limit. Continue from where it stopped and finish the owner's request concisely.",
    };
  return { kind: "none" };
}
