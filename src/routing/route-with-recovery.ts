import type { Logger } from "pino";
import { withSpan } from "../observability/trace-spans";
import { entryRole } from "../roles/role-registry";
import { PREFLIGHT_CHECKS, type PreflightCtx } from "./preflight/deterministic-preflight";
import { runPreflight } from "./preflight/run-preflight";
import {
  MAX_REROUTES_PER_TURN,
  nextStep,
  type RecoveryState,
  type RecoveryStep,
} from "./recovery-controller";
import type { AgentPreflightResult, ReasonCode } from "./routing-contracts";

/** The legacy refusal of a failed check (same shape the dispatcher logs; defined here to keep routing free of orchestrator imports). */
export interface RecoveryRefusal {
  event: "task.refused" | "task.busy";
  reason: string;
  reply: string;
}

/** Where one user turn ended up after preflight and (at most one) reroute. */
export interface RecoveryOutcome {
  /** execute = run `role`; clarify / safe_fail = reply with `reply`, nothing runs. */
  kind: "execute" | "clarify" | "safe_fail";
  /** The role that runs (execute) or the last one tried. */
  role: string;
  /** The first candidate, before any reroute. */
  initial: string;
  rerouted: boolean;
  visited: string[];
  /** Why the first candidate was rejected (the reason of a reroute / owner change). */
  rerouteReason?: ReasonCode;
  /** Decision of the last preflight (for `route.decision`). */
  preflight: AgentPreflightResult["decision"];
  /** Legacy refusal behind the reply; set only for clarify / safe_fail (the caller logs it once). */
  refusal?: RecoveryRefusal;
  /** Owner reply of a clarify / safe_fail. */
  reply?: string;
  reasonCode?: ReasonCode;
}

/** Options of one recovery run. */
export interface RecoveryOpts {
  /** A reroute may replace the candidate (false for an explicit `[tag]`). */
  allowReroute: boolean;
}

/**
 * Preflight the candidate; on a reject let `nextStep` reroute ONCE (bounded loop, visited roles never repeat),
 * preflight the new candidate, then execute / clarify / safe fail. The reroute preflight runs in span `recover`.
 * The reply of a clarify / safe fail is the legacy refusal text; it is returned only when nothing runs.
 */
export async function routeWithRecovery(
  log: Logger,
  ctx: PreflightCtx,
  opts: RecoveryOpts,
): Promise<RecoveryOutcome> {
  const state: RecoveryState = { rerouted: false, visited: [ctx.role] };
  let role = ctx.role;
  let current = await runPreflight(log, ctx);
  const first = current;
  /** Refusal behind the reply: the latest check, but a rerouted candidate that also rejects answers with the first one. */
  const refusalOf = () =>
    state.rerouted && current.result.decision === "reject" ? first.refusal : current.refusal;
  let rerouteReason: ReasonCode | undefined;
  const done = (step: Exclude<RecoveryStep, { kind: "reroute" }>): RecoveryOutcome => ({
    kind: step.kind === "execute" || step.kind === "clarify" ? step.kind : "safe_fail",
    role,
    initial: ctx.role,
    rerouted: state.rerouted,
    visited: state.visited,
    rerouteReason,
    preflight: current.result.decision,
    ...(step.kind !== "execute" && {
      refusal: refusalOf(),
      reply: step.text,
      reasonCode: step.reasonCode,
    }),
  });
  // The bound is a hard stop: a step that kept asking to reroute still ends in a safe fail.
  for (let i = 0; i <= MAX_REROUTES_PER_TURN; i++) {
    const reroutable = !!PREFLIGHT_CHECKS.find((c) => c.id === current.result.evidence[0])
      ?.reroutable;
    const step = nextStep(current.result, state, {
      entryRole: entryRole().name,
      reroutable,
      allowReroute: opts.allowReroute,
      reply: refusalOf()?.reply ?? "",
    });
    if (step.kind !== "reroute") return done(step);
    rerouteReason = current.result.reasonCode;
    role = step.role;
    state.rerouted = true;
    state.visited.push(role);
    current = await withSpan(log, "recover", () => runPreflight(log, { ...ctx, role }));
  }
  return done({
    kind: "safe_fail",
    text: first.refusal?.reply ?? "",
    reasonCode: "ROUTE_CONFLICT",
  });
}
