import { isChildEnvDenied } from "@friday/runtime-claude";
import { readProcessEnv } from "./config/process-env";

/**
 * The values of every env variable the bots are denied (tokens, keys, ports, paths of the app), read at each
 * call so a changed env applies at once. Core hides them from everything a bot posts, shows or writes (it skips
 * values shorter than 8 chars).
 */
export function deniedEnvValues(
  env: Record<string, string | undefined> = readProcessEnv(),
): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    value && isChildEnvDenied(name) ? [value] : [],
  );
}
