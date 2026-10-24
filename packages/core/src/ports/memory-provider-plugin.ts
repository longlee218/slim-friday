import type { Log } from "./log";
import type { RecallSource } from "./memory-recall";

/** Env values a plugin asked for (`secretEnv`), by name; a missing one is undefined. */
export type PluginSecrets = Record<string, string | undefined>;

/**
 * A memory provider plugin (Honcho, later others): everything the app needs to turn one `memory.providers` entry of
 * `settings.yaml` into a `RecallSource`. Each plugin lives in its own package and imports only core.
 */
export interface MemoryProviderPlugin<O = unknown> {
  /** Matches `memory.providers[].id` in settings.yaml. */
  id: string;
  /** Env names it reads (secrets); each must be on the child-env deny list, so no bot sees them. */
  secretEnv: readonly string[];
  /** Its own options from the settings entry (every key but `id`); throws a readable error. */
  parseOptions(raw: Record<string, unknown>): O;
  /** Problems that make the options unusable (bad URL, missing key); [] = usable. */
  check(options: O, secrets: PluginSecrets): string[];
  /** The source; called only when `check` found no problem. */
  create(
    options: O,
    secrets: PluginSecrets,
    deps: { log: Pick<Log, "warn">; fetch?: typeof fetch },
  ): RecallSource;
}
