import type { AgentConfig } from "../../config/agent-config";
import { type ModelTier, type Route, resolveModel } from "../../config/model-routing";
import { logEvent, logger } from "../../observability/logger";
import type { RoleDefinition, StageDefinition } from "../../roles/role-types";
import type { RunAgentResult } from "../../runtime/run-agent";

/* Output `answer`: the reply is the agent's text. With the role's `escalation` flag a cheap-tier answer may end in
   `ESCALATE: sonnet|opus` (one line, last) and is then re-run on that tier. */

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "answer-output" });

/** Tiers an assistant may ask for. */
export type EscalationTier = Extract<ModelTier, "sonnet" | "opus">;

/** The line alone, last non-empty line of the reply; anything else is NOT an escalation (fail closed). */
const ESCALATE_LINE = /^ESCALATE:\s*(sonnet|opus)\s*$/i;

/** Reply text without the escalation line, and the tier it asked for (undefined = none / malformed). */
export function parseEscalation(text: string): { text: string; tier?: EscalationTier } {
  const lines = text.trimEnd().split("\n");
  const last = lines.at(-1)?.trim() ?? "";
  const m = ESCALATE_LINE.exec(last);
  if (!m) return { text };
  return {
    text: lines.slice(0, -1).join("\n").trimEnd(),
    tier: m[1]?.toLowerCase() as EscalationTier,
  };
}

/** What the app does with a parsed escalation. */
export type EscalationAction = "rerun" | "ask-owner" | "none";

/**
 * Max ONE escalation per message: an escalated run never escalates again. sonnet re-runs automatically; opus
 * and `max` need the owner's OK first (Rev 5), so the app asks instead of running.
 */
export function escalationAction(
  tier: EscalationTier | undefined,
  alreadyEscalated: boolean,
): EscalationAction {
  if (!tier || alreadyEscalated) return "none";
  return tier === "sonnet" ? "rerun" : "ask-owner";
}

/** Owner-facing lines of the Opus escalation that did not run. */
const OPUS_DECLINED = "Not run on Opus (not confirmed); this is the cheaper answer.";
const OPUS_UNAVAILABLE = "A stronger model is not available here (model is fixed by config).";

/**
 * Haiku triage: when the answer ends with `ESCALATE: sonnet`, run the same message ONCE more on Sonnet (same
 * session, escalated budget) and say so in one line. `ESCALATE: opus` runs only after the owner-confirm gate
 * (`confirmOpus`, buttons) says yes; no answer, no gate or "no" keeps the cheaper answer plus one line
 * (fail closed). Anything else is kept as is. `canRerun` false (same model would run again): no re-run,
 * one owner line says why. The "Escalated" prefix is only for a re-run that ran and succeeded.
 */
export async function withEscalation(
  first: RunAgentResult,
  rerun: (tier: EscalationTier, sessionId: string | undefined) => Promise<RunAgentResult>,
  canRerun = true,
  confirmOpus?: () => Promise<boolean>,
): Promise<RunAgentResult> {
  if (first.outcome !== "success") return first;
  const { text, tier } = parseEscalation(first.text);
  const action = escalationAction(tier, false);
  logEvent(log, "escalation", { tier: tier ?? null, action });
  if (action === "none" || !tier) return first;
  if (!canRerun) return { ...first, text: `${text}\n\n${OPUS_UNAVAILABLE}` };
  if (action === "ask-owner" && !(await confirmOpus?.())) {
    return { ...first, text: `${text}\n\n${OPUS_DECLINED}` };
  }
  const second = await rerun(tier, first.sessionId);
  // One escalation per message: a second ESCALATE line is dropped, never followed.
  const secondText = parseEscalation(second.text).text;
  if (second.outcome !== "success") return { ...second, text: secondText };
  return {
    ...second,
    text: `Escalated to ${tier === "opus" ? "Opus" : "Sonnet"}.\n\n${secondText}`,
  };
}

/**
 * The `answer` output of a stage run. Without the role's `escalation` flag the run is plain. With it, the
 * escalation rule is offered only when the re-run would use a DIFFERENT model than the first run (OpenRouter
 * ignores tiers and a MODEL pin beats them): then `withEscalation` handles the answer.
 * `run(route, sessionId)` runs the stage once; `resume` is the session of the first run. `confirmOpus` is the
 * owner-confirm gate for an Opus escalation (missing = never runs on Opus).
 */
export async function answerOutput(a: {
  role: RoleDefinition;
  stage: StageDefinition;
  config: AgentConfig;
  run: (route: Route | undefined, sessionId?: string) => Promise<RunAgentResult>;
  resume?: string;
  confirmOpus?: () => Promise<boolean>;
}): Promise<RunAgentResult> {
  const { role, stage, config } = a;
  if (!role.escalation) return a.run(undefined, a.resume);
  const canEscalate =
    resolveModel(stage, role, { offerEscalation: true }, config) !==
    resolveModel(stage, role, { tier: "sonnet", escalated: true }, config);
  const first = await a.run({ offerEscalation: canEscalate }, a.resume);
  return withEscalation(
    first,
    // An Opus re-run only happens after the owner said yes, so it carries the confirmation.
    (tier, sessionId) =>
      a.run(
        { tier, escalated: true, ...(tier === "opus" && { ownerConfirmedMax: true }) },
        sessionId,
      ),
    canEscalate,
    a.confirmOpus,
  );
}
