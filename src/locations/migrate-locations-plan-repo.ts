import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { RepoMove } from "./migrate-locations";
import type { LegacyRepo } from "./migrate-locations-legacy";
import { DROPPED_FIELDS, legacyRepoSchema } from "./migrate-locations-legacy";

/** True when `p` equals `dir` or lies inside it. */
function isInside(dir: string, p: string): boolean {
  const rel = relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Prefix of a `repos/<n>` entry that is not a repo (no repo.yaml): a note, not a skip. */
export const NOTE = "note:";

/** Plan one `repos/<n>` entry; returns the move, a skip reason, or a `note:`-prefixed message. */
export function planRepo(wsRoot: string, name: string): RepoMove | string {
  const from = join(wsRoot, "repos", name);
  if (lstatSync(from).isSymbolicLink()) return `repos/${name}: symlink, refused`;
  if (!lstatSync(from).isDirectory()) return `repos/${name}: not a directory`;
  const yamlFile = join(from, "repo.yaml");
  if (!existsSync(yamlFile)) return `${NOTE}repos/${name}: no repo.yaml, left in place`;
  const to = join(wsRoot, "locations", name);
  if (existsSync(to)) return `repos/${name}: locations/${name} already exists`;
  let cfg: LegacyRepo;
  try {
    cfg = legacyRepoSchema.parse(Bun.YAML.parse(readFileSync(yamlFile, "utf8")) ?? {});
  } catch (err) {
    return `repos/${name}: invalid repo.yaml (${(err as Error).message.split("\n")[0]})`;
  }
  // Absolute path as is; relative path is relative to `repos/<n>/`; default is the managed clone `repos/<n>/repo`.
  const old = cfg.path ? resolve(from, cfg.path) : join(from, "repo");
  const inside = isInside(from, old);
  const dropped = DROPPED_FIELDS.filter((f) => cfg[f] !== undefined).map(
    (f) => `${f}: ${JSON.stringify(cfg[f])}`,
  );
  return {
    name,
    from,
    to,
    path: inside ? join(to, relative(from, old)) : old,
    description: cfg.description,
    insideOld: inside ? old : undefined,
    dropped,
  };
}
