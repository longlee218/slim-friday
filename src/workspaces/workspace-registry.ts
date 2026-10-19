import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { z } from "zod";
import { readProcessEnv } from "../config/process-env";
import { isWorkspaceName, workspacePaths } from "../config/workspace-paths";
import { isRealDir, type Location, loadLocations, real } from "../locations/location-registry";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { isInside } from "../policy/paths";
import { checkChannels, dropDuplicateChannels } from "./channel-checks";

/** One channel of a workspace: `mode` task (default) or chat; `locations` limits the location names it may use. */
export interface WorkspaceChannel {
  id: string;
  name: string;
  mode: "task" | "chat";
  locations?: string[];
  /** Default dir for new projects made from this channel (absolute or `~/...`); wins over the workspace's. */
  projectsDir?: string;
}

/** One workspace: a group of locations behind one set of Discord channels. */
export interface Workspace {
  /** Directory name under `workspaces/` (lowercase-hyphen). */
  name: string;
  /** Absolute path of the workspace directory. */
  root: string;
  /** Free-text hint about what the workspace is for. */
  description: string;
  /** Discord parent-channel ids routed to this workspace (each id belongs to exactly one workspace). */
  channels: string[];
  /** The same channels with their name, mode and allowed locations. */
  channelDefs: WorkspaceChannel[];
  /** Valid locations of the workspace. */
  locations: Location[];
  /** Fallback default dir for new projects (absolute or `~/...`), used by a channel with no `projectsDir`. */
  projectsDir?: string;
}

/** Result of a scan: the loaded workspaces. */
export interface WorkspaceScan {
  workspaces: Workspace[];
}

/** Discord snowflake. */
const SNOWFLAKE = /^\d{17,20}$/;

/** A channel entry: an object `{id, name, mode, locations?}`. */
const channelSchema = z.object({
  id: z.string().regex(SNOWFLAKE),
  name: z.string().trim().min(1),
  mode: z.enum(["task", "chat"]).default("task"),
  locations: z.array(z.string()).optional(),
  projectsDir: z.string().trim().min(1).optional(),
});

/** Schema of `workspace.yaml`: no `default` key; `locations` entries are validated one by one by the location registry. */
const workspaceSchema = z.object({
  description: z.string().trim().optional(),
  channels: z.array(channelSchema).default([]),
  locations: z.array(z.unknown()).default([]),
  projectsDir: z.string().trim().min(1).optional(),
  /** Read by src/runtime/skills-config.ts: kept here so the key stays valid. */
  skills: z.object({ extra: z.unknown().optional() }).passthrough().optional(),
});

/**
 * Warn (not skip) when location paths of different workspaces are equal or nested. Called once at startup (index.ts),
 * not by `loadWorkspaces`: the registry is re-scanned on every message and the warning would repeat each time.
 */
export function warnOverlap(workspaces: Workspace[]): void {
  const all = workspaces.flatMap((w) => w.locations.map((r) => ({ r, p: real(r.path) })));
  for (const [i, a] of all.entries()) {
    for (const b of all.slice(i + 1)) {
      if (a.r.workspace === b.r.workspace || !(isInside(a.p, b.p) || isInside(b.p, a.p))) continue;
      const fields = { a: `${a.r.workspace}/${a.r.name}`, b: `${b.r.workspace}/${b.r.name}` };
      logEvent(logger.child({ module: "workspace-registry" }), "location.overlap", fields, "warn");
    }
  }
}

/**
 * The owner's home dirs (`userHome` and env `$HOME`, which can differ) and the paths no location may cover (those homes +
 * AGENT_HOME). Shared by `loadWorkspaces` and the register flow so both apply the same rules.
 */
export function homeGuards(
  agentHome: string,
  userHome: string,
): { userHomes: string[]; forbidden: string[] } {
  const envHome = readProcessEnv().HOME;
  const userHomes = [userHome, ...(envHome ? [envHome] : [])];
  return { userHomes, forbidden: [...userHomes, agentHome] };
}

/**
 * Scan `AGENT_HOME/workspaces/*`. A dir counts as a workspace when it is a real dir (not a symlink) with a
 * valid name and a valid `workspace.yaml`; anything else is warned about and skipped (fail closed).
 * Locations must be real directories that do not strictly cover `userHome` (the owner's $HOME) or AGENT_HOME;
 * a location equal to `userHome` is allowed (the guard keeps AGENT_HOME off-limits).
 */
export function loadWorkspaces(agentHome: string, userHome = homedir()): WorkspaceScan {
  const log = logger.child({ module: "workspace-registry" });
  const paths = workspacePaths(agentHome);
  const out: WorkspaceScan = { workspaces: [] };
  let names: string[] = [];
  try {
    names = readdirSync(paths.workspaces).sort();
  } catch {
    return out; // no workspaces dir yet
  }
  const { userHomes, forbidden } = homeGuards(agentHome, userHome);
  for (const name of names) {
    const ws = paths.workspace(name);
    if (!isRealDir(ws.root)) continue;
    if (!existsSync(ws.config)) continue;
    if (!isWorkspaceName(name)) {
      log.warn({ name }, "skipped workspace: bad name");
      continue;
    }
    try {
      const parsed = workspaceSchema.safeParse(
        Bun.YAML.parse(readFileSync(ws.config, "utf8")) ?? {},
      );
      if (!parsed.success) {
        log.warn({ name }, "skipped workspace: invalid workspace.yaml");
        continue;
      }
      const { description = "", channels, locations, projectsDir } = parsed.data;
      const locs = loadLocations(locations, ws, forbidden, userHomes);
      const channelDefs = checkChannels(
        name,
        channels,
        locs.map((l) => l.name),
      );
      out.workspaces.push({
        name,
        root: ws.root,
        description,
        channels: channelDefs.map((c) => c.id),
        channelDefs,
        locations: locs,
        projectsDir,
      });
    } catch (err) {
      log.warn({ name, err: errText(err) }, "skipped workspace: workspace.yaml unreadable");
    }
  }
  dropDuplicateChannels(out.workspaces);
  return out;
}
