/**
 * File-tool guardrails (pure functions, no SDK, no Discord).
 *
 * Writes must land inside an allowed directory; reads must not touch secret files.
 * Paths are resolved with realpath of the nearest existing ancestor, so `..` segments
 * and symlinks cannot escape. Bash parsing is best effort (see bash-policy.ts);
 * the git worktree is the real boundary.
 */
import { basename, isAbsolute, relative } from "node:path";
import { NOTEBOOK_EDIT_TOOL_NAME } from "../tools/sdk-tool-names";
import type { Decision } from "./check-tool-call";
import { isInside, resolveReal } from "./paths";

/** Repo files that execute code or grant permissions when loaded (hooks, MCP, CI, git internals). */
const PROTECTED_WRITE =
  /(^|[\\/])(\.claude|\.husky|\.githooks|\.git|\.github|\.mcp\.json|\.vscode|\.devcontainer)([\\/]|$)/;

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

/** Write/Edit/MultiEdit/NotebookEdit: allow only inside `allowedPaths`, else deny. */
export function checkFileWrite(
  toolName: string,
  input: Record<string, unknown>,
  allowedPaths: string[],
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
  for (const root of allowedPaths) {
    try {
      if (isInside(resolveReal(root), target)) {
        // Files the agent must not plant: they would run code or change permissions later.
        if (PROTECTED_WRITE.test(relative(resolveReal(root), target))) {
          return { decision: "deny", reason: "writing tool/CI config files is blocked" };
        }
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
  return roots.some((r) => isInside(r, real));
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
