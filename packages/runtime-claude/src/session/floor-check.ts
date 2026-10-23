import { isAbsolute, relative, resolve } from "node:path";
import { isDeniedPath, isInside, realOrSame } from "../floor/paths";
import { isSensitivePath } from "../floor/sensitive-files";

/** Tools that only read a path. */
const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
/** Tools that write a path. */
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
/** Input keys that hold the target path, in the order the SDK tools use them. */
const PATH_KEYS = ["file_path", "notebook_path", "path"];

/** What the floor needs to know about a bot's run. */
export interface FloorContext {
  /** Dirs the bot may write. */
  writePaths: string[];
  /** Dirs the bot may read (writable dirs are readable too). */
  readPaths: string[];
  /** The agent's own home: never readable or writable by a bot. */
  agentHome: string;
  /** Working directory; relative tool paths resolve against it. */
  cwd: string;
  /** Dirs under `agentHome` that stay reachable (the bot's own scratch dir). */
  allowInside: string[];
}

/**
 * The hard floor for file tools: a deny reason, or `undefined` when the floor has no objection.
 * The floor runs BEFORE the permission decision, so no approval can unlock a path it denies:
 * outside the bot's dirs, inside the agent home, or a sensitive file (keys, .env...).
 * Bash is bounded by the OS sandbox and MCP tools by the permission decision, so they pass here.
 */
export function floorCheck(
  call: { tool: string; input: Record<string, unknown> },
  ctx: FloorContext,
): string | undefined {
  const writes = WRITE_TOOLS.has(call.tool);
  if (!writes && !READ_TOOLS.has(call.tool)) return undefined;
  const raw = PATH_KEYS.map((k) => call.input[k]).find((v) => typeof v === "string") as
    | string
    | undefined;
  // No path: Glob and Grep search the cwd; any other call without a path is the SDK's to reject.
  if (!raw) return undefined;
  const target = realOrSame(isAbsolute(raw) ? raw : resolve(ctx.cwd, raw));
  if (isDeniedPath(target, [realOrSame(ctx.agentHome)], ctx.allowInside.map(realOrSame)))
    return `${call.tool} denied: the agent home is off limits`;
  const roots = (writes ? ctx.writePaths : [...ctx.readPaths, ...ctx.writePaths]).map(realOrSame);
  const root = roots.find((r) => isInside(r, target));
  if (!root) return `${call.tool} denied: ${raw} is outside the bot's directories`;
  if (isSensitivePath(relative(root, target)))
    return `${call.tool} denied: ${raw} is a sensitive file`;
  return undefined;
}
