import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { SECRET_HOME } from "../config/sensitive-paths";
import { LOCATION_NAME, workspacePaths } from "../config/workspace-paths";
import { isGitLocation, locationPathError, real } from "../locations/location-registry";
import { isInside, realOrSame } from "../policy/paths";
import { findSensitiveScan } from "../runtime/sensitive-files";
import { describeDir } from "./location-description";
import { homeGuards, loadWorkspaces } from "./workspace-registry";

/** A directory that passed every rule and can be registered; nothing is written yet. */
export interface LocationCandidate {
  ok: true;
  /** Real path (symlinks resolved now): this is what lands in yaml, so a later symlink swap cannot redirect it. */
  realPath: string;
  /** Location name to write (slug of the dir name, suffixed on a collision); the existing name when `existing`. */
  name: string;
  /** README H1, cleaned (untrusted text, DATA), or the dir name. */
  description: string;
  git: boolean;
  /** Sensitive files / dirs inside (the sandbox denies them at run time anyway; shown to the owner). Bounded search. */
  sensitive: string[];
  /** True when the sensitive-file search hit its entry cap: the list may be incomplete ("search incomplete"). */
  sensitiveTruncated: boolean;
  /** Name of the entry of this space that already holds this real path (nothing to add, only to link). */
  existing?: string;
  /** `space/name` of locations of OTHER spaces that equal or nest this path (allowed, shown as a warning). */
  otherSpaces: string[];
}

/** Why a path cannot be registered. */
export interface LocationRefusal {
  ok: false;
  reason: string;
}

/** Longest raw path accepted. */
const MAX_PATH_CHARS = 1024;
/** Highest `-N` suffix tried on a name collision. */
const MAX_SUFFIX = 9;

/** Dir name -> valid location name: invalid chars become `-`, leading non-alphanumerics dropped, cut to 64. */
function slugName(dirName: string): string {
  const slug = dirName
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64);
  return LOCATION_NAME.test(slug) ? slug : "location";
}

/** `base`, else `base-2`..`base-9` (base cut so the suffix fits 64 chars): the first name not in `taken`, or undefined. */
function freeName(base: string, taken: string[]): string | undefined {
  // Case-insensitive: on a case-insensitive FS (macOS) `Shop` and `shop` are one memory dir.
  const used = new Set(taken.map((t) => t.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; n <= MAX_SUFFIX; n++) {
    const name = `${base.slice(0, 62)}-${n}`;
    if (!used.has(name.toLowerCase())) return name;
  }
  return undefined;
}

/** Names of ALL raw `locations:` entries of workspace.yaml, including entries the registry skipped (stale path, bad shape). */
function rawLocationNames(config: string): string[] {
  try {
    const data = (Bun.YAML.parse(readFileSync(config, "utf8")) ?? {}) as { locations?: unknown };
    if (!Array.isArray(data.locations)) return [];
    return data.locations.flatMap((e) =>
      typeof (e as { name?: unknown })?.name === "string" ? [(e as { name: string }).name] : [],
    );
  } catch {
    return [];
  }
}

/**
 * Check `rawPath` as a location of `space` and gather what the owner needs to decide. No side effect. Refuses: not absolute
 * (a leading `~/` expands to `userHome`), NUL, too long, missing / not a directory / dangling symlink, the shared load rules
 * (`locationPathError`: covers $HOME or AGENT_HOME, inside AGENT_HOME), and a credential dir (`SECRET_HOME`) or anything in it.
 * A path equal to $HOME is allowed (owner decision). Symlinks are resolved first, every check runs on the real path.
 * `opts.sensitive: false` skips the (slow, bounded) sensitive-file search: path checks only, for the re-check under the lock.
 * A name is free only against loaded AND raw yaml entries, case-insensitively.
 */
export function inspectLocation(
  home: string,
  space: string,
  rawPath: string,
  userHome: string = homedir(),
  opts: { sensitive?: boolean } = {},
): LocationCandidate | LocationRefusal {
  const refuse = (reason: string): LocationRefusal => ({ ok: false, reason });
  if (rawPath.length > MAX_PATH_CHARS || rawPath.includes("\0")) return refuse("invalid path");
  const expanded =
    rawPath === "~"
      ? userHome
      : rawPath.startsWith("~/")
        ? join(userHome, rawPath.slice(2))
        : rawPath;
  if (!isAbsolute(expanded)) return refuse("path must be absolute");
  let realPath: string;
  try {
    realPath = realpathSync(resolve(expanded));
    if (!statSync(realPath).isDirectory()) return refuse("path is not a directory");
  } catch {
    return refuse("path does not exist or cannot be resolved");
  }
  const scan = loadWorkspaces(home, userHome);
  const ws = scan.workspaces.find((w) => w.name === space);
  if (!ws) return refuse(`space not found: ${space}`);
  const { userHomes, forbidden } = homeGuards(home, userHome);
  const problem = locationPathError(realPath, ws.root, forbidden, userHomes);
  if (problem) return refuse(problem);
  const secret = [
    ...new Set(userHomes.flatMap((h) => SECRET_HOME.map((n) => realOrSame(join(h, n))))),
  ];
  if (secret.some((c) => isInside(c, realPath))) return refuse("credential directory");

  const existing = ws.locations.find((l) => real(l.path) === realPath)?.name;
  const name =
    existing ??
    freeName(slugName(basename(realPath)), [
      ...ws.locations.map((l) => l.name),
      ...rawLocationNames(workspacePaths(home).workspace(space).config),
    ]);
  if (!name) return refuse("no free location name");
  const otherSpaces = scan.workspaces
    .filter((w) => w.name !== space)
    .flatMap((w) => w.locations.map((l) => ({ id: `${w.name}/${l.name}`, p: real(l.path) })))
    .filter((o) => isInside(o.p, realPath) || isInside(realPath, o.p))
    .map((o) => o.id);
  return {
    ok: true,
    realPath,
    name,
    description: describeDir(realPath),
    git: isGitLocation(realPath),
    ...(opts.sensitive === false
      ? { sensitive: [], sensitiveTruncated: false }
      : (({ found, truncated }) => ({ sensitive: found, sensitiveTruncated: truncated }))(
          findSensitiveScan(realPath),
        )),
    existing,
    otherSpaces,
  };
}
