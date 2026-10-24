import type { MemoryProviderEntry } from "@friday/config";
import type { Log, MemoryProviderPlugin, RecallSource } from "@friday/core";
import { honchoPlugin } from "@friday/memory-honcho";

/** The memory provider plugins this app ships: adding one = its package + one line here. */
export const MEMORY_PLUGINS: MemoryProviderPlugin[] = [honchoPlugin as MemoryProviderPlugin];

/**
 * The recall sources of the `memory.providers` entries of settings.yaml, through their plugins. An unknown id, bad
 * options or a failed check is a problem and that entry is skipped (the app runs without it). `env` holds the
 * owner's env; each plugin gets only the names it declares.
 */
export function providerSources(
  entries: MemoryProviderEntry[],
  env: Record<string, string | undefined>,
  deps: { log: Pick<Log, "warn">; fetch?: typeof fetch },
  plugins: MemoryProviderPlugin[] = MEMORY_PLUGINS,
): { sources: RecallSource[]; problems: string[] } {
  const sources: RecallSource[] = [];
  const problems: string[] = [];
  for (const { id, ...raw } of entries) {
    const plugin = plugins.find((p) => p.id === id);
    if (!plugin) {
      problems.push(`memory provider "${id}" has no plugin`);
      continue;
    }
    const secrets = Object.fromEntries(plugin.secretEnv.map((n) => [n, env[n]]));
    try {
      const options = plugin.parseOptions(raw);
      const bad = plugin.check(options, secrets);
      if (bad.length) problems.push(...bad);
      else sources.push(plugin.create(options, secrets, deps));
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { sources, problems };
}
