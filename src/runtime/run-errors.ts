/* Classification of SDK failures: quota / rate limit vs. everything else. */

/** Error text of a failed `resume` (session transcript missing); only then is the stored session dropped. */
export const RESUME_FAILED =
  /no conversation found|could not resume|session .*(not found|does not exist)/i;

/** `error` values of an assistant message (SDKAssistantMessageError) that mean quota/billing/overload. */
const QUOTA_ASSISTANT_ERRORS = new Set([
  "billing_error",
  "rate_limit",
  "overloaded",
  "account_on_hold",
]);

/** Text fallback: only provider phrases (bare words like "billing" or "429" appear in location names and line numbers). */
const QUOTA_TEXT =
  /rate_limit_error|overloaded_error|api error:?\s*(429|529)|credit balance is too low|usage limit reached|rate limit (reached|exceeded)|too many requests/i;

/** What the run saw that can mark it as a quota failure. */
export interface QuotaSignals {
  /** Result subtype (e.g. "error_during_execution"). */
  subtype?: string;
  /** Joined result errors, or the error text of a thrown query. */
  errors: string;
  /** `error` of the last assistant message, when any. */
  assistantError?: string;
  /** A `rate_limit_event` reported status "rejected". */
  rejected: boolean;
}

/** True when the failure is a quota / rate limit / billing / overloaded condition (no retry helps now). */
export function isQuotaFailure(s: QuotaSignals): boolean {
  return (
    s.rejected ||
    QUOTA_ASSISTANT_ERRORS.has(s.assistantError ?? "") ||
    QUOTA_TEXT.test(`${s.subtype ?? ""} ${s.errors}`)
  );
}

/** Reset time (epoch ms) from a `rate_limit_info`; the SDK sends epoch seconds, tolerate ms. */
export function resetFromInfo(info: unknown): number | undefined {
  const i = info as { resetsAt?: unknown; overageResetsAt?: unknown } | undefined;
  const t = [i?.resetsAt, i?.overageResetsAt].find((v) => typeof v === "number" && v > 0);
  return typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : undefined;
}
