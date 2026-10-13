import type { AgentConfig } from "../config/agent-config";
import { createHaikuIntentClassifier, type IntentQueryFn } from "./haiku-intent-classifier";
import type { IntentClassifier } from "./intent-types";

/**
 * L3 engine of `INTENT_ENGINE`: `haiku` (default) and `jev` -> the Haiku classifier (under `jev` it is the fallback
 * the policy calls only when Jev is undecided / failed); `none` -> undefined (rules L0-L2 only, an undecided message
 * goes to the entry role).
 */
export function createIntentClassifier(
  config: AgentConfig,
  queryFn?: IntentQueryFn,
): IntentClassifier | undefined {
  switch (config.intent.engine) {
    case "haiku":
    case "jev":
      return createHaikuIntentClassifier(config, queryFn);
    case "none":
      return undefined;
  }
}
