import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { LOCATION_NAME, type WorkspacePaths } from "../config/workspace-paths";
import { isInside } from "../guardrails/paths";
import { logger } from "../observability/logger";

/** One registered location (a directory, git or not) the agent may work in or answer questions about. */
export interface Location {
  /** Location name (unique inside its workspace; the `location:` pin and the memory dir name). */
  name: string;
  /** Name of the workspace that owns the location. */
  workspace: string;
  /** Absolute path of the directory the agent works in. */
  path: string;
  /** One-line hint the agent uses to pick the location. */
  description: string;
  /** True when `path` holds a `.git` (computed at load, never configured): a dev run delivers through git only then. */
  git: boolean;
}

/** Paths of one workspace (`workspacePaths(home).workspace(name)`). */
export type WorkspaceDirs = ReturnType<WorkspacePaths["workspace"]>;

/** One `locations:` entry of `workspace.yaml`: exactly these three keys, no legacy keys accepted. */
export const locationEntrySchema = z
  .object({
    name: z.string().trim(),
    path: z.string().trim().min(1),
    description: z.string().trim().default(""),
  })
  .strict();

/** True when `dir` holds a `.git` (dir or worktree file): the one definition of `Location.git`. */
export const isGitLocation = (dir: string): boolean => existsSync(join(dir, ".git"));

/** Real path, or the input when it does not resolve (the one shared helper). */
export const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** True when `p` is a real directory (a symlink to one does not count). */
export function isRealDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Locations of one workspace from its raw `locations:` entries. An entry with a bad shape or name, a path that
 * is missing or not a directory, a path that is/contains one of `forbidden` (the owner's $HOME, AGENT_HOME) or
 * a name already taken is logged and skipped. A path EQUAL to one of `userHomes` is the exception: the owner may
 * register their whole home (AGENT_HOME inside it stays off-limits through the guard); strict ancestors of it
 * (`/`, `/Users`) stay rejected. Relative paths resolve against the workspace dir. Returns [] when there is none.
 */
export function loadLocations(
  entries: unknown[],
  ws: WorkspaceDirs,
  forbidden: string[] = [],
  userHomes: string[] = [],
): Location[] {
  const wsName = basename(ws.root);
  const wsRoot = ws.root;
  const agentHome = dirname(dirname(wsRoot));
  const log = logger.child({ module: "location-registry" });
  const out: Location[] = [];
  for (const raw of entries) {
    const parsed = locationEntrySchema.safeParse(raw);
    if (!parsed.success || !LOCATION_NAME.test(parsed.data.name)) {
      log.warn({ workspace: wsName }, "skipped location: invalid entry or bad name");
      continue;
    }
    const { name, description } = parsed.data;
    const path = resolve(wsRoot, parsed.data.path);
    if (out.some((l) => l.name === name)) {
      log.warn({ workspace: wsName, location: name }, "skipped location: duplicate name");
      continue;
    }
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      // missing path: handled below
    }
    if (!isDir) {
      log.warn({ workspace: wsName, location: name }, "skipped location: path is not a directory");
      continue;
    }
    const rpath = real(path);
    const isUserHome = userHomes.some((h) => real(h) === rpath);
    if (!isUserHome && forbidden.some((f) => isInside(rpath, real(f)))) {
      log.warn({ workspace: wsName, location: name }, "skipped location: path covers the home dir");
      continue;
    }
    // A location inside AGENT_HOME (db, .env, persona; ws.root = <home>/workspaces/<ws>) would give a dev run write
    // scope over it. Only this workspace's own `locations/` subtree (migrated managed clones) is allowed.
    if (isInside(real(agentHome), rpath) && !isInside(real(join(wsRoot, "locations")), rpath)) {
      log.warn(
        { workspace: wsName, location: name },
        "skipped location: path is inside AGENT_HOME",
      );
      continue;
    }
    out.push({ name, workspace: wsName, path, description, git: isGitLocation(path) });
  }
  return out;
}

/** Prompt block listing the locations of workspace `ws` (only useful with 2+ locations). */
export function buildLocationsContext(ws: string, locations: Location[], force = false): string {
  if (locations.length < 2 && !force) return "";
  const lines = locations.map(
    (l) =>
      `- ${l.name}: ${l.path}${l.git ? " [git]" : ""}${l.description ? ` — ${l.description}` : ""}`,
  );
  return `Available locations in workspace ${ws} (pick the one that fits the question; search only these paths):\n${lines.join("\n")}`;
}
