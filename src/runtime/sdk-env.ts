import { sdkEnv as packageSdkEnv } from "@friday/runtime-claude/floor/sdk-env";
import type { AgentConfig } from "../config/agent-config";
import { readProcessEnv } from "../config/process-env";

export * from "@friday/runtime-claude/floor/sdk-env";

/** Moved to runtime-claude; this wrapper keeps the old default (`process.env` via config) for `src/` callers until plan 5. */
export function sdkEnv(
  config: AgentConfig,
  source: Record<string, string | undefined> = readProcessEnv(),
  opts: Parameters<typeof packageSdkEnv>[2] = {},
): Record<string, string | undefined> {
  return packageSdkEnv(config, source, opts);
}
