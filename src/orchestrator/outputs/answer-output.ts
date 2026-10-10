import type { AgentConfig } from "../../config/agent-config";
import { type ModelTier, type Route, resolveModel } from "../../config/model-routing";
import { logEvent, logger } from "../../observability/logger";
import type { RoleDefinition, StageDefinition } from "../../roles/role-types";
import type { RunAgentResult } from "../../runtime/run-agent";
import type { Proposal } from "../../tools/DelegateTaskTool/delegate-task-tool";

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

/**
 * Haiku triage: when the answer ends with `ESCALATE: sonnet`, run the same message ONCE more on Sonnet (same
 * session, escalated budget) and say so in one line; `ESCALATE: opus` needs the owner's OK, so it is only
 * reported (the owner-confirmation flow is P1.4). Anything else is kept as is (fail closed). A run that
 * recorded a handoff proposal is never escalated. `canRerun` false (same model would run again): no re-run,
 * one owner line says why. The "Escalated" prefix is only for a re-run that ran and succeeded.
 */
export async function withEscalation(
  first: RunAgentResult,
  proposal: Proposal | undefined,
  rerun: (sessionId: string | undefined) => Promise<RunAgentResult>,
  canRerun = true,
): Promise<RunAgentResult> {
  if (first.outcome !== "success" || proposal) return first;
  const { text, tier } = parseEscalation(first.text);
  const action = escalationAction(tier, false);
  logEvent(log, "escalation", { tier: tier ?? null, action });
  if (action === "none") return first;
  if (action === "ask-owner") {
    return {
      ...first,
      text: `${text}\n\nA stronger model (${tier}) could answer better; it needs your OK, so I did not run it.`,
    };
  }
  if (!canRerun) {
    return {
      ...first,
      text: `${text}\n\nA stronger model is not available here (model is fixed by config).`,
    };
  }
  const second = await rerun(first.sessionId);
  // One escalation per message: a second ESCALATE line is dropped, never followed.
  const secondText = parseEscalation(second.text).text;
  if (second.outcome !== "success") return { ...second, text: secondText };
  return { ...second, text: `Escalated to Sonnet.\n\n${secondText}` };
}

/**
 * The `answer` output of a stage run. Without the role's `escalation` flag the run is plain. With it, the
 * escalation rule is offered only when the re-run would use a DIFFERENT model than the first run (OpenRouter
 * ignores tiers and a MODEL pin beats them): then `withEscalation` handles the answer.
 * `run(route, sessionId)` runs the stage once; `resume` is the session of the first run.
 */
export async function answerOutput(a: {
  role: RoleDefinition;
  stage: StageDefinition;
  config: AgentConfig;
  run: (route: Route | undefined, sessionId?: string) => Promise<RunAgentResult>;
  resume?: string;
  proposal: () => Proposal | undefined;
}): Promise<RunAgentResult> {
  const { role, stage, config } = a;
  if (!role.escalation) return a.run(undefined, a.resume);
  const canEscalate =
    resolveModel(stage, role, { offerEscalation: true }, config) !==
    resolveModel(stage, role, { tier: "sonnet", escalated: true }, config);
  const first = await a.run({ offerEscalation: canEscalate }, a.resume);
  return withEscalation(
    first,
    a.proposal(),
    (sessionId) => a.run({ tier: "sonnet", escalated: true }, sessionId),
    canEscalate,
  );
}
