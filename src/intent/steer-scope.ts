import { logEvent, logger } from "../observability/logger";
import { entryRole } from "../roles/role-registry";
import type { IntentDecision } from "./decide-intent";
import { validateIntent } from "./intent-schema";
import { type IntentClassifier, IntentEngineError, type IntentInput } from "./intent-types";

/* Scope of a message sent while a steerable run works (Rev 11): L3 decides supplement vs independent, a `[tag]`
   only picks the role, and anything unclear is a supplement (never a lost message). */

/** Logger of this module. */
const log = logger.child({ module: "steer-scope" });

/** A message that adds to the running task whose role nothing settled: the entry role carries it (a steer ignores the role). */
export const supplement = (role = entryRole().name): IntentDecision => ({
  kind: "role",
  role,
  scope: "active",
});

/**
 * Scope of a TAGGED message: L3 reads the conversation and says supplement (`active`) or independent (`new`). Its
 * role and class are ignored (the tag chose the role); no engine, a failure, an unknown role or low confidence =
 * ambiguous = supplement. One L3 call at most; logs `intent.classified` (no text) or `intent.fallback`.
 */
export async function modelScope(
  classifier: IntentClassifier | undefined,
  i: { l3Input: () => IntentInput; signal?: AbortSignal },
): Promise<"active" | "new"> {
  if (!classifier) return "active";
  try {
    const raw = await classifier.classify(i.l3Input(), i.signal);
    const v = validateIntent(raw, { hasTask: true });
    if (!v.ok || raw.confidence === "low") return "active";
    logEvent(log, "intent.classified", {
      scope: v.result.scope,
      confidence: raw.confidence,
      tagged: true,
    });
    return v.result.scope;
  } catch (err) {
    logEvent(
      log,
      "intent.fallback",
      { reason: err instanceof IntentEngineError ? err.reason : "sdk" },
      "warn",
    );
    return "active";
  }
}
