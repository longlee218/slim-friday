import type { AgentConfig } from "../config/agent-config";
import { createHaikuIntentClassifier, type IntentQueryFn } from "./haiku-intent-classifier";
import type { IntentClassifier } from "./intent-types";

/**
 * L3 engine of `INTENT_ENGINE`: `haiku` (default) -> the Haiku classifier; `none` -> undefined (rules L0-L2 only,
 * an undecided message is asked / goes to the entry role); `jev` -> throws (the owner's later engine is not built
 * and there is no stub, so startup refuses it instead of silently running without L3).
 */
export function createIntentClassifier(
  config: AgentConfig,
  queryFn?: IntentQueryFn,
): IntentClassifier | undefined {
  switch (config.intent.engine) {
    case "haiku":
      return createHaikuIntentClassifier(config, queryFn);
    case "none":
      return undefined;
    case "jev":
      throw new Error("INTENT_ENGINE=jev is not available yet: use haiku or none");
  }
}
