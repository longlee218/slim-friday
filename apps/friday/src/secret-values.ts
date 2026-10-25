import { isChildEnvDenied } from "@friday/runtime-claude";
import { readProcessEnv } from "./config/process-env";

/** Names that hold a secret; the other denied variables (paths, ports, urls, model ids) are plain config. */
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD/i;

/**
 * The values of the env variables the bots are denied AND whose name looks secret, read at each call so a
 * changed env applies at once. Core hides them from everything a bot posts, shows or writes (it skips values
 * shorter than 8 chars). Denied non-secrets (AGENT_HOME, WEB_ORIGIN, MODEL...) stay visible.
 */
export function deniedEnvValues(
  env: Record<string, string | undefined> = readProcessEnv(),
): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    value && isChildEnvDenied(name) && SECRET_NAME.test(name) ? [value] : [],
  );
}
