import { mkdirSync, watch } from "node:fs";
import type { CoreLimits, PermissionSettings, Store, ToolCatalog } from "@friday/core";
import { diffBots } from "./diff-bots";
import { type ConfigProblem, type ConfigSnapshot, loadConfig } from "./load-config";

/** What a reload found. */
export interface ReloadResult {
  /** Bots that were removed or edited: give them a fresh session on their next message. */
  changedBots: string[];
  problems: ConfigProblem[];
}

/** Where the config comes from. */
export interface ConfigDirs {
  defaultsDir: string;
  userDir: string;
}

/**
 * The live config: bots and groups (as `Store` parts), the tool catalog, the permission settings and the limits.
 * Readers see the current snapshot at call time; a reload swaps the snapshot in one assignment.
 */
export class FileConfig {
  private snapshot: ConfigSnapshot;

  private constructor(
    private readonly dirs: ConfigDirs,
    snapshot: ConfigSnapshot,
  ) {
    this.snapshot = snapshot;
  }

  /** Read the config once; `problems` lists the files that were skipped. */
  static load(dirs: ConfigDirs): { config: FileConfig; problems: ConfigProblem[] } {
    const { snapshot, problems } = loadConfig(dirs);
    return { config: new FileConfig(dirs, snapshot), problems };
  }

  /** Bots of the current snapshot. */
  readonly bots: Store["bots"] = {
    get: async (id) => this.snapshot.bots.get(id),
    list: async () => [...this.snapshot.bots.values()],
  };

  /** Groups of the current snapshot. */
  readonly groups: Store["groups"] = {
    get: async (id) => this.snapshot.groups.get(id),
  };

  /** The tools and their annotations. */
  readonly catalog: ToolCatalog = { list: async () => this.snapshot.tools };

  /** Current permission settings (read at every call by the permission gate). */
  settings = (): PermissionSettings => this.snapshot.settings;

  /** Current limits. */
  limits = (): CoreLimits => this.snapshot.limits;

  /** Read the config again. A failure of the whole load keeps the last good snapshot and is reported as a problem. */
  reload(): ReloadResult {
    try {
      const { snapshot, problems } = loadConfig(this.dirs);
      const changedBots = diffBots(this.snapshot.bots, snapshot.bots);
      this.snapshot = snapshot;
      return { changedBots, problems };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        changedBots: [],
        problems: [{ file: this.dirs.userDir, message: message.slice(0, 300) }],
      };
    }
  }

  /**
   * Reload when files under the user dir change; a burst of events inside `debounceMs` is one reload.
   * Returns the function that stops watching.
   */
  watch(onReload: (r: ReloadResult) => void, debounceMs = 300): () => void {
    mkdirSync(this.dirs.userDir, { recursive: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(this.dirs.userDir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => onReload(this.reload()), debounceMs);
    });
    return () => {
      clearTimeout(timer);
      watcher.close();
    };
  }
}
