import type { RunAgentResult } from "../../runtime/run-agent";

/* Objective fallback signals: facts of a finished answer run (outcome, tool errors, a short "I do not know" reply)
   that say the cheap tier could not do it. Pure; the decision to re-run lives in answer-output.ts. */

/** Main-agent tool errors (`usage.toolErrors`, never `toolDenied`) from which a run counts as struggling. */
export const FALLBACK_TOOL_ERRORS = 4;

/** Only a reply shorter than this can count as "unsure": a long answer that mentions a gap is still an answer. */
export const UNSURE_MAX_CHARS = 600;

/** Optional apology before a give-up ("Unfortunately, ..."). */
const SORRY = "(?:(?:unfortunately|sorry|xin lỗi)[,.]?\\s+)?";

/**
 * Clear give-ups (EN + VI): the WHOLE reply is one short sentence saying nothing was found / not enough information.
 * No comma, semicolon or question mark after the phrase, so "I couldn't find X, but ..." and a clarifying question
 * never match. A bare "not sure" / "không chắc" is NOT a give-up (it usually leads into a real answer).
 */
export const UNSURE_PATTERNS: readonly RegExp[] = [
  new RegExp(
    `^${SORRY}(?:i |we )?(?:could not|couldn't|can't|cannot|was unable to|was not able to) (?:find|locate)(?: (?:any|the|a|an|that|it|this|anything)\\b[^.!?\\n,;:]{0,60})?[.!]*$`,
    "i",
  ),
  new RegExp(
    `^${SORRY}(?:i )?(?:do not|don't) have enough (?:information|context)[^.!?\\n,;:]{0,40}[.!]*$`,
    "i",
  ),
  new RegExp(
    `^${SORRY}(?:tôi |mình )?(?:không tìm thấy|chưa tìm thấy|không đủ thông tin)[^.!?\\n,;:]{0,60}[.!]*$`,
    "i",
  ),
];

/** A file:line reference or a code fence: the reply carries real content, never a give-up. */
const HAS_CONTENT = /\S+\.\w{1,6}:\d+|```/;

/** Why a run is re-run on Sonnet; the label goes into the owner line and the `escalation` log. */
export type FallbackReason = "max_turns" | "max_budget" | "tool_errors" | "unsure";

/** Owner-facing wording per reason. */
export const FALLBACK_LABELS: Record<FallbackReason, string> = {
  max_turns: "turn limit reached",
  max_budget: "budget reached",
  tool_errors: "many tool errors",
  unsure: "unsure answer",
};

/** The reply is a short whole-answer give-up: markdown wrapping stripped, one line, no question, no file:line or code. */
export function looksUnsure(text: string): boolean {
  const t = text
    .normalize("NFC")
    .trim()
    .replace(/^[\s>*_\-#]+|[\s*_]+$/g, "");
  if (!t || t.length >= UNSURE_MAX_CHARS || t.includes("\n") || /[?？]\s*$/.test(t)) return false;
  return !HAS_CONTENT.test(t) && UNSURE_PATTERNS.some((p) => p.test(t));
}

/** First fallback reason of a finished run, or undefined. Aborted / errored / quota / timeout runs never fall back. */
export function fallbackReason(r: RunAgentResult): FallbackReason | undefined {
  if (r.outcome === "max_turns" || r.outcome === "max_budget") return r.outcome;
  if (r.outcome !== "success") return undefined;
  if (r.usage.toolErrors >= FALLBACK_TOOL_ERRORS) return "tool_errors";
  return looksUnsure(r.text) ? "unsure" : undefined;
}
