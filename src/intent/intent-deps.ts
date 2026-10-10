import type { AgentConfig } from "../config/agent-config";
import { ROLES } from "../roles/role-registry";
import { createAliasRouter } from "./alias-router";
import { createIntentClassifier } from "./create-intent-classifier";
import type { IntentDeps } from "./decide-intent";
import type { IntentQueryFn } from "./haiku-intent-classifier";
import { loadLexicon } from "./load-lexicon";

/**
 * Everything the intent layer runs on, built ONCE at startup. Throws (startup refusal) on an invalid lexicon
 * override, a duplicate role alias / tag, or `INTENT_ENGINE=jev`.
 */
export function buildIntentDeps(config: AgentConfig, queryFn?: IntentQueryFn): IntentDeps {
  return {
    pipeline: {
      lexicon: loadLexicon(config.agentHome),
      aliasRouter: createAliasRouter(Object.values(ROLES)),
    },
    classifier: createIntentClassifier(config, queryFn),
  };
}
