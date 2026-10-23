import { join } from "node:path";
import { resolveReal } from "../policy/paths";

/** Folder of a location where older builds saved a run's files (relative to the location root); rows of those files still name it. */
export const REPO_DOCS_DIR = join("docs", "friday");

/**
 * Root a store artifact's file must live under: `<location>/docs/friday` when the row names a location (a file an older
 * build saved into its project), else AGENT_HOME. Undefined when the row's location is unknown (never served).
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
