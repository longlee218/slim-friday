import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../observability/logger";

/** One platform build of a pinned binary (shape of `data/pinned-binaries.yaml`). */
export interface PinnedPlatform {
  /** Path of the file relative to the app root (gitignored). */
  path: string;
  /** Where the reviewed file was downloaded from (install step only; the app never downloads). */
  url: string;
  /** sha256 (hex) of the reviewed file. */
  sha256: string;
  /** Size in bytes of the reviewed file (a cheap first check before hashing). */
  bytes: number;
}

/** One pinned binary: version, the env vars a run gets, one build per platform (`<os>-<arch>`). */
export interface PinnedBinary {
  version: string;
  /** Env var set to the verified file's path. */
  env: string;
  /** Env var set to a per-run dir inside the scratch dir (the tool's own cache/home). Omitted = none. */
  homeEnv?: string;
  platforms: Record<string, PinnedPlatform>;
}

/** The pinned binaries by name (data: a new binary or version is a data change plus a review). */
export const PINNED_BINARIES: Record<string, PinnedBinary> = (
  Bun.YAML.parse(readFileSync(join(import.meta.dir, "data", "pinned-binaries.yaml"), "utf8")) as {
    binaries: Record<string, PinnedBinary>;
  }
).binaries;

/** The app root (paths in the data file are relative to it). */
const APP_ROOT = join(import.meta.dir, "../..");

/** Platform key of this process, as in the data file (`darwin-arm64`, `linux-x64`). */
export const platformKey = (): string => `${process.platform}-${process.arch}`;

/** sha256 (hex) of a file's bytes. */
export const sha256OfFile = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

/** File hashes by `path:size:mtime`, so a run does not re-hash an unchanged file. */
const hashes = new Map<string, string>();

/** A file that is not the reviewed one: warned about, never offered. */
function mismatch(name: string, file: string): undefined {
  logger.warn(
    { module: "pinned-binaries", binary: name, file },
    "pinned binary hash mismatch: not offered",
  );
  return undefined;
}

/** Where to look up a binary (test seams; default: the data file, the app root, this process's platform). */
export interface PinnedLookup {
  binaries?: Record<string, PinnedBinary>;
  root?: string;
  platform?: string;
}

/**
 * Absolute path of a pinned binary for this platform, only when the file exists, is executable, and its size and sha256
 * match the data file. Anything else = undefined (a mismatch is warned about): fail closed.
 */
export function verifiedBinaryPath(name: string, o: PinnedLookup = {}): string | undefined {
  const build = (o.binaries ?? PINNED_BINARIES)[name]?.platforms[o.platform ?? platformKey()];
  if (!build) return undefined;
  const file = join(o.root ?? APP_ROOT, build.path);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(file);
  } catch {
    return undefined; // not installed: the normal case on a fresh clone
  }
  // Not executable = the skill's launcher would skip it and try a download: never offer it.
  if (!st.isFile() || (st.mode & 0o111) === 0) return undefined;
  if (st.size !== build.bytes) return mismatch(name, file);
  const key = `${file}:${st.size}:${st.mtimeMs}`;
  const hash = hashes.get(key) ?? sha256OfFile(file);
  hashes.set(key, hash);
  return hash === build.sha256 ? file : mismatch(name, file);
}

/**
 * Env vars and readable paths of a run's pinned binaries (`RoleDefinition.binaries`): for each verified one, `env` =
 * its path and `homeEnv` = `<scratch>/<name>-home`. Needs the run's scratch dir (a dispatched worker): none = nothing.
 */
export function pinnedBinaryEnv(
  names: readonly string[] | undefined,
  scratchDir: string | undefined,
  o: PinnedLookup = {},
): { env: Record<string, string>; paths: string[] } {
  const env: Record<string, string> = {};
  const paths: string[] = [];
  if (!scratchDir) return { env, paths };
  for (const name of names ?? []) {
    const file = verifiedBinaryPath(name, o);
    const spec = (o.binaries ?? PINNED_BINARIES)[name];
    if (!file || !spec) continue;
    env[spec.env] = file;
    if (spec.homeEnv) env[spec.homeEnv] = join(scratchDir, `${name}-home`);
    paths.push(file);
  }
  return { env, paths };
}
