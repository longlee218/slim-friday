import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { isWorkspaceName, workspacePaths } from "../config/workspace-paths";
import { isInside } from "../guardrails/paths";
import { isRealDir, type Location, loadLocations, real } from "../locations/location-registry";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { checkChannels, dropDuplicateChannels } from "./channel-checks";

/** One channel of a workspace: `mode` task (default) or chat; `locations` limits the location names it may use. */
export interface WorkspaceChannel {
  id: string;
  name: string;
  mode: "task" | "chat";
  locations?: string[];
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
  /** The same channels with their name, mode and allowed locations (a legacy plain id gets the defaults). */
  channelDefs: WorkspaceChannel[];
  /** Valid locations of the workspace. */
  locations: Location[];
}

/** Result of a scan: loaded workspaces plus pre-Step-B per-location dirs that were found but never loaded. */
export interface WorkspaceScan {
  workspaces: Workspace[];
  /** Names of legacy dirs (`config.yaml` and no `workspace.yaml`): a migration is needed. */
  legacy: string[];
  /** Workspaces with a pre-v7 `repos/<n>/repo.yaml` (not yet migrated to `locations:`): never loaded silently. */
  needsMigration: string[];
}

/** Discord snowflake. */
const SNOWFLAKE = /^\d{17,20}$/;

/** A channel entry: a plain id (legacy) or `{id, name, mode, locations?}`. */
const channelSchema = z.union([
  z.string().regex(SNOWFLAKE),
  z.object({
    id: z.string().regex(SNOWFLAKE),
    name: z.string().trim().min(1),
    mode: z.enum(["task", "chat"]).default("task"),
    locations: z.array(z.string()).optional(),
  }),
]);

/** Schema of `workspace.yaml`: no `default` key; `locations` entries are validated one by one by the location registry. */
const workspaceSchema = z.object({
  description: z.string().trim().optional(),
  channels: z.array(channelSchema).default([]),
  locations: z.array(z.unknown()).default([]),
  /** Read by src/runtime/skills-config.ts: kept here so the key stays valid. */
  skills: z.object({ extra: z.unknown().optional() }).passthrough().optional(),
});

/** True when `ws` still has a pre-v7 `repos/<n>/repo.yaml` (the owner must run the migration). */
function hasLegacyRepos(wsRoot: string): boolean {
  const dir = join(wsRoot, "repos");
  try {
    return readdirSync(dir).some((n) => existsSync(join(dir, n, "repo.yaml")));
  } catch {
    return false; // no repos dir
  }
}

/** Warn (not skip) when location paths of different workspaces are equal or nested. */
function warnOverlap(workspaces: Workspace[]): void {
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
 * Scan `AGENT_HOME/workspaces/*`. A dir counts as a workspace when it is a real dir (not a symlink) with a
 * valid name and a valid `workspace.yaml`; anything else is warned about and skipped (fail closed).
 * Locations must be real directories that do not cover `userHome` (the owner's $HOME) or AGENT_HOME.
 */
export function loadWorkspaces(agentHome: string, userHome = homedir()): WorkspaceScan {
  const log = logger.child({ module: "workspace-registry" });
  const paths = workspacePaths(agentHome);
  const out: WorkspaceScan = { workspaces: [], legacy: [], needsMigration: [] };
  let names: string[] = [];
  try {
    names = readdirSync(paths.workspaces).sort();
  } catch {
    return out; // no workspaces dir yet
  }
  // $HOME env can differ from os.homedir() / userHome: forbid both.
  const forbidden = [userHome, agentHome, ...(process.env.HOME ? [process.env.HOME] : [])];
  for (const name of names) {
    const ws = paths.workspace(name);
    if (!isRealDir(ws.root)) continue;
    if (!existsSync(ws.config)) {
      if (existsSync(ws.legacyConfig)) out.legacy.push(name); // old layout: listed, never loaded
      continue;
    }
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
      const { description = "", channels, locations } = parsed.data;
      if (hasLegacyRepos(ws.root)) out.needsMigration.push(name);
      const locs = loadLocations(locations, ws, forbidden);
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
      });
    } catch (err) {
      log.warn({ name, err: errText(err) }, "skipped workspace: workspace.yaml unreadable");
    }
  }
  dropDuplicateChannels(out.workspaces);
  warnOverlap(out.workspaces);
  return out;
}
