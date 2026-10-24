import type { FileConfig } from "@friday/config";
import type { Bot, Store } from "@friday/core";
import type { EngineStore } from "@friday/store-sqlite";
import { withFridayDirs } from "./friday-bot";

/**
 * The core `Store`: the engine db plus bots and groups from the config files. The Friday bot also gets its real dirs;
 * the roster and shared-dir text depend on the session (direct or group), so the hub adds them through `scopeBot`.
 */
export function composeStore(
  engine: EngineStore,
  config: FileConfig,
  dirs: { configDir: string; templatesDir: string },
): Store {
  const withDirs = (b: Bot): Bot => withFridayDirs(b, dirs);
  return {
    ...engine,
    bots: {
      get: async (id) => {
        const b = await config.bots.get(id);
        return b && withDirs(b);
      },
      list: async () => (await config.bots.list()).map(withDirs),
    },
    groups: config.groups,
  };
}
