import { existsSync, lstatSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { PROJECT_NAME_MAX_CHARS } from "../orchestrator/teammate/teammate-limits";
import { channelOf } from "./task-workspace";
import type { Workspace } from "./workspace-registry";

/* `register_location { create: true }` without a path: the new project goes under the channel's default projects dir
   (`projectsDir` of the channel entry, else of the workspace). The dir is owner-edited config, so it needs no owner
   answer; `createProject` still applies every path guard to the final path. */

/** Most `-N` suffixes tried on a name clash. */
const MAX_SUFFIX = 99;

/** A kebab-case folder name from free text: lowercase a-z0-9 and single dashes, at most PROJECT_NAME_MAX_CHARS. */
export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "") // strip accents: "cờ vua" -> "co vua"
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, PROJECT_NAME_MAX_CHARS)
    .replace(/-+$/, "");
}

/** The configured default dir for `channelId` (channel wins over workspace), raw as written, or undefined. */
export const defaultProjectsDir = (ws: Workspace, channelId: string): string | undefined =>
  channelOf(ws, channelId)?.projectsDir ?? ws.projectsDir;

/** A free project path under `dir`, or a coded refusal. */
export type ProjectPath = { ok: true; path: string } | { ok: false; code: string; reason: string };

/**
 * The target path of a new project: default dir + slug of `name` (else of the request's first words, else "project"),
 * with `-2`, `-3`... on a clash. The dir must exist (checked here, at use time, not at startup).
 */
export function defaultProjectPath(
  rawDir: string,
  userHome: string,
  name: string | undefined,
  request: string,
): ProjectPath {
  const expanded = rawDir === "~" ? userHome : rawDir.replace(/^~\//, `${userHome}/`);
  if (!isAbsolute(expanded) || expanded.includes("\0"))
    return bad(
      `The default projects dir "${rawDir}" is not an absolute or ~/ path: the owner fixes workspace.yaml.`,
    );
  const dir = resolve(expanded);
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    return bad(
      `The default projects dir ${dir} does not exist: the owner creates it or fixes projectsDir in workspace.yaml.`,
    );
  const base =
    slugify(name ?? "") || slugify(request.split(/\s+/).slice(0, 4).join(" ")) || "project";
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const candidate = join(dir, n === 1 ? base : `${base}-${n}`);
    if (!taken(candidate)) return { ok: true, path: candidate };
  }
  return {
    ok: false,
    code: "NAME_TAKEN",
    reason: `Too many folders named ${base} in ${dir}: pick another name.`,
  };
}

const bad = (reason: string): ProjectPath => ({
  ok: false,
  code: "BAD_DEFAULT_PROJECTS_DIR",
  reason,
});

/** True when anything (even a dangling symlink) is at `p`. */
function taken(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
