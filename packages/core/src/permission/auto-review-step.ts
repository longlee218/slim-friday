import type { PermissionSettings } from "../domain/autonomy";
import type { ToolCall } from "../domain/tool";
import {
  AUTO_REVIEW_TIMEOUT_MS,
  type AutoReviewer,
  type AutoReviewInput,
  type AutoReviewVerdict,
} from "../ports/auto-review";
import type { Clock } from "../ports/clock";
import type { AuditEntry, Store } from "../ports/store";
import { CONTINUATION_KEY } from "../runs/continuation-key";
import { redactSecrets, redactValue } from "../safety/redact-secrets";
import type { Decision } from "./decide";

/** Most characters of a reason kept on a card and in the audit row. */
const MAX_REASON_CHARS = 300;

/**
 * The words the judge measures a call against (spec §6.14): the text of the owner message that started the chain;
 * for a chain started by a ticket, the ticket's title and description; for any other chain, its first message.
 * Only the owner's own message counts as the owner's words: a continuation run (sender owner, but Friday's fixed
 * `CONTINUATION_PROMPT`) does not. Undefined when the chain's first wake is gone.
 */
export async function ownerWordsOf(
  store: Pick<Store, "wakes" | "tickets">,
  chainId: string,
): Promise<Pick<AutoReviewInput, "ownerWords" | "ownerWordsAreOwner"> | undefined> {
  const first = await store.wakes.get(chainId);
  if (!first) return undefined;
  if (first.ticketId) {
    const t = await store.tickets.get(first.ticketId);
    if (t)
      return {
        ownerWords: [t.title, t.description ?? ""].filter((s) => s.trim()).join("\n\n"),
        ownerWordsAreOwner: false,
      };
  }
  return {
    ownerWords: first.text,
    ownerWordsAreOwner:
      first.sender.kind === "user" &&
      first.ticketId === undefined &&
      !first.dedupeKey?.startsWith(CONTINUATION_KEY),
  };
}

/** One line, at most `MAX_REASON_CHARS`, secrets hidden; a blank reason gets a fixed text. */
function cleanReason(reason: string, secrets: readonly string[]): string {
  const one = reason.replace(/\s+/g, " ").trim().slice(0, MAX_REASON_CHARS);
  return redactSecrets(one || "Auto Review gave no reason.", secrets);
}

/**
 * Ask the reviewer with a time limit; it never throws and only an exact `pass` passes: an error, the timeout or an
 * answer of any other shape is an `ask` (spec §6.14: errors fail closed to the card, the judge never denies).
 */
export async function reviewCall(
  reviewer: AutoReviewer,
  input: AutoReviewInput,
  secrets: readonly string[],
  clock: Clock,
  timeoutMs = AUTO_REVIEW_TIMEOUT_MS,
): Promise<AutoReviewVerdict> {
  let cancel: (() => void) | undefined;
  const timeout = new Promise<AutoReviewVerdict>((settle) => {
    cancel = clock.setTimer(timeoutMs, () =>
      settle({ decision: "ask", reason: "Auto Review timed out." }),
    );
  });
  try {
    const v = await Promise.race([reviewer.review(input), timeout]);
    const decision = v?.decision === "pass" ? "pass" : "ask";
    return {
      decision,
      reason: cleanReason(typeof v?.reason === "string" ? v.reason : "", secrets),
    };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return { decision: "ask", reason: cleanReason(`Auto Review failed: ${text}`, secrets) };
  } finally {
    cancel?.();
  }
}

/**
 * The Auto Review verdict of an asked call; undefined when it is not reviewed (spec §6.14): only a `reviewable`
 * plain level ask, only while `settings.autoReview` is on, only in a clean call (`tainted`: the run read untrusted
 * input or the call comes from a subagent, `callTainted`; such a call always gets the card), only with a reviewer and
 * a chain whose first wake exists. The judge gets the input with the configured secret values already hidden (the adapter also hides secret keys).
 */
export async function reviewIfAsked(
  deps: {
    store: Pick<Store, "wakes" | "tickets">;
    clock: Clock;
    autoReviewer?: AutoReviewer;
    autoReviewTimeoutMs?: number;
  },
  call: ToolCall,
  verdict: Decision,
  settings: PermissionSettings,
  chainId: string | undefined,
  tainted: boolean,
  secrets: readonly string[],
): Promise<AuditEntry["review"]> {
  const reviewer = deps.autoReviewer;
  if (tainted || !verdict.reviewable || verdict.outcome !== "ask" || settings.autoReview !== true)
    return;
  if (!reviewer || !chainId) return;
  const words = await ownerWordsOf(deps.store, chainId);
  if (!words) return;
  const input = { ...words, tool: call.tool, input: redactValue(call.input, secrets) };
  return reviewCall(reviewer, input, secrets, deps.clock, deps.autoReviewTimeoutMs);
}
