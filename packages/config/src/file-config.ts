import { mkdirSync, watch } from "node:fs";
import type { CoreLimits, Group, PermissionSettings, Store, ToolCatalog } from "@friday/core";
import { diffBots } from "./diff-bots";
import { type ConfigProblem, type ConfigSnapshot, loadConfig } from "./load-config";
import { expandServer, type McpServerSpec } from "./schemas/mcp-file";

/** What a reload found. */
export interface ReloadResult {
  /** Bots that were removed or edited: give them a fresh session on their next message. */
  changedBots: string[];
  /** Files that could not be used (a kept last-good copy still serves a half-written bot, group or settings file). */
  problems: ConfigProblem[];
}

/** Where the config comes from. */
export interface ConfigDirs {
  /** Defaults shipped with the repo. */
  defaultsDir: string;
  /** The user's config dir; its files win. */
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
    /** Last good parse of each file (a half-written file keeps it). */
    private parsed: Map<string, unknown>,
  ) {
    this.snapshot = snapshot;
  }

  /** Read the config once; `problems` lists the files that were skipped. */
  static load(dirs: ConfigDirs): { config: FileConfig; problems: ConfigProblem[] } {
    const { snapshot, problems, parsed } = loadConfig(dirs);
    return { config: new FileConfig(dirs, snapshot, parsed), problems };
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

  /** Every group of the current snapshot (the channel sync needs the list). */
  listGroups = async (): Promise<Group[]> => [...this.snapshot.groups.values()];

  /** Ids of the groups `botId` is a member of (sync: read when a session opens). */
  groupIdsOf = (botId: string): string[] =>
    [...this.snapshot.groups.values()].filter((g) => g.members.includes(botId)).map((g) => g.id);

  /** Id, name and title of every bot of the current snapshot. */
  botSummaries = (): { id: string; name: string; title: string }[] =>
    [...this.snapshot.bots.values()].map((b) => ({ id: b.id, name: b.name, title: b.title }));

  /** Id, name and members of every group of the current snapshot. */
  groupSummaries = (): { id: string; name: string; members: string[] }[] =>
    [...this.snapshot.groups.values()].map((g) => ({ id: g.id, name: g.name, members: g.members }));

  /** Names of every tool in the catalog. */
  toolNames = (): string[] => this.snapshot.tools.map((t) => t.name);

  /** Names of the configured MCP servers (shipped and the owner's). */
  mcpNames = (): string[] => [...this.snapshot.mcp.keys()];

  /** True when a bot other than `exceptId` already uses `name` (any case). */
  nameTaken = (name: string, exceptId: string): boolean =>
    [...this.snapshot.bots.values()].some(
      (b) => b.id !== exceptId && b.name.toLowerCase() === name.toLowerCase(),
    );

  /** The tools and their annotations. */
  readonly catalog: ToolCatalog = { list: async () => this.snapshot.tools };

  /** Current permission settings (read at every call by the permission gate). */
  settings = (): PermissionSettings => this.snapshot.settings;

  /** Current limits. */
  limits = (): CoreLimits => this.snapshot.limits;

  /** Where `CreateProject` makes new repos. */
  projectsDir = (): string => this.snapshot.projectsDir;

  /**
   * External MCP servers with `${NAME}` values filled from `env`. A server with a missing value is left out and
   * named in `problems`, so it is never started half configured.
   */
  mcpServers(env: Record<string, string | undefined>): {
    servers: Record<string, McpServerSpec>;
    problems: ConfigProblem[];
  } {
    const servers: Record<string, McpServerSpec> = {};
    const problems: ConfigProblem[] = [];
    for (const [name, { server, file }] of this.snapshot.mcp) {
      const r = expandServer(server, env);
      if ("server" in r) servers[name] = r.server;
      else problems.push({ file, message: `server "${name}" needs ${r.missing.join(", ")}` });
    }
    return { servers, problems };
  }

  /** Read the config again. A failure of the whole load keeps the last good snapshot and is reported as a problem. */
  reload(): ReloadResult {
    try {
      const { snapshot, problems, parsed } = loadConfig(this.dirs, this.parsed);
      const changedBots = diffBots(this.snapshot.bots, snapshot.bots);
      this.snapshot = snapshot;
      this.parsed = parsed;
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
