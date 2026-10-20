import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { redactText } from "../observability/redact";
import { isHiddenByAgentHome, isInside, resolveReal } from "../policy/paths";
import { isSensitivePath } from "../runtime/sensitive-files";
import type { ArtifactRow } from "../storage/artifact-store";

/** Where the viewer finds the files an artifact row points to. */
export interface BodyRoots {
  /** AGENT_HOME: a store artifact must live under it. */
  home: string;
  /** Directory of a location of a workspace (undefined = unknown); a repo artifact is read through it. */
  locationPath(workspace: string, name: string): string | undefined;
}

/**
 * The text of an artifact (redacted), or null when it must not be served. The path check runs on EVERY read, as when the
 * row was written: a store file must stay inside AGENT_HOME; a repo file must be relative, stay inside its location after
 * symlinks resolve (and outside AGENT_HOME), not be a sensitive path, and be a regular file. A missing or unreadable file is null too.
 */
export function loadArtifactBody(row: ArtifactRow, roots: BodyRoots): string | null {
  try {
    if (row.origin === "store") {
      const real = resolveReal(row.path);
      if (!isInside(resolveReal(roots.home), real) || !statSync(real).isFile()) return null;
      return redactText(readFileSync(real, "utf8"));
    }
    const dir = row.location ? roots.locationPath(row.workspace, row.location) : undefined;
    if (!dir || isAbsolute(row.path)) return null;
    const root = resolveReal(dir);
    const real = resolveReal(join(root, row.path));
    // Outside the location, or inside AGENT_HOME (a $HOME location contains it): never served.
    if (!isInside(root, real) || isHiddenByAgentHome(roots.home, root, real)) return null;
    if (isSensitivePath(row.path) || isSensitivePath(relative(root, real))) return null;
    if (!statSync(real).isFile()) return null;
    return redactText(readFileSync(real, "utf8"));
  } catch {
    return null;
  }
}
