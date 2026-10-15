/**
 * File-tool guardrails (pure functions, no SDK, no Discord).
 *
 * Writes must land inside an allowed directory; reads must not touch secret files.
 * Paths are resolved with realpath of the nearest existing ancestor, so `..` segments
 * and symlinks cannot escape. Bash parsing is best effort (see bash-policy.ts).
 */
import { basename, isAbsolute, resolve } from "node:path";
import { GLOB_TOOL_NAME, GREP_TOOL_NAME, NOTEBOOK_EDIT_TOOL_NAME } from "../tools/sdk-tool-names";
import type { Decision, GuardrailContext } from "./check-tool-call";
import { isDeniedPath, isInside, resolveReal } from "./paths";
import { foldName } from "./protected-names";
import { COVERS_PROTECTED_REASON, searchRootDenied } from "./protected-paths";

/** Folded (lower case, NFC) basename patterns of files that may hold secrets (.env*, keys, credentials). */
const SECRET_PATTERNS = [
  /^\.env/,
  /\.pem$/,
  /\.key$/,
  /^id_(rsa|ed25519|ecdsa|dsa)/,
  /^credentials/,
  /^\.credentials/,
  /^\.(npmrc|netrc|pgpass|git-credentials)$/,
  /\.(p12|pfx)$/,
];

/** Reason of the default allow (read-only access); logs omit it as the unremarkable case. */
export const READ_ONLY_REASON = "read-only access";

/** True when the basename of `p` looks like a secret file (any case, unicode normalized). */
export function isSecretPath(p: string): boolean {
  const name = foldName(basename(p.replace(/[\\/]+$/, "")));
  return SECRET_PATTERNS.some((re) => re.test(name));
}

/** Reason of a path under `ctx.denyPaths` (AGENT_HOME): never echoes the path. */
export const DENIED_PATH_REASON = "access to the agent home is blocked";

/**
 * True when the real path of `value` (relative ones against `ctx.cwd`) is inside `ctx.denyPaths` and outside
 * `ctx.allowInside`. An unresolvable path is not denied here (the tool fails on it; write/read checks still apply).
 */
export function touchesDeniedPath(
  value: string,
  ctx?: Pick<GuardrailContext, "denyPaths" | "allowInside" | "cwd">,
): boolean {
  if (!ctx?.denyPaths?.length) return false;
  const abs = isAbsolute(value) ? value : ctx.cwd ? resolve(ctx.cwd, value) : undefined;
  if (!abs) return false;
  try {
    return isDeniedPath(resolveReal(abs), ctx.denyPaths, ctx.allowInside);
  } catch {
    return false;
  }
}

/** Write/Edit/MultiEdit/NotebookEdit: allow only inside `allowedPaths` (and outside the denied dirs), else deny. */
export function checkFileWrite(
  toolName: string,
  input: Record<string, unknown>,
  allowedPaths: string[],
  ctx?: GuardrailContext,
): Decision {
  const key = toolName === NOTEBOOK_EDIT_TOOL_NAME ? "notebook_path" : "file_path";
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
  if (isDeniedPath(target, ctx?.denyPaths ?? [], ctx?.allowInside))
    return { decision: "deny", reason: DENIED_PATH_REASON };
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
  LSP: ["file_path", "filePath"], // input shape not in the SDK types: both spellings checked
};

/** True when a read target stays inside `roots` (real paths; symlinks and `..` resolved). */
function withinReadPaths(key: string, value: string, roots: string[], cwd?: string): boolean {
  // Glob patterns / globs: no absolute, home or parent-escaping patterns.
  if (key === "pattern" || key === "glob") {
    return !(isAbsolute(value) || value.startsWith("~") || value.split(/[\\/]/).includes(".."));
  }
  if (!isAbsolute(value) && (value.split(/[\\/]/).includes("..") || !cwd)) return false;
  // Relative paths resolve against the cwd: a symlink inside a location cannot lead out of the granted dirs.
  let real: string;
  try {
    real = resolveReal(isAbsolute(value) ? value : resolve(cwd as string, value));
  } catch {
    return false;
  }
  return roots.some((r) => isInside(r, real));
}

/** Read/Glob/Grep: deny secret files (by name and by symlink target), else allow. */
export function checkFileRead(
  toolName: string,
  input: Record<string, unknown>,
  readPaths?: string[],
  ctx?: GuardrailContext,
): Decision {
  // Glob/Grep walk a whole tree: a root that contains a protected dir is denied whatever the pattern.
  if (
    (toolName === GLOB_TOOL_NAME || toolName === GREP_TOOL_NAME) &&
    searchRootDenied(input.path, ctx ?? {})
  )
    return { decision: "deny", reason: COVERS_PROTECTED_REASON };
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
    if (key !== "pattern" && key !== "glob" && touchesDeniedPath(value, ctx))
      return { decision: "deny", reason: DENIED_PATH_REASON };
    if (readPaths && !withinReadPaths(key, value, readPaths, ctx?.cwd)) {
      return { decision: "deny", reason: "read outside the allowed directories is blocked" };
    }
  }
  return { decision: "allow", reason: READ_ONLY_REASON };
}
