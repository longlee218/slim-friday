import type { ModelTier } from "../config/model-routing";

/* Haiku triage escalation: the Q&A agent ends a hard answer with `ESCALATE: sonnet|opus` (one line, last). */

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
