/**
 * File-tool guardrails (pure functions, no SDK, no Discord).
 *
 * Writes must land inside an allowed directory; reads must not touch secret files.
 * Paths are resolved with realpath of the nearest existing ancestor, so `..` segments
 * and symlinks cannot escape. Bash parsing is best effort (see bash-policy.ts);
 * worktree isolation in phase 4 is the real boundary.
 */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Decision } from "./check-tool-call";

/** Basename patterns of files that may hold secrets (.env*, keys, credentials). */
const SECRET_PATTERNS = [
  /^\.env/,
  /\.pem$/i,
  /\.key$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)/,
  /^credentials/i,
  /^\.credentials/i,
  /^\.(npmrc|netrc|pgpass|git-credentials)$/,
  /\.(p12|pfx)$/i,
];

/** True when the basename of `p` looks like a secret file. */
export function isSecretPath(p: string): boolean {
  const name = basename(p.replace(/[\\/]+$/, ""));
  return SECRET_PATTERNS.some((re) => re.test(name));
}

/** True when something exists at `p` (symlinks are not followed). */
function existsNoFollow(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `p` to a real absolute path. The nearest existing ancestor is realpath'd and the
 * missing tail is appended, so not-yet-created files resolve correctly.
 * Throws on dangling symlinks (could point anywhere) or when no ancestor resolves.
 */
export function resolveReal(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    let real: string | undefined;
    try {
      real = realpathSync(cur);
    } catch {
      real = undefined;
    }
    if (real !== undefined) return join(real, ...tail.reverse());
    if (existsNoFollow(cur)) throw new Error("dangling symlink or unreadable path");
    const parent = dirname(cur);
    if (parent === cur) throw new Error("no existing ancestor");
    tail.push(basename(cur));
    cur = parent;
  }
}

/** True when `target` equals or is nested under `root` (both already real paths). */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Write/Edit/MultiEdit/NotebookEdit: allow only inside `allowedPaths`, else deny. */
export function checkFileWrite(
  toolName: string,
  input: Record<string, unknown>,
  allowedPaths: string[],
): Decision {
  const key = toolName === "NotebookEdit" ? "notebook_path" : "file_path";
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    return { decision: "deny", reason: `${toolName}: missing or invalid ${key}` };
  }
  if (!isAbsolute(value)) {
    return { decision: "deny", reason: `${toolName}: path must be absolute` };
  }
  let target: string;
  try {
    target = resolveReal(value);
  } catch {
    return { decision: "deny", reason: `${toolName}: path cannot be resolved safely` };
  }
  for (const root of allowedPaths) {
    try {
      if (isInside(resolveReal(root), target)) {
        return { decision: "allow", reason: "write inside allowed path" };
      }
    } catch {
      // Unresolvable allowed root grants nothing.
    }
  }
  return { decision: "deny", reason: "write outside allowed paths is blocked" };
}

/** Input keys that can name a file or glob, per read-only tool. Grep `pattern` is a regex: skipped. */
const READ_KEYS: Record<string, string[]> = {
  Read: ["file_path"],
  Glob: ["path", "pattern"],
  Grep: ["path", "glob"],
};

/** True when a read target stays inside `roots` (real paths; symlinks and `..` resolved). */
function withinReadPaths(key: string, value: string, roots: string[]): boolean {
  // Glob patterns / globs: no absolute, home or parent-escaping patterns.
  if (key === "pattern" || key === "glob") {
    return !(isAbsolute(value) || value.startsWith("~") || value.split(/[\\/]/).includes(".."));
  }
  if (!isAbsolute(value)) return !value.split(/[\\/]/).includes(".."); // relative to cwd (scratch)
  const real = resolveReal(value);
  return roots.some((r) => real === r || real.startsWith(r + sep));
}

/** Read/Glob/Grep: deny secret files (by name and by symlink target), else allow. */
export function checkFileRead(
  toolName: string,
  input: Record<string, unknown>,
  readPaths?: string[],
): Decision {
  for (const key of READ_KEYS[toolName] ?? []) {
    const value = input[key];
    if (typeof value !== "string" || value === "") continue;
    let secret = isSecretPath(value);
    if (!secret && key !== "pattern" && key !== "glob") {
      try {
        secret = isSecretPath(resolveReal(value));
      } catch {
        // Unresolvable path: the tool itself will fail; name check already passed.
      }
    }
    if (secret) return { decision: "deny", reason: "access to secret files is blocked" };
    if (readPaths && !withinReadPaths(key, value, readPaths)) {
      return { decision: "deny", reason: "read outside the allowed directories is blocked" };
    }
  }
  return { decision: "allow", reason: "read-only access" };
}
