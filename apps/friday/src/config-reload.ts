import type { FileConfig } from "@friday/config";
import type { BotHub, Log } from "@friday/core";
import type { EngineStore } from "@friday/store-sqlite";

/** Why a failure happened, as text. */
const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What a config reload acts on. */
export interface ConfigReloadDeps {
  config: FileConfig;
  hub: BotHub;
  engine: EngineStore;
  /** Gives new bots and groups their conversations (queued, one at a time). */
  sync: () => Promise<void>;
  /** Called once the reload has synced (the web surface publishes `config.changed`). */
  onConfigChanged?: () => void;
  log: Log;
}

/**
 * Watch the config dir. On a change: restart changed bots (every session) and the sessions of groups whose
 * workspaces changed, each with a fresh session id; then sync the conversations and report the change.
 * Returns the stop function.
 */
export function watchConfigReload(d: ConfigReloadDeps): () => void {
  return d.config.watch((r) => {
    for (const p of r.problems) d.log.warn(p, "config.problem");
    void (async () => {
      for (const id of r.changedBots) {
        await d.hub.stop(id);
        await d.engine.sessions.clearBot(id);
      }
      for (const id of r.changedGroups) {
        await d.hub.stopGroup(id);
        await d.engine.sessions.clearGroup(id);
      }
      await d.sync();
      d.onConfigChanged?.();
    })().catch((err) => d.log.error({ error: why(err) }, "config.reload"));
  });
}
