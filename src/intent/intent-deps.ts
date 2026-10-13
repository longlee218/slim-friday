import type { AgentConfig } from "../config/agent-config";
import { logEvent, logger } from "../observability/logger";
import { validateRegistry } from "../roles/capability-registry";
import { ROLES } from "../roles/role-registry";
import { createIntentClassifier } from "./create-intent-classifier";
import type { IntentDeps } from "./decide-intent";
import type { IntentQueryFn } from "./haiku-intent-classifier";
import { createJevClient, type JevClient } from "./jev/jev-client";
import { createJevProposer } from "./jev/jev-proposer";
import { loadLexicon } from "./load-lexicon";
import { createRoleTagRouter } from "./role-tag";

/** Logger of this module. */
const log = logger.child({ module: "intent-deps" });

/**
 * Everything the intent layer runs on, built ONCE at startup. Throws (startup refusal) on an invalid lexicon
 * override, a duplicate / malformed role tag, or an invalid capability registry.
 * Engine `jev` builds the Jev proposer from `jevClient` (tests) or the real client when `JEV_API_KEY` is real; with no
 * key it logs `intent.layer {layer: "jev", skipped: "no_key"}` once and runs Haiku only (the bot still starts).
 */
export function buildIntentDeps(
  config: AgentConfig,
  queryFn?: IntentQueryFn,
  jevClient?: JevClient,
): IntentDeps {
  validateRegistry();
  const { engine, jevApiKey } = config.intent;
  const client =
    jevClient ?? (engine === "jev" && jevApiKey ? createJevClient(jevApiKey) : undefined);
  if (engine === "jev" && !client)
    logEvent(log, "intent.layer", { layer: "jev", skipped: "no_key" }, "warn");
  return {
    engine,
    ...(engine === "jev" && client && { proposer: createJevProposer(client) }),
    pipeline: {
      lexicon: loadLexicon(config.agentHome),
      tagRouter: createRoleTagRouter(Object.values(ROLES)),
    },
    classifier: createIntentClassifier(config, queryFn),
  };
}
