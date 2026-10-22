import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveReal } from "../policy/paths";

/** Folder of a location where the files a run saves with `SaveArtifact` go (relative to the location root). */
export const REPO_DOCS_DIR = join("docs", "friday");

/** A location: its name and directory. */
export interface DocsLocation {
  name: string;
  path: string;
}

/**
 * The location a run's saved files go to: its granted location, else the channel's only location; undefined = AGENT_HOME
 * store (no location, several and none granted, or a `$HOME` location, whose `docs/` is not a project's).
 */
export function repoDocsTarget(
  granted: DocsLocation | undefined,
  locations: DocsLocation[],
): DocsLocation | undefined {
  const target = granted ?? (locations.length === 1 ? locations[0] : undefined);
  if (!target) return undefined;
  try {
    return realpathSync(target.path) === realpathSync(homedir()) ? undefined : target;
  } catch {
    return undefined; // a location dir that is gone: keep the file in the store
  }
}

/**
 * Root a store artifact's file must live under: `<location>/docs/friday` when the row names a location (a file a run
 * saved into its project), else AGENT_HOME. Undefined when the row's location is unknown (never served).
 */
export function storeRootOf(
  home: string,
  location: string | null,
  locationPath: (name: string) => string | undefined,
): string | undefined {
  if (!location) return resolveReal(home);
  const dir = locationPath(location);
  return dir ? resolveReal(join(dir, REPO_DOCS_DIR)) : undefined;
}
