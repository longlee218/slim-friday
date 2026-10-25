import type { AutoReviewer } from "@friday/core";
import { createAutoReviewer } from "@friday/runtime-claude";
import type { AgentConfig } from "./config/agent-config";
import { HAIKU_SUMMARY_MODEL } from "./config/model-ids";
import { readProcessEnv } from "./config/process-env";
import { deniedEnvValues } from "./secret-values";

/**
 * The Auto Review judge of a process that runs runs (spec §6.14): Haiku, one tool-less call, the OAuth token only in
 * the SDK child env, the denied env's secret values hidden from its prompt. The gate asks it only while
 * `permissions.autoReview` is on (read live from the settings), so a toggle needs no restart.
 */
export function appAutoReviewer(config: Pick<AgentConfig, "oauthToken">): AutoReviewer {
  const env = readProcessEnv();
  return createAutoReviewer({
    model: HAIKU_SUMMARY_MODEL,
    env,
    oauthToken: config.oauthToken,
    secretValues: () => deniedEnvValues({ ...readProcessEnv(), ...env }),
  });
}
