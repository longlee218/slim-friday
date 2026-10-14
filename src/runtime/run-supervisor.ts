/* Run supervisor (pure): turns structured run events into a PLAN for the orchestration layer. It never calls the SDK,
   never sees owner text or raw tool output, and has no way to allow what the guard denied. Recovery is requested at most
   once, and only after a result (the in-flight query is never touched). */

/** Issue codes Friday-owned tools report (a closed set: free-form text is never an issue). */
export const TRUSTED_ISSUE_CODES = [
  "invalid_input",
  "not_found",
  "temporarily_busy",
  "limit",
  "unavailable",
] as const;
export type TrustedIssueCode = (typeof TRUSTED_ISSUE_CODES)[number];

/** Same trusted issue this many times in one run counts as repeated (a single failure is not a trigger). */
const REPEAT_THRESHOLD = 2;

/** Outcomes that are never recovered: the owner or the service ended the run. */
const NEVER_RECOVERED: ReadonlySet<string> = new Set(["aborted", "quota"]);

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
  /** A recovery was requested (or the slot was already spent): never ask again. */
  let spent = o.alreadyRecovered;

  /** The most repeated trusted issue at or over the threshold, if any. */
  const repeated = (): TrustedIssueCode | undefined =>
    TRUSTED_ISSUE_CODES.filter((c) => (issues[c] ?? 0) >= REPEAT_THRESHOLD).sort(
      (a, b) => (issues[b] ?? 0) - (issues[a] ?? 0),
    )[0];
  const wantsRecovery = () => !stopped && (!!repeated() || turns >= o.maxTurns);

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
