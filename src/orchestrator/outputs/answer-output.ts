import type { AgentConfig } from "../../config/agent-config";
import {
  type ModelTier,
  type Route,
  resolveModel,
  TASK_BUDGET_USD,
} from "../../config/model-routing";
import { logEvent, logger } from "../../observability/logger";
import type { RoleDefinition } from "../../roles/role-types";
import type { RunAgentResult } from "../../runtime/run-agent";
import { FALLBACK_LABELS, type FallbackReason, fallbackReason } from "./escalation-signals";

/* Answer escalation: the reply is the agent's text. With the role's `escalation` flag a cheap-tier answer may end in
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
/** Appended to the prompt of an unsure / error-ridden fallback re-run (the session is resumed, so thread history stays). Not shown to the owner. */
export const FALLBACK_RETRY_HINT =
  "(The previous attempt in this session could not answer this. Investigate again from scratch with your own tools; do not repeat that conclusion.)";

/** A re-run needs at least this much of the task ceiling left (USD); less would stop at once. */
const MIN_RERUN_BUDGET_USD = 0.1;
const CEILING_NOTE = "Not re-run: the task budget ceiling is used up; this is the first answer.";

/** Every tier an answer may be escalated to, cheapest first. */
const ESCALATION_TIERS: readonly EscalationTier[] = ["sonnet", "opus"];

/**
 * Haiku triage: when the answer ends with `ESCALATE: <tier>`, run the same message ONCE more on that tier (escalated
 * budget; resumed after a limit hit, a fresh session after an unsure answer or many tool errors) and say so in one line. `ESCALATE: opus` runs only after the owner-confirm gate
 * (`confirmOpus`, buttons) says yes; no answer, no gate or "no" keeps the cheaper answer plus one line
 * (fail closed). Anything else is kept as is. `reachable(tier)` false (that tier would run the same model again):
 * no re-run, one owner line says why. The "Escalated" prefix is only for a re-run that ran and succeeded.
 */
export async function withEscalation(
  first: RunAgentResult,
  rerun: (tier: EscalationTier, sessionId: string | undefined) => Promise<RunAgentResult>,
  reachable: (tier: EscalationTier) => boolean = () => true,
  confirmOpus?: () => Promise<boolean>,
): Promise<RunAgentResult> {
  if (first.outcome !== "success") return first;
  const { text, tier } = parseEscalation(first.text);
  const action = escalationAction(tier, false);
  if (action === "none" || !tier) return first;
  // `escalatedTo` = the tier the answer is re-run on (the event is only logged when the model asked for one).
  logEvent(log, "escalation", { escalatedTo: tier, action, trigger: "model" });
  if (!reachable(tier)) return { ...first, text: `${text}\n\n${OPUS_UNAVAILABLE}` };
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
 * Objective fallback (code, not the model's self-assessment): a run on a tier below Sonnet that hit its turn or
 * budget limit, had many tool errors or gave a short "not found / not sure" reply is re-run ONCE on Sonnet (same
 * session, escalated budget). Never Opus. A failed re-run keeps a successful first answer; a failed first run
 * (limit hit) is replaced by the re-run's outcome.
 */
async function fallbackRerun(
  first: RunAgentResult,
  reason: FallbackReason,
  rerun: (sessionId: string | undefined, hint: string | undefined) => Promise<RunAgentResult>,
): Promise<RunAgentResult> {
  logEvent(log, "escalation", { escalatedTo: "sonnet", reason, trigger: "fallback" });
  // Always resume (thread history stays). A limit hit left real work: same prompt. An unsure / error-ridden attempt
  // gets a hint line so Sonnet re-investigates instead of repeating that conclusion.
  const limitHit = reason === "max_turns" || reason === "max_budget";
  const second = await rerun(first.sessionId, limitHit ? undefined : FALLBACK_RETRY_HINT);
  const secondText = parseEscalation(second.text).text;
  // A failed or empty re-run keeps a successful first answer.
  if (second.outcome !== "success" || !secondText.trim())
    return first.outcome === "success" ? first : second;
  return { ...second, text: `Re-run on Sonnet (${FALLBACK_LABELS[reason]}).\n\n${secondText}` };
}

/**
 * An answer run with its escalation. Without the role's `escalation` flag the run is plain. With it, the model may
 * ask for the tiers that would run a DIFFERENT model than the first run (OpenRouter ignores tiers and a MODEL pin
 * beats them; a Sonnet base still reaches Opus), and the objective fallback may re-run a Haiku-class answer on
 * Sonnet. At most ONE re-run per message (ESCALATE and fallback never combine); a re-run is limited to what the
 * task ceiling still leaves. `route` = the run's route (owner tier/class/effort); an owner-forced tier turns the
 * automatic fallback off. `run(route, sessionId)` runs the role once; `resume` is the session of the first run.
 * `confirmOpus` is the owner-confirm gate for an Opus escalation (missing = never runs on Opus).
 */
export async function answerOutput(a: {
  role: RoleDefinition;
  config: AgentConfig;
  run: (route: Route | undefined, sessionId?: string) => Promise<RunAgentResult>;
  resume?: string;
  /** Route of the first run (class, effort, owner tier, spent so far). */
  route?: Route;
  confirmOpus?: () => Promise<boolean>;
  /** True when the first run ended waiting for an owner answer: no automatic fallback then. */
  awaitingOwner?: () => boolean;
}): Promise<RunAgentResult> {
  const { role, config } = a;
  if (!role.escalation) return a.run(undefined, a.resume);
  const base = resolveModel(role, { ...a.route }, config);
  // A tier is reachable when the escalated re-run would use another model (Opus counts as owner-confirmed here).
  const reachable = (tier: EscalationTier): boolean =>
    resolveModel(
      role,
      { ...a.route, tier, escalated: true, ownerConfirmedMax: tier === "opus" },
      config,
    ) !== base;
  const tiers = ESCALATION_TIERS.filter(reachable);
  const first = await a.run({ offerEscalation: tiers }, a.resume);
  // The re-run is limited by what the task ceiling leaves after the first run.
  const spentUsd = (a.route?.spentUsd ?? 0) + first.usage.costUsd;
  const ceilingUsed = TASK_BUDGET_USD - spentUsd < MIN_RERUN_BUDGET_USD;
  const rerunOn = (tier: EscalationTier, sessionId: string | undefined, hint?: string) =>
    a.run(
      {
        tier,
        escalated: true,
        spentUsd,
        ...(hint && { promptHint: hint }),
        ...(tier === "opus" && { ownerConfirmedMax: true }),
      },
      sessionId,
    );
  const asked = first.outcome === "success" ? parseEscalation(first.text) : undefined;
  if (asked?.tier) {
    if (ceilingUsed) return { ...first, text: `${asked.text}\n\n${CEILING_NOTE}` };
    // An Opus re-run only happens after the owner said yes, so it carries the confirmation.
    return withEscalation(first, rerunOn, reachable, a.confirmOpus);
  }
  const reason = a.awaitingOwner?.() ? undefined : fallbackReason(first);
  // Fallback: only from a tier below Sonnet, never when the owner forced a tier, never to Opus.
  if (!reason || a.route?.tier || base === config.models.opus || !reachable("sonnet")) return first;
  if (ceilingUsed) return { ...first, text: `${first.text}\n\n${CEILING_NOTE}` };
  return fallbackRerun(first, reason, (sid, hint) => rerunOn("sonnet", sid, hint));
}
